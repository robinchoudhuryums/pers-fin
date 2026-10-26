// ============================================================================
// Routes: the dashboard summary (design pass D3 — `.cycle/plan-design-ux.md`,
// decision 5)
// ============================================================================
// GET /api/dashboard/summary answers "am I OK this month?" for the top of the
// dashboard in one request:
//   - net_worth — the latest net_worth_snapshots row (written by getNetWorth)
//     and its change since the first snapshot of this APP_TIMEZONE month;
//   - spending — this month's spend in budgeted categories against their
//     effective limits (getBudgetStatus — rollover and one-time rules included);
//   - cash — the lowest projected cash day over 30 days (getCashFlowForecast);
//   - attention — what needs a look: bills due in the next 7 days (getBillsDue —
//     the forecast's charges + the calendar's manual-bill rule, paid ones left
//     out), rent owed (the ledger's own totals, payee-scoped), transactions to
//     categorize (the categorize status count) and Sync Health warnings
//     (gatherDataHealth's warning issues).
//
// INV-147: every figure comes from the helper its own screen uses — nothing
// here re-derives a number. Each part is fail-soft: a failing read becomes
// { ok: false, error: <fixed sentence> } (an attention source a fixed sentence
// in attention.errors) and is logged once; the others still answer.
//
// gatherDashboardSummary(pool, deps) is the shared entry point (the landing
// page's status line reuses it — design D7); deps injects the readers for tests.

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");

const BILLS_DAYS = 7;
const CASH_DAYS = 30;

const ERRORS = {
  net_worth: "Net worth couldn't be loaded.",
  spending: "This month's budget figures couldn't be loaded.",
  cash: "The cash forecast couldn't be loaded.",
  bills: "Upcoming bills couldn't be checked.",
  rent: "The rent ledger couldn't be checked.",
  uncategorized: "Uncategorized transactions couldn't be counted.",
  sync_health: "Sync Health couldn't be checked.",
};

function defaultDeps() {
  const fq = require("../services/financial-queries");
  return {
    getBudgetStatus: fq.getBudgetStatus,
    currentMonth: fq.currentMonth,
    todayStr: fq.todayStr,
    getCashFlowForecast: require("../services/cash-flow").getCashFlowForecast,
    getBillsDue: require("./subscriptions").getBillsDue,
    getHousingOwed: require("./housing").getHousingOwed,
    countUncategorized: require("./categorize").countUncategorized,
    gatherDataHealth: require("./settings").gatherDataHealth,
  };
}

const cents = (n) => Math.round(Number(n) * 100) / 100;
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

// Runs one reader, turning a throw (sync or async) into null + a logged line.
async function attempt(key, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    console.error("dashboard summary " + key + " failed:", err && err.message);
    return { ok: false };
  }
}

async function readNetWorth(db, monthStart) {
  const [latest, first] = await Promise.all([
    db.query("SELECT net_worth::text AS net_worth, snapshot_date::text AS snapshot_date FROM net_worth_snapshots ORDER BY snapshot_date DESC LIMIT 1"),
    db.query("SELECT net_worth::text AS net_worth, snapshot_date::text AS snapshot_date FROM net_worth_snapshots WHERE snapshot_date >= $1 ORDER BY snapshot_date ASC LIMIT 1", [monthStart]),
  ]);
  const l = latest.rows[0];
  if (!l) return { value: null, as_of: null, change: null, change_since: null };
  const f = first.rows[0];
  const comparable = f && f.snapshot_date < l.snapshot_date;
  return {
    value: cents(l.net_worth),
    as_of: l.snapshot_date,
    change: comparable ? cents(Number(l.net_worth) - Number(f.net_worth)) : null,
    change_since: comparable ? f.snapshot_date : null,
  };
}

function spendingFrom(rows, month) {
  let spent = 0, budget = 0, over = 0;
  for (const b of rows) {
    spent += Number(b.spent) || 0;
    budget += Number(b.effective_limit) || 0;
    if ((Number(b.spent) || 0) > (Number(b.effective_limit) || 0)) over++;
  }
  spent = cents(spent);
  budget = cents(budget);
  return {
    month,
    budget_count: rows.length,
    spent,
    budget,
    percent: budget > 0 ? Math.round((spent / budget) * 100) : null,
    over_count: over,
  };
}

