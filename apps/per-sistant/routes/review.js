const express = require("express");

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/review", async (req, res) => {
    try {
      const now = new Date();
      const dayOfWeek = now.getDay();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      weekStart.setHours(0,0,0,0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 7);
      const ws = weekStart.toISOString().split("T")[0];
      const we = weekEnd.toISOString().split("T")[0];
      const [completed, created, sent, notesCreated, upcoming, overdue] = await Promise.all([
        pool.query("SELECT * FROM todos WHERE deleted_at IS NULL AND completed_at >= $1 AND completed_at < $2 ORDER BY completed_at DESC", [ws, we]),
        pool.query("SELECT count(*) as cnt FROM todos WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2", [ws, we]),
        pool.query("SELECT count(*) as cnt FROM emails WHERE deleted_at IS NULL AND sent_at >= $1 AND sent_at < $2", [ws, we]),
        pool.query("SELECT count(*) as cnt FROM notes WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2", [ws, we]),
        pool.query("SELECT * FROM todos WHERE deleted_at IS NULL AND due_date >= $1 AND due_date < $2 AND NOT completed ORDER BY due_date", [we, new Date(weekEnd.getTime() + 7*86400000).toISOString().split("T")[0]]),
        pool.query("SELECT * FROM todos WHERE deleted_at IS NULL AND due_date < $1 AND NOT completed ORDER BY due_date", [ws]),
      ]);
      res.json({
        week_start: ws, week_end: we,
        tasks_completed: completed.rows,
        tasks_created_count: parseInt(created.rows[0].cnt, 10),
        emails_sent_count: parseInt(sent.rows[0].cnt, 10),
        notes_created_count: parseInt(notesCreated.rows[0].cnt, 10),
        upcoming_tasks: upcoming.rows,
        overdue_tasks: overdue.rows,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
