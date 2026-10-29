// ============================================================================
// Per-sistant — Rent & utilities due state (cross-app, read-only)
// ============================================================================
// ONE helper shared by the notification check (routes/notifications.js) and
// the AI daily briefing (routes/ai.js) — they each used to carry their own copy
// of the due-date math (PB-2), and both copies were wrong:
//   - `new Date(y, m, day)` is local midnight, so ON the due day `due < now`
//     rolled the due date to next month (~30 days away > the lead window) and
//     the reminder vanished exactly when rent was due;
//   - from then until the next lead window an unpaid, OVERDUE balance produced
//     no notification, and the briefing said "due in 30 days";
//   - the "(due now)" branch was unreachable, the day was clamped to 28, and
//     "today" came from process time rather than APP_TIMEZONE.
// The math is now day-granular on 'YYYY-MM-DD' strings in APP_TIMEZONE (the
// same todayStr Health & Habits uses), clamps the due day to the real month
// length, and reports a past-due balance as OVERDUE.
//
// Reads Perfin's tables READ-ONLY through the shell-wired perfinPool
// (INV-25/35 — never an HTTP self-fetch). Fail-soft: any error → null.
// ============================================================================

const { todayStr } = require("./health");

function daysInMonth(y, m1) {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}

function dayDiff(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// Pure. `today` is 'YYYY-MM-DD'. Returns null when nothing should surface, else
// { balance, payee, n, status: 'upcoming'|'due_today'|'overdue'|'unscheduled',
//   days_until_due (negative when overdue, null when no due day), due_date }.
// `oldest` ({ period: 'YYYY-MM', due_day }) is the oldest UNPAID obligation:
// when it belongs to an earlier month the balance is overdue since THAT due
// date (F110 — from the 1st until this month's lead window, last month's
// unpaid rent used to go silent, since only this month's due date was seen).
function computeHousingDue(cfg, balance, n, today, oldest) {
  if (!cfg || !cfg.enabled || !cfg.payee_name || !(balance > 0)) return null;
  const base = { balance, payee: cfg.payee_name, n };
  const dueDay = parseInt(cfg.rent_due_day, 10);
  const [ty, tm] = today.split("-").map(Number);
  const thisPeriod = `${ty}-${String(tm).padStart(2, "0")}`;
  if (oldest && typeof oldest.period === "string" && /^\d{4}-\d{2}$/.test(oldest.period) && oldest.period < thisPeriod) {
    const [oy, om] = oldest.period.split("-").map(Number);
    const rowDay = parseInt(oldest.due_day, 10);
    const od = rowDay >= 1 && rowDay <= 31 ? rowDay : (dueDay >= 1 && dueDay <= 31 ? dueDay : 1);
    const oDue = `${oldest.period}-${String(Math.min(od, daysInMonth(oy, om))).padStart(2, "0")}`;
    return { ...base, status: "overdue", days_until_due: dayDiff(today, oDue), due_date: oDue };
  }
  if (!(dueDay >= 1 && dueDay <= 31)) {
    return { ...base, status: "unscheduled", days_until_due: null, due_date: null };
  }
  const leadRaw = parseInt(cfg.reminder_lead_days, 10);
  const leadDays = Number.isFinite(leadRaw) ? leadRaw : 5;
  const [y, m] = today.split("-").map(Number);
  const day = Math.min(dueDay, daysInMonth(y, m));
  const dueDate = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const until = dayDiff(today, dueDate);
  if (until < 0) {
    // This month's due day has passed with a balance still owed — overdue,
    // surfaced every day until it's paid (it used to go silent here).
    return { ...base, status: "overdue", days_until_due: until, due_date: dueDate };
  }
  if (until > leadDays) return null;
  return { ...base, status: until === 0 ? "due_today" : "upcoming", days_until_due: until, due_date: dueDate };
}

// " (due today)" / " (due in 3 days)" / " (overdue by 2 days)" / "".
function housingDueSuffix(h) {
  if (!h || h.days_until_due == null) return "";
  const d = h.days_until_due;
  if (d < 0) return ` (overdue by ${-d} day${-d === 1 ? "" : "s"})`;
  if (d === 0) return " (due today)";
  return ` (due in ${d} day${d === 1 ? "" : "s"})`;
}

async function housingDue(perfinPool, today = todayStr()) {
  if (!perfinPool) return null;
  try {
    const cfgR = await perfinPool.query("SELECT housing_config FROM user_settings WHERE id = 1");
    let cfg = cfgR.rows[0] && cfgR.rows[0].housing_config;
    if (typeof cfg === "string") { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
    cfg = cfg || {};
    if (!cfg.enabled || !cfg.payee_name) return null;
    // Scoped to the configured payee, matching Perfin's own payment-due
    // reminder and Rent-page balance.
    // The oldest unpaid row's period + due day ride along (F110).
    const bal = await perfinPool.query(
      `SELECT COALESCE(SUM(amount),0) AS balance, COUNT(*) AS n,
              (SELECT o.period FROM payee_obligations o WHERE o.status='unpaid' AND o.payee = $1
                ORDER BY o.period, o.due_day NULLS LAST LIMIT 1) AS oldest_period,
              (SELECT o.due_day FROM payee_obligations o WHERE o.status='unpaid' AND o.payee = $1
                ORDER BY o.period, o.due_day NULLS LAST LIMIT 1) AS oldest_due_day
         FROM payee_obligations WHERE status='unpaid' AND payee = $1`,
      [cfg.payee_name]
    );
    const row = bal.rows[0];
    const oldest = row.oldest_period ? { period: row.oldest_period, due_day: row.oldest_due_day } : null;
    return computeHousingDue(cfg, parseFloat(row.balance), parseInt(row.n, 10), today, oldest);
  } catch { return null; }
}

// One unpaid rent used to be nudged on up to four surfaces at once (cycle-8
// F23). While Perfin keeps an open Per-sistant task for it (a linked task
// 'perfin:housing:<period>', roadmap T2.4) that task — with its due date and
// overdue state — is the reminder here, so the notification check's
// housing_due entry and the briefing's rent line step aside. Since cycle-8 E3e
// (ST2) the line names its item — the month its due date belongs to (the
// oldest unpaid month when that one is overdue, else this month), the key
// Perfin's rent push and linked task use — and only THAT item's open task
// hides it. Fail-soft: a failed read keeps the line (false).
function housingItem(h, today = todayStr()) {
  if (!h) return null;
  return "housing:" + (h.due_date ? h.due_date.slice(0, 7) : today.slice(0, 7));
}

async function housingTaskOpen(pool, item) {
  if (!pool || !item) return false;
  const { openLinkedItems } = require("../services/linked-tasks");
  return (await openLinkedItems(pool, [item])).has(item);
}

// housingDue with its `item`, or null while that item's linked task is open.
async function housingDueUnlessTask(perfinPool, pool, today = todayStr()) {
  const h = await housingDue(perfinPool, today);
  if (!h) return h;
  const item = housingItem(h, today);
  return (await housingTaskOpen(pool, item)) ? null : { ...h, item };
}

module.exports = { housingDue, housingDueUnlessTask, housingTaskOpen, housingItem, computeHousingDue, housingDueSuffix };
