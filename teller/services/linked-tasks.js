// Linked tasks — Perfin's side (roadmap T2.4). Perfin owns the facts, so it
// works out which Per-sistant tasks should be open right now; Per-sistant's
// services/linked-tasks.js stores them (X2b wires the two together). Pure
// reads: nothing here writes to either database.
//
// computeLinkedTasks(pool, cfg, today) → { ok_kinds, desired, errors }
//   desired  [{ key, title, description, url, due_date, priority }] — the
//            tasks that should be open, keyed '<app>:<kind>:<id>'
//   ok_kinds the kinds whose source was read this run; only these may close
//            tasks (a failed query must never read as "resolved")
//   errors   [{ kind, error }] — a fixed sentence per failed source
// Each source runs in its own try/catch. cfg = { sources, bill_lead_days }
// (user_settings.linked_tasks_*); a source switched off is not read at all.
// Task shape (decision 6): category finance and a short horizon are set by
// Per-sistant; source_url is a path inside Perfin ('/housing') that the task
// chip joins with Perfin's mount.
const { todayStr } = require("./financial-queries");
const { manualBillOccurrences } = require("./cadence");

const APP = "perfin";
// Settings key → task kind (the second segment of the key).
const SOURCES = {
  still_charging: "still-charging",
  housing: "housing",
  utility_amount: "utility-amount",
  bills: "bill",
};
const SOURCE_KEYS = Object.keys(SOURCES);
// Decision 5: manual bills are off by default — an autopaid bill nobody marks
// paid would leave its task open.
const DEFAULT_SOURCES = { still_charging: true, housing: true, utility_amount: true, bills: false };
const BILL_OVERDUE_DAYS = 30;

const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The stored sources map over the defaults (a missing key keeps its default).
function effectiveSources(raw) {
  const out = { ...DEFAULT_SOURCES };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of SOURCE_KEYS) if (typeof raw[k] === "boolean") out[k] = raw[k];
  }
  return out;
}

// Rent & utilities due: one task per period that has unpaid items, inside the
// payment-due window (housing.rentReminderOpen — the reminder's own rule) or
// overdue; next month's rent once its window opens before its row exists
// (nextRentInLeadWindow, as the reminder does — F43). Payee-scoped.
async function housingTasks(pool, hcfg, today) {
  const housing = require("../routes/housing");
  const r = await pool.query(
    `SELECT period, label, amount FROM payee_obligations
      WHERE status = 'unpaid' AND payee = $1 AND amount IS NOT NULL
      ORDER BY period, category, label`,
    [hcfg.payee_name]
  );
  const byPeriod = new Map();
  for (const row of r.rows) {
    if (!byPeriod.has(row.period)) byPeriod.set(row.period, []);
    byPeriod.get(row.period).push({ label: row.label, amount: parseFloat(row.amount) });
  }
  const next = hcfg.rent_amount > 0 ? housing.nextRentInLeadWindow(hcfg, today) : null;
  if (next && !byPeriod.has(next.period)) {
    const ex = await pool.query(
      `SELECT (EXISTS (SELECT 1 FROM payee_obligations WHERE period = $1 AND category = 'rent')
            OR EXISTS (SELECT 1 FROM payee_obligation_skips WHERE period = $1 AND category = 'rent')) AS has`,
      [next.period]
    );
    if (!(ex.rows[0] && ex.rows[0].has)) byPeriod.set(next.period, [{ label: "Rent", amount: hcfg.rent_amount }]);
  }
  const out = [];
  for (const [period, items] of byPeriod) {
    if (!housing.rentReminderOpen(period, hcfg, today)) continue;
    const due = housing.periodDueDate(period, hcfg.rent_due_day);
    const total = items.reduce((s, i) => s + i.amount, 0);
    const label = housing.periodLabel(period);
    out.push({
      key: `${APP}:housing:${period}`,
      title: clip(`Pay ${hcfg.payee_name} for ${label}`, 300),
      description: clip(`${money(total)} owed: ${items.map((i) => i.label + " " + money(i.amount)).join(", ")}. Record the payment on Perfin's Rent page.`, 2000),
      url: "/housing",
      due_date: due,
      priority: today > due ? "urgent" : "high",
    });
  }
  return out;
}