async function gatherDashboardSummary(db = pool, opts = {}) {
  const deps = Object.assign(defaultDeps(), opts.deps || {});
  const today = opts.today || deps.todayStr();
  const month = today.slice(0, 7);

  const [nw, spend, cash, bills, rent, uncat, health] = await Promise.all([
    attempt("net_worth", () => readNetWorth(db, month + "-01")),
    attempt("spending", () => deps.getBudgetStatus(db, month)),
    attempt("cash", () => deps.getCashFlowForecast(db, { days: CASH_DAYS, today })),
    attempt("bills", () => deps.getBillsDue(db, { today, days: BILLS_DAYS })),
    attempt("rent", () => deps.getHousingOwed(db)),
    attempt("uncategorized", () => deps.countUncategorized(db)),
    attempt("sync_health", () => deps.gatherDataHealth(db, { persistentPool: opts.persistentPool || null })),
  ]);

  const out = { today, month };
  out.net_worth = nw.ok ? Object.assign({ ok: true }, nw.value) : { ok: false, error: ERRORS.net_worth };
  out.spending = spend.ok ? Object.assign({ ok: true }, spendingFrom(spend.value || [], month)) : { ok: false, error: ERRORS.spending };
  if (cash.ok) {
    const f = cash.value || {};
    out.cash = {
      ok: true,
      days: CASH_DAYS,
      starting_balance: f.starting_balance == null ? null : cents(f.starting_balance),
      lowest_balance: f.lowest ? cents(f.lowest.balance) : null,
      lowest_date: f.lowest ? f.lowest.date : null,
    };
  } else {
    out.cash = { ok: false, error: ERRORS.cash };
  }

  // Needs attention, in the order the card lists them.
  const items = [];
  const errors = [];
  if (!rent.ok) errors.push({ source: "rent", error: ERRORS.rent });
  else if (rent.value && rent.value.configured && rent.value.balance > 0) {
    items.push({ kind: "rent", text: "Owed to " + rent.value.payee, amount: rent.value.balance, count: rent.value.unpaid_count, href: "/housing" });
  }
  if (!bills.ok) errors.push({ source: "bills", error: ERRORS.bills });
  else if (bills.value && bills.value.length) {
    const total = cents(bills.value.reduce((s, b) => s + (Number(b.amount) || 0), 0));
    items.push({ kind: "bills", text: plural(bills.value.length, "bill", "bills") + " due in the next " + BILLS_DAYS + " days", amount: total, count: bills.value.length, href: "/calendar" });
  }
  if (!uncat.ok) errors.push({ source: "uncategorized", error: ERRORS.uncategorized });
  else if (uncat.value > 0) {
    items.push({ kind: "uncategorized", text: plural(uncat.value, "transaction", "transactions") + " to categorize", count: uncat.value, href: "/dashboard#review-queue-section" });
  }
  if (!health.ok) errors.push({ source: "sync_health", error: ERRORS.sync_health });
  else {
    const warnings = ((health.value && health.value.issues) || []).filter((i) => i.severity === "warning");
    if (warnings.length) {
      items.push({ kind: "sync_health", text: plural(warnings.length, "Sync Health warning", "Sync Health warnings"), count: warnings.length, href: "/settings#sync-health" });
    }
  }
  out.attention = { items, errors };
  return out;
}

// GET /api/dashboard/summary — see the header. A failing read is reported in
// its own field; only an unexpected failure of the whole gather is a 500.
router.get("/api/dashboard/summary", async (req, res) => {
  try {
    res.json(await gatherDashboardSummary(pool, { persistentPool: req.app.get("persistentPool") || null }));
  } catch (err) {
    console.error("dashboard summary error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
module.exports.gatherDashboardSummary = gatherDashboardSummary;
module.exports.spendingFrom = spendingFrom;
module.exports.ERRORS = ERRORS;
module.exports.BILLS_DAYS = BILLS_DAYS;
module.exports.CASH_DAYS = CASH_DAYS;
