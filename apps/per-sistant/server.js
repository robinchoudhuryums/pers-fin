// ============================================================================
// Per-sistant — Personal Assistant Server (Entry Point)
// ============================================================================
// Express server for personal task management, email scheduling, and notes.
// See CLAUDE.md for full documentation.
//
// Run with:  node server.js
// Requires:  .env file in repo root (see .env.example)
// ============================================================================

require("dotenv").config();

const express = require("express");

const config = require("./config");
const { pool, runMigrations } = require("./db");
const { advanceRecurrence } = require("./helpers");
const middleware = require("./middleware");
const views = require("./views");
const { startKeepAlive } = require("./services/keep-alive");

let nodemailer;
try { nodemailer = require("nodemailer"); } catch { nodemailer = null; }

let cron;
try { cron = require("node-cron"); } catch { cron = null; }

const app = express();
app.set("trust proxy", 1);
// Capture the raw request bytes alongside the parsed JSON. HMAC-signed
// webhook handlers (e.g. routes/perfin.js) need the exact payload the sender
// signed; restringifying req.body is not guaranteed to match byte-for-byte.
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ---------------------------------------------------------------------------
// Middleware (session, auth, CSRF, security, rate limiting)
// ---------------------------------------------------------------------------
middleware.setup(app);

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
const deps = { pool, config, helpers: require("./helpers"), views };

app.use(require("./routes/auth")(deps));
app.use(require("./routes/todos")(deps));
app.use(require("./routes/emails")(deps));
app.use(require("./routes/notes")(deps));
app.use(require("./routes/contacts")(deps));
app.use(require("./routes/settings")(deps));
app.use(require("./routes/bulk")(deps));
app.use(require("./routes/automations")(deps));
app.use(require("./routes/links")(deps));
app.use(require("./routes/webhooks")(deps));
app.use(require("./routes/notifications")(deps));
app.use(require("./routes/analytics")(deps));
app.use(require("./routes/attachments")(deps));
app.use(require("./routes/trash")(deps));
app.use(require("./routes/todoTemplates")(deps));
app.use(require("./routes/calendar")(deps));
app.use(require("./routes/review")(deps));
app.use(require("./routes/search")(deps));
app.use(require("./routes/ai")(deps));
app.use(require("./routes/perfin")(deps));
app.use(require("./routes/pwa")(deps));

// ---------------------------------------------------------------------------
// Page Routes
// ---------------------------------------------------------------------------
app.get("/", require("./pages/dashboard")());
app.get("/today", require("./pages/today")());
app.get("/todos", require("./pages/todos")());
app.get("/emails", require("./pages/emails")());
app.get("/notes", require("./pages/notes")());
app.get("/contacts", require("./pages/contacts")());
app.get("/calendar", require("./pages/calendar")());
app.get("/review", require("./pages/review")());
app.get("/analytics", require("./pages/analytics")());
app.get("/settings", require("./pages/settings")(config.AUTH_SECRET));

