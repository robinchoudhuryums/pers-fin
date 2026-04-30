// ============================================================================
// Per-sistant — Notification Routes
// ============================================================================

const express = require("express");

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/notifications/check", async (req, res) => {
    try {
      const today = new Date().toISOString().split("T")[0];
      const [dueSoon, overdue, streaksAtRisk, reminders] = await Promise.all([
        pool.query("SELECT id, title, due_date FROM todos WHERE deleted_at IS NULL AND completed = false AND due_date = $1", [today]),
        pool.query("SELECT id, title, due_date FROM todos WHERE deleted_at IS NULL AND completed = false AND due_date < $1", [today]),
        pool.query("SELECT id, title, streak_count, due_date FROM todos WHERE deleted_at IS NULL AND completed = false AND recurring = true AND streak_count >= 3 AND due_date = $1", [today]),
        pool.query("SELECT id, COALESCE(title, LEFT(content,50)) as title, reminder_at FROM notes WHERE deleted_at IS NULL AND reminder_at IS NOT NULL AND DATE(reminder_at) = $1", [today]),
      ]);
      const notifications = [];
      dueSoon.rows.forEach(t => notifications.push({ type: "due_today", title: t.title, id: t.id, entity: "todo" }));
      overdue.rows.forEach(t => notifications.push({ type: "overdue", title: t.title, id: t.id, entity: "todo" }));
      streaksAtRisk.rows.forEach(t => notifications.push({ type: "streak_at_risk", title: `${t.title} (${t.streak_count} streak)`, id: t.id, entity: "todo" }));
      reminders.rows.forEach(n => notifications.push({ type: "reminder", title: n.title, id: n.id, entity: "note" }));
      res.json({ notifications, counts: { due_today: dueSoon.rows.length, overdue: overdue.rows.length, streaks_at_risk: streaksAtRisk.rows.length, reminders: reminders.rows.length } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