// A utility bill that should have arrived but has no amount yet (the
// missing-amount reminder's rule, housing.utilityAmountDue). Due on the day
// the bill was due — a fixed date, so the task can show as overdue.
async function utilityAmountTasks(pool, hcfg, today) {
  const housing = require("../routes/housing");
  const r = await pool.query(
    `SELECT id, label, period, due_day FROM payee_obligations
      WHERE status = 'pending_amount' AND payee = $1 ORDER BY period, id`,
    [hcfg.payee_name]
  );
  return r.rows.filter((o) => housing.utilityAmountDue(o, today)).map((o) => ({
    key: `${APP}:utility-amount:${o.id}`,
    title: clip(`Enter the ${o.label} amount for ${housing.periodLabel(o.period)}`, 300),
    description: "The bill should have arrived — add its amount on Perfin's Rent page.",
    url: "/housing#pending",
    due_date: housing.periodDueDate(o.period, o.due_day),
    priority: "medium",
  }));
}

// Manual bills: every occurrence from 30 days ago to `lead` days ahead
// (manualBillOccurrences — the calendar's own placement rule) without a
// bill_payments row for that date.
async function billTasks(pool, leadDays, today) {
  const from = addDays(today, -BILL_OVERDUE_DAYS);
  const to = addDays(today, leadDays);
  const bills = await pool.query(
    "SELECT id, name, amount, due_day, cadence, created_at FROM manual_bills WHERE is_active = true ORDER BY id"
  );
  if (!bills.rows.length) return [];
  const paid = await pool.query(
    `SELECT bill_id, paid_date::text AS paid_date FROM bill_payments
      WHERE bill_source = 'manual' AND paid_date BETWEEN $1 AND $2`,
    [from, to]
  );
  const paidSet = new Set(paid.rows.map((p) => p.bill_id + "|" + p.paid_date));
  const out = [];
  for (const b of bills.rows) {
    for (const date of manualBillOccurrences(b, from, to)) {
      if (paidSet.has(b.id + "|" + date)) continue;
      out.push({
        key: `${APP}:bill:${b.id}:${date}`,
        title: clip(`Pay ${b.name}`, 300),
        description: `${money(parseFloat(b.amount))} due ${date}. Mark it paid on Perfin's bill calendar.`,
        url: "/calendar",
        due_date: date,
        priority: date < today ? "high" : "medium",
      });
    }
  }
  return out;
}

async function computeLinkedTasks(pool, cfg = {}, today = todayStr()) {
  const sources = effectiveSources(cfg.sources);
  const lead = Number.isInteger(cfg.bill_lead_days) && cfg.bill_lead_days >= 0 && cfg.bill_lead_days <= 14 ? cfg.bill_lead_days : 3;
  const result = { ok_kinds: [], desired: [], errors: [] };
  const run = async (key, fn) => {
    if (!sources[key]) return;
    const kind = SOURCES[key];
    try {
      result.desired.push(...(await fn()));
      result.ok_kinds.push(kind);
    } catch (e) {
      console.error(`linked tasks: ${kind} source failed:`, e.message);
      result.errors.push({ kind, error: "Could not read this source." });
    }
  };

  // Housing config read once for both housing sources; a failed read fails both.
  let hcfg = null;
  if (sources.housing || sources.utility_amount) {
    try { hcfg = await require("../routes/housing").getConfig(pool); }
    catch (e) {
      console.error("linked tasks: housing config read failed:", e.message);
      for (const key of ["housing", "utility_amount"]) {
        if (sources[key]) result.errors.push({ kind: SOURCES[key], error: "Could not read the Rent & Utilities settings." });
      }
    }
  }
  const ledgerOn = hcfg && hcfg.enabled && hcfg.payee_name;
  if (hcfg) {
    // A ledger that isn't set up has nothing due — read as resolved.
    await run("housing", () => (ledgerOn ? housingTasks(pool, hcfg, today) : []));
    await run("utility_amount", () => (ledgerOn ? utilityAmountTasks(pool, hcfg, today) : []));
  }
  await run("bills", () => billTasks(pool, lead, today));
  return result;
}

module.exports = { computeLinkedTasks, effectiveSources, SOURCES, SOURCE_KEYS, DEFAULT_SOURCES, APP };
