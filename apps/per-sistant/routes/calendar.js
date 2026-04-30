const express = require("express");

module.exports = function ({ pool, advanceRecurrence }) {
  const router = express.Router();

  router.get("/api/calendar", async (req, res) => {
    try {
      const { month, year } = req.query;
      const m = parseInt(month, 10) || new Date().getMonth() + 1;
      const y = parseInt(year, 10) || new Date().getFullYear();
      const startDate = `${y}-${String(m).padStart(2,"0")}-01`;
      const endDate = m === 12 ? `${y+1}-01-01` : `${y}-${String(m+1).padStart(2,"0")}-01`;
      const [todos, emails, notes, recurring] = await Promise.all([
        pool.query("SELECT id, title, due_date as event_date, priority, 'todo' as type FROM todos WHERE deleted_at IS NULL AND due_date >= $1 AND due_date < $2 AND NOT completed", [startDate, endDate]),
        pool.query("SELECT id, subject as title, scheduled_at as event_date, status as priority, 'email' as type FROM emails WHERE deleted_at IS NULL AND scheduled_at >= $1 AND scheduled_at < $2", [startDate, endDate]),
        pool.query("SELECT id, COALESCE(title, LEFT(content,30)) as title, reminder_at as event_date, 'note' as type FROM notes WHERE deleted_at IS NULL AND reminder_at >= $1 AND reminder_at < $2", [startDate, endDate]),
        pool.query("SELECT id, title, due_date, recurrence_rule, recurrence_interval, priority FROM todos WHERE deleted_at IS NULL AND recurring = true AND completed = false AND due_date IS NOT NULL"),
      ]);
      // Project future recurring instances into this month
      const projected = [];
      const start = new Date(startDate);
      const end = new Date(endDate);
      for (const t of recurring.rows) {
        let nextDate = new Date(t.due_date);
        let safety = 0;
        while (nextDate < end && safety++ < 100) {
          if (nextDate >= start && nextDate < end) {
            // Only add if not already in the actual todos
            const dateStr = nextDate.toISOString().split("T")[0];
            if (!todos.rows.some(x => x.id === t.id && x.event_date && new Date(x.event_date).toISOString().split("T")[0] === dateStr)) {
              projected.push({ id: t.id, title: t.title, event_date: dateStr, priority: t.priority, type: "todo", recurring_projection: true });
            }
          }
          nextDate = advanceRecurrence(nextDate, t.recurrence_rule, t.recurrence_interval || 1);
        }
      }
      res.json([...todos.rows, ...emails.rows, ...notes.rows, ...projected]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get("/api/calendar.ics", async (req, res) => {
    try {
      const [todos, emails] = await Promise.all([
        pool.query("SELECT id, title, description, due_date, priority FROM todos WHERE deleted_at IS NULL AND due_date IS NOT NULL AND completed = false ORDER BY due_date"),
        pool.query("SELECT id, subject, recipient_email, scheduled_at FROM emails WHERE deleted_at IS NULL AND scheduled_at IS NOT NULL AND status = 'scheduled' ORDER BY scheduled_at"),
      ]);
      let ical = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Per-sistant//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:Per-sistant Tasks\r\n";
      for (const t of todos.rows) {
        const d = new Date(t.due_date);
        const dateStr = d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
        const dateOnly = dateStr.substring(0, 8);
        ical += `BEGIN:VEVENT\r\nUID:todo-${t.id}@per-sistant\r\nDTSTART;VALUE=DATE:${dateOnly}\r\nDTEND;VALUE=DATE:${dateOnly}\r\nSUMMARY:[${t.priority.toUpperCase()}] ${t.title.replace(/[\\,;]/g, " ")}\r\n${t.description ? "DESCRIPTION:" + t.description.replace(/\n/g, "\\n").replace(/[\\,;]/g, " ") + "\r\n" : ""}END:VEVENT\r\n`;
      }
      for (const e of emails.rows) {
        const d = new Date(e.scheduled_at);
        const dateStr = d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
        ical += `BEGIN:VEVENT\r\nUID:email-${e.id}@per-sistant\r\nDTSTART:${dateStr}\r\nDTEND:${dateStr}\r\nSUMMARY:Email: ${e.subject.replace(/[\\,;]/g, " ")}\r\nDESCRIPTION:To: ${e.recipient_email}\r\nEND:VEVENT\r\n`;
      }
      ical += "END:VCALENDAR\r\n";
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="per-sistant.ics"');
      res.send(ical);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
