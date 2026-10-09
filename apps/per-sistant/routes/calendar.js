const express = require("express");

const { serverError } = require("../errors");

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
        pool.query("SELECT id, title, due_date, recurrence_rule, recurrence_interval, recurrence_anchor_day, priority FROM todos WHERE deleted_at IS NULL AND recurring = true AND completed = false AND due_date IS NOT NULL"),
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
          // Chain anchor day keeps month-end projections on month-end (PD-2).
          nextDate = advanceRecurrence(nextDate, t.recurrence_rule, t.recurrence_interval || 1, t.recurrence_anchor_day || new Date(t.due_date).getDate());
        }
      }
      res.json([...todos.rows, ...emails.rows, ...notes.rows, ...projected]);
    } catch (err) { serverError(res, err); }
  });

  router.get("/api/calendar.ics", async (req, res) => {
    try {
      const [todos, emails] = await Promise.all([
        pool.query("SELECT id, title, description, due_date, priority FROM todos WHERE deleted_at IS NULL AND due_date IS NOT NULL AND completed = false ORDER BY due_date"),
        pool.query("SELECT id, subject, recipient_email, scheduled_at FROM emails WHERE deleted_at IS NULL AND scheduled_at IS NOT NULL AND status = 'scheduled' ORDER BY scheduled_at"),
      ]);
      // PD-11: RFC 5545 text escaping (backslash, comma, semicolon, newline —
      // the old replace turned "\n" into "\\n" then into " n"), a DTSTAMP on
      // every VEVENT, all-day events ending the NEXT day (DTEND == DTSTART is
      // a zero-length event strict clients reject), and folded long lines.
      const stamp = icsUtc(new Date());
      const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Per-sistant//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Per-sistant Tasks"];
      for (const t of todos.rows) {
        const d = new Date(t.due_date); // node-pg DATE = local midnight → local getters
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        lines.push("BEGIN:VEVENT", `UID:todo-${t.id}@per-sistant`, `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${icsDate(d)}`, `DTEND;VALUE=DATE:${icsDate(next)}`,
          `SUMMARY:${icsEscape(`[${String(t.priority || "").toUpperCase()}] ${t.title || ""}`)}`);
        if (t.description) lines.push(`DESCRIPTION:${icsEscape(t.description)}`);
        lines.push("END:VEVENT");
      }
      for (const e of emails.rows) {
        const at = icsUtc(new Date(e.scheduled_at));
        lines.push("BEGIN:VEVENT", `UID:email-${e.id}@per-sistant`, `DTSTAMP:${stamp}`,
          `DTSTART:${at}`, `DTEND:${at}`,
          `SUMMARY:${icsEscape("Email: " + (e.subject || ""))}`,
          `DESCRIPTION:${icsEscape("To: " + (e.recipient_email || ""))}`, "END:VEVENT");
      }
      let ical = lines.map(icsFold).join("\r\n") + "\r\n";
      ical += "END:VCALENDAR\r\n";
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="per-sistant.ics"');
      res.send(ical);
    } catch (err) { serverError(res, err); }
  });

  return router;
};

// RFC 5545 §3.3.11 TEXT escaping (PD-11). CR is dropped, CRLF/LF → "\n".
function icsEscape(v) {
  return String(v == null ? "" : v)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n/g, "\\n")
    .replace(/\r/g, "");
}
// Fold a content line at 75 octets (§3.1): continuation lines start with a space.
function icsFold(line) {
  const buf = Buffer.from(line, "utf8");
  if (buf.length <= 75) return line;
  const parts = [];
  let cur = "", curLen = 0, limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (curLen + n > limit) { parts.push(cur); cur = ""; curLen = 0; limit = 74; }
    cur += ch; curLen += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}
function icsDate(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}
function icsUtc(d) {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

module.exports.icsEscape = icsEscape;
module.exports.icsFold = icsFold;
