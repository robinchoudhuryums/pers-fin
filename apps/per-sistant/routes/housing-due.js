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
function computeHousingDue(cfg, balance, n, today) {
  if (!cfg || !cfg.enabled || !cfg.payee_name || !(balance > 0)) return null;
  const base = { balance, payee: cfg.payee_name, n };
  const dueDay = parseInt(cfg.rent_due_day, 10);
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
    const bal = await perfinPool.query(
      "SELECT COALESCE(SUM(amount),0) AS balance, COUNT(*) AS n FROM payee_obligations WHERE status='unpaid' AND payee = $1",
      [cfg.payee_name]
    );
    return computeHousingDue(cfg, parseFloat(bal.rows[0].balance), parseInt(bal.rows[0].n, 10), today);
  } catch { return null; }
}

module.exports = { housingDue, computeHousingDue, housingDueSuffix };
