// ============================================================================
// Per-sistant — Notification Routes
// ============================================================================

const express = require("express");

const { serverError } = require("../errors");
const { upcomingFacts } = require("./rag");
const { gatherHealthSummary } = require("./health");

// How far ahead to surface a fact's renewal/expiration (days).
const FACT_LOOKAHEAD_DAYS = 30;

// Rent & utilities owed (cross-app, READ-ONLY via the shell-wired perfinPool —
// INV-25/35, never an HTTP self-fetch). Returns a summary only when configured,
// a balance is owed, AND we're within the reminder lead window of the rent due
// day. Fail-soft: any error → null (the caller drops the item).
async function housingDue(perfinPool) {
  if (!perfinPool) return null;
  try {
    const [bal, cfgR] = await Promise.all([
      perfinPool.query("SELECT COALESCE(SUM(amount),0) AS balance, COUNT(*) AS n FROM payee_obligations WHERE status='unpaid'"),
      perfinPool.query("SELECT housing_config FROM user_settings WHERE id = 1"),
    ]);
    let cfg = cfgR.rows[0] && cfgR.rows[0].housing_config;
    if (typeof cfg === "string") { try { cfg = JSON.parse(cfg); } catch { cfg = {}; } }
    cfg = cfg || {};
    const balance = parseFloat(bal.rows[0].balance);
    const n = parseInt(bal.rows[0].n);
    if (!cfg.enabled || !cfg.payee_name || !(balance > 0)) return null;
    const dueDay = parseInt(cfg.rent_due_day, 10);
    const leadDays = Number.isFinite(parseInt(cfg.reminder_lead_days, 10)) ? parseInt(cfg.reminder_lead_days, 10) : 5;
    let daysUntil = null;
    if (dueDay >= 1 && dueDay <= 31) {
      const now = new Date();
      let due = new Date(now.getFullYear(), now.getMonth(), Math.min(dueDay, 28));
      if (due < now) due = new Date(now.getFullYear(), now.getMonth() + 1, Math.min(dueDay, 28));
      daysUntil = Math.round((due - now) / 86400000);
    }
    // Only surface within the lead window (or if no due day is configured).
    if (daysUntil != null && daysUntil > leadDays) return null;
    return { balance, payee: cfg.payee_name, n, days_until_due: daysUntil };
  } catch { return null; }
}

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/notifications/check", async (req, res) => {
    try {
      const today = new Date().toISOString().split("T")[0];
      const perfinPool = req.app.get("perfinPool");
      const [dueSoon, overdue, streaksAtRisk, reminders, facts, health, housing] = await Promise.all([
        pool.query("SELECT id, title, due_date FROM todos WHERE deleted_at IS NULL AND completed = false AND due_date = $1", [today]),
        pool.query("SELECT id, title, due_date FROM todos WHERE deleted_at IS NULL AND completed = false AND due_date < $1", [today]),
        pool.query("SELECT id, title, streak_count, due_date FROM todos WHERE deleted_at IS NULL AND completed = false AND recurring = true AND streak_count >= 3 AND due_date = $1", [today]),
        pool.query("SELECT id, COALESCE(title, LEFT(content,50)) as title, reminder_at FROM notes WHERE deleted_at IS NULL AND reminder_at IS NOT NULL AND DATE(reminder_at) = $1", [today]),
        upcomingFacts(pool, FACT_LOOKAHEAD_DAYS),
        // Fail-soft: a health-tables error degrades to "no habit alerts"
        // rather than 500ing the whole notification check.
        gatherHealthSummary(pool).catch(() => ({ due_today: 0, done_today: 0, streaks_at_risk: [] })),
        // Cross-app rent/utilities (read-only via perfinPool), fail-soft.
        housingDue(perfinPool),
      ]);
      const notifications = [];
      dueSoon.rows.forEach(t => notifications.push({ type: "due_today", title: t.title, id: t.id, entity: "todo" }));
      overdue.rows.forEach(t => notifications.push({ type: "overdue", title: t.title, id: t.id, entity: "todo" }));
      streaksAtRisk.rows.forEach(t => notifications.push({ type: "streak_at_risk", title: `${t.title} (${t.streak_count} streak)`, id: t.id, entity: "todo" }));
      reminders.rows.forEach(n => notifications.push({ type: "reminder", title: n.title, id: n.id, entity: "note" }));
      facts.forEach(f => {
        const on = f.on_date ? new Date(f.on_date).toISOString().slice(0, 10) : "";
        const label = f.kind === "expires" ? "expires" : String(f.kind).replace(/_/g, " ");
        const days = Number(f.days_away);
        notifications.push({
          type: "fact_upcoming",
          title: `${f.entity}: ${label} on ${on}${Number.isFinite(days) ? ` (in ${days} day${days === 1 ? "" : "s"})` : ""}`,
          id: null,
          entity: "fact",
          days_away: Number.isFinite(days) ? days : null,
        });
      });
      // Habit streaks at risk: due today, not yet done, 3+ day streak on the
      // line. Same gatherHealthSummary the Health page and AI briefing use.
      health.streaks_at_risk.forEach(h => notifications.push({
        type: "habit_streak_at_risk",
        title: `${h.name} (${h.current_streak} streak)`,
        id: h.id,
        entity: "habit",
      }));
      // Rent & utilities due (cross-app; non-AI, deterministic).
      if (housing) {
        const due = housing.days_until_due;
        const when = due == null ? "" : (due <= 0 ? " (due now)" : ` (due in ${due} day${due === 1 ? "" : "s"})`);
        notifications.push({
          type: "housing_due",
          title: `Rent & utilities: $${housing.balance.toFixed(2)} owed to ${housing.payee}${when}`,
          id: null,
          entity: "housing",
          days_away: due,
        });
      }
      res.json({
        notifications,
        counts: {
          due_today: dueSoon.rows.length,
          overdue: overdue.rows.length,
          streaks_at_risk: streaksAtRisk.rows.length,
          reminders: reminders.rows.length,
          fact_upcoming: facts.length,
          habits_due: Math.max(health.due_today - health.done_today, 0),
          habit_streaks_at_risk: health.streaks_at_risk.length,
          housing_due: housing ? 1 : 0,
        },
      });
    } catch (err) { serverError(res, err); }
  });

  return router;
};