// ---------------------------------------------------------------------------
// Email Scheduler
// ---------------------------------------------------------------------------
// Reusable SMTP transporter (created once, not per-email)
let smtpTransporter = null;
function getSmtpTransporter() {
  if (!smtpTransporter && nodemailer && process.env.SMTP_HOST) {
    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: process.env.SMTP_PORT === "465",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return smtpTransporter;
}

async function processScheduledEmails() {
  if (!nodemailer || !process.env.SMTP_HOST) return;
  try {
    const r = await pool.query(
      "SELECT * FROM emails WHERE deleted_at IS NULL AND status = 'scheduled' AND scheduled_at <= now()"
    );
    for (const email of r.rows) {
      try {
        const transporter = getSmtpTransporter();
        const mail = {
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: email.recipient_email,
          subject: email.subject,
          text: email.body,
        };
        if (email.body_html) mail.html = email.body_html;
        await transporter.sendMail(mail);
        await pool.query("UPDATE emails SET status = 'sent', sent_at = now() WHERE id = $1", [email.id]);
        console.log(`Sent scheduled email ${email.id} to ${email.recipient_email}`);
      } catch (err) {
        await pool.query("UPDATE emails SET status = 'failed', error_message = $1 WHERE id = $2", [err.message, email.id]);
        console.error(`Failed to send email ${email.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Email scheduler error:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// Two modes:
//   start()                         — standalone: listen, keep-alive, signals
//   start({ standalone: false })    — embedded: migrations + crons only,
//                                     shell handles listen/keep-alive/signals.
//
// Migrations and cron jobs run in BOTH modes — they're DB-bound work that
// belongs to this app regardless of whether it owns the HTTP listener.

const PORT = parseInt(process.env.PORT || "3001", 10);

async function start(opts = {}) {
  const standalone = opts.standalone !== false;

  if (process.env.NEON_DATABASE_URL) {
    await runMigrations();
  } else {
    console.log("No NEON_DATABASE_URL set — running without database (API calls will fail)");
  }

  // Email scheduler (every minute)
  if (cron) {
    cron.schedule("* * * * *", processScheduledEmails);
    console.log("Email scheduler started (checks every minute)");
  }

  // Recurring task processor — auto-generate next instance for overdue recurring
  if (cron) {
    cron.schedule("0 0 * * *", async () => {
      try {
        const r = await pool.query("SELECT * FROM todos WHERE deleted_at IS NULL AND recurring = true AND completed = false AND due_date < CURRENT_DATE");
        for (const todo of r.rows) {
          await pool.query("UPDATE todos SET completed = true, completed_at = now(), streak_count = 0 WHERE id = $1", [todo.id]);
          const rule = todo.recurrence_rule;
          const interval = todo.recurrence_interval || 1;
          let nextDue = new Date(todo.due_date);
          nextDue = advanceRecurrence(nextDue, rule, interval);
          let catchupLimit = 365;
          while (nextDue <= new Date() && catchupLimit-- > 0) {
            nextDue = advanceRecurrence(nextDue, rule, interval);
          }
          await pool.query(
            "INSERT INTO todos (title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval, recurrence_parent_id, streak_count, best_streak) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11)",
            [todo.title, todo.description, todo.priority, todo.horizon, todo.category, nextDue.toISOString().split("T")[0], true, rule, interval, todo.recurrence_parent_id || todo.id, todo.best_streak || 0]
          );
        }
        if (r.rows.length) console.log(`Processed ${r.rows.length} recurring tasks`);
      } catch (err) { console.error("Recurring task error:", err.message); }
    });
    console.log("Recurring task processor started (daily at midnight)");
  }

  if (!standalone) {
    // Embedded mode: shell owns the HTTP listener, keep-alive, and signals.
    return { app };
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Per-sistant running on http://localhost:${PORT}`);
    if (config.PERFIN_URL) console.log(`Linked to Perfin: ${config.PERFIN_URL}`);
    if (config.AUTH_SECRET) console.log(`Authentication: ${config.AUTH_MODE} mode`);
    if (process.env.SMTP_HOST) console.log("SMTP configured for email sending");
    if (process.env.PERSISTENT_WEBHOOK_SECRET) console.log("Perfin webhook receiver enabled");

    // Start keep-alive self-ping (Render free tier)
    startKeepAlive(PORT);
    console.log("Keep-alive service started (pings every 14 min when enabled)");
  });

  // Graceful shutdown — drain connections and stop cron jobs
  function shutdown(signal) {
    console.log(`\n${signal} received — shutting down gracefully...`);
    server.close(() => {
      pool.end().then(() => {
        console.log("Database pool closed.");
        process.exit(0);
      }).catch(() => process.exit(1));
    });
    setTimeout(() => { console.error("Forced shutdown after timeout"); process.exit(1); }, 10000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { app, server };
}

// Standalone bootstrap — only when this file is the process entry point.
// Required by the unified shell: it does `require("./server")` and gets
// `{ app, start, pool, ... }` without a second listener firing up.
if (require.main === module) {
  start().catch(console.error);
}

module.exports = { app, pool, start, processScheduledEmails, parseTimeExpr: null };
