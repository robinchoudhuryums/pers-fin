// ============================================================================
// Per-sistant — Notification Routes
// ============================================================================

const express = require("express");

const { serverError } = require("../errors");
const { upcomingFacts } = require("./rag");

// How far ahead to surface a fact's renewal/expiration (days).
const FACT_LOOKAHEAD_DAYS = 30;

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/notifications/check", async (req, res) => {
    try {
      const today = new Date().toISOString().split("T")[0];
      const [dueSoon, overdue, streaksAtRisk, reminders, facts] = await Promise.all([
        pool.query("SELECT id, title, due_date FROM todos WHERE deleted_at IS NULL AND completed = false AND due_date = $1", [today]),
        pool.query("SELECT id, title, due_date FROM todos WHERE deleted_at IS NULL AND completed = false AND due_date < $1", [today]),
        pool.query("SELECT id, title, streak_count, due_date FROM todos WHERE deleted_at IS NULL AND completed = false AND recurring = true AND streak_count >= 3 AND due_date = $1", [today]),
        pool.query("SELECT id, COALESCE(title, LEFT(content,50)) as title, reminder_at FROM notes WHERE deleted_at IS NULL AND reminder_at IS NOT NULL AND DATE(reminder_at) = $1", [today]),
        upcomingFacts(pool, FACT_LOOKAHEAD_DAYS),
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
      res.json({
        notifications,
        counts: {
          due_today: dueSoon.rows.length,
          overdue: overdue.rows.length,
          streaks_at_risk: streaksAtRisk.rows.length,
          reminders: reminders.rows.length,
          fact_upcoming: facts.length,
        },
      });
    } catch (err) { serverError(res, err); }
  });

  return router;
};
