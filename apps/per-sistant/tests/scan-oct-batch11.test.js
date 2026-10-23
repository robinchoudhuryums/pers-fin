// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 11 — Per-sistant correctness
// ============================================================================
// The database-backed half (attachments in Postgres, the trash purge, the
// reminder_due claim, the email PATCH rules, failed-email and Job Radar
// notifications, the streak restored on undo, literal search, bulk-complete
// automations, the weekly review's upcoming list, the refresh skip) lives in
// the root tests/contract/persistent-batch11.contract.test.js.
// F109  DATE values render as calendar days (parseCalDate / fmtCalDate)
// F113  writes report failures (writeOk); no Undo after a failed delete
// F111  Send Now runs once at a time (guardPending)
// F110  last month's unpaid rent stays overdue from the 1st
// F112  failed emails surface; perfin_webhook_recipient validated
// F114  Job Radar nudge counts new listings only, keyed to the newest
// F115  note reminders and /api/stats overdue on the APP_TIMEZONE day
// F116  email_sent / note_created / reminder_due webhooks + Slack fire
// F117  Job Radar refresh single-flight; backstop skips a recent refresh
// F118  Ask counts from real totals
// F119  weekly review upcoming starts today
// F120  a sent email is final; 'scheduled' needs a time
// F121  attachments stored in Postgres
// F122  30-day trash purge
// F123  general limiter skipped under the shell
// F124  parse-todo, literal search, milestone once, PIN length, projections,
//       streak on undo, webhook status 0, automation/webhook parity
// ============================================================================

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const config = require("../config");
const db = require("../db");
const helpers = require("../helpers");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const JS = require("../views/js");

function appWith(router, { embedded = false } = {}) {
  const app = express();
  if (embedded) app.set("embedded", true);
  app.use(express.json());
  app.use(router);
  return app;
}
let realQuery;
function stubDb(fn) { realQuery = realQuery || db.pool.query; db.pool.query = fn; }
afterEach(() => { if (realQuery) { db.pool.query = realQuery; realQuery = null; } });

// Pull a top-level function out of the EMITTED shared client bundle.
function clientFn(name, extraCtx = {}) {
  let start = JS.indexOf("function " + name + "(");
  assert.ok(start >= 0, name);
  if (JS.slice(start - 6, start) === "async ") start -= 6;
  let depth = 0, i = JS.indexOf("{", start);
  for (; i < JS.length; i++) { if (JS[i] === "{") depth++; else if (JS[i] === "}" && --depth === 0) break; }
  const ctx = { ...extraCtx };
  vm.runInNewContext(JS.slice(start, i + 1) + `;this.fn=${name};`, ctx);
  return ctx.fn;
}

// ---------------------------------------------------------------------------
describe("F109 — DATE values as calendar days", () => {
  it("parseCalDate reads 'YYYY-MM-DD' and node-pg's UTC midnight as that local day", () => {
    const prev = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const parseCalDate = clientFn("parseCalDate", { Date });
      for (const v of ["2026-10-01", "2026-10-01T00:00:00.000Z"]) {
        const d = parseCalDate(v);
        assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 9, 1], v);
      }
      // A real timestamp is left as a timestamp.
      assert.equal(parseCalDate("2026-10-01T15:30:00.000Z").getUTCHours(), 15);
      assert.equal(parseCalDate(null), null);
    } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  });

  it("no page reads a due date with new Date(); the calendar reads todo days as dates", () => {
    for (const f of ["pages/dashboard-script.js", "pages/review.js", "pages/today.js", "pages/todos-script-1.js", "pages/calendar.js"]) {
      assert.doesNotMatch(read(f), /new Date\([a-z]\.due_date\)/, f);
    }
    assert.match(read("pages/calendar.js"), /e\.type === 'todo' \? parseCalDate\(e\.event_date\) : new Date\(e\.event_date\)/);
    assert.match(read("pages/review.js"), /fmtCalDate\(data\.week_start\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F113 / F111 — writes report failures; one Send at a time", () => {
  it("writeOk: true on 2xx; otherwise the server's error in a toast and false", async () => {
    const shown = [];
    const writeOk = clientFn("writeOk", { showUndo: (m) => shown.push(m) });
    assert.equal(await writeOk({ ok: true }), true);
    const bad = { ok: false, status: 400, clone: () => ({ json: async () => ({ error: "Invalid email address format." }) }) };
    assert.equal(await writeOk(bad, "Could not save the email"), false);
    assert.equal(await writeOk(null, "Could not save"), false);
    assert.deepEqual(shown, ["Could not save the email: Invalid email address format.", "Could not save: no connection"]);
  });

  it("guardPending runs one at a time per key", async () => {
    const start = JS.indexOf("var _pending = {};");
    const end = JS.indexOf("function showUndo(");
    const ctx = {};
    vm.runInNewContext(JS.slice(start, end) + ";this.g=guardPending;", ctx);
    let release;
    const first = ctx.g("send-now", () => new Promise((r) => { release = r; }));
    assert.equal(await ctx.g("send-now", async () => "second"), undefined, "a second click while sending does nothing");
    release("done");
    assert.equal(await first, "done");
    assert.equal(await ctx.g("send-now", async () => "again"), "again");
    // Since cycle-7 Batch 20 (ST3) Send Now goes through withPending (guardPending + the button).
    assert.match(read("pages/emails.js"), /return withPending\(document\.getElementById\('send-now-btn'\), 'send-now', async function\(\)/);
  });

  it("no page discards a write's response", () => {
    for (const f of fs.readdirSync(path.join(__dirname, "..", "pages")).filter((x) => x.endsWith(".js"))) {
      const src = read("pages", f);
      // Logout is fire-and-forget by design (the page leaves either way).
      assert.doesNotMatch(src, /^\s*(if \(id\) |else )?await fetch\((?!'\/api\/logout')[^;]*method: ?'(POST|PATCH|DELETE|PUT)'[^;]*\);\s*$/m, f);
    }
  });

  it("an Undo is offered only after the delete succeeded; failed saves keep the modal", () => {
    for (const [f, re] of [
      ["pages/emails.js", /if \(!\(await writeOk\(await tryFetch\('\/api\/emails\/'\+id, \{method:'DELETE'\}\), 'Could not delete the email'\)\)\) return;\n  closeCompose\(\); load\(\);\n  showUndo/],
      ["pages/todos-script-2.js", /'Could not delete the task'\)\)\) return;\n  closeModal\(\); load\(\);\n  showUndo/],
      ["pages/emails.js", /if \(!\(await writeOk\(res, 'Could not schedule the email'\)\)\) return;\n  closeCompose\(\); load\(\);/],
      ["pages/todos-script-1.js", /if \(!\(await writeOk\(res, 'Could not save the task'\)\)\) return;/],
    ]) assert.match(read(f), re, f);
  });
});

// ---------------------------------------------------------------------------
describe("F110 — last month's unpaid rent", () => {
  const { computeHousingDue, housingDue } = require("../routes/housing-due");
  const CFG = { enabled: true, payee_name: "Sam", rent_due_day: 15, reminder_lead_days: 5 };
  it("an unpaid earlier month is overdue from its own due date", () => {
    const h = computeHousingDue(CFG, 900, 1, "2026-10-02", { period: "2026-09", due_day: 15 });
    assert.deepEqual([h.status, h.days_until_due, h.due_date], ["overdue", -17, "2026-09-15"]);
    // This month's own row keeps the lead-window rule.
    assert.equal(computeHousingDue(CFG, 900, 1, "2026-10-02", { period: "2026-10", due_day: 15 }), null);
    // A 31st due day clamps to the month's length.
    assert.equal(computeHousingDue({ ...CFG, rent_due_day: 31 }, 1, 1, "2026-03-02", { period: "2026-02", due_day: null }).due_date, "2026-02-28");
  });
  it("housingDue reads the oldest unpaid row's period", async () => {
    const pool = { query: async (sql) => (/housing_config/.test(sql)
      ? { rows: [{ housing_config: CFG }] }
      : { rows: [{ balance: "900", n: 1, oldest_period: "2026-09", oldest_due_day: 15 }] }) };
    assert.equal((await housingDue(pool, "2026-10-02")).status, "overdue");
  });
});

// ---------------------------------------------------------------------------
describe("F112 / F115 / F114 — notifications and settings", () => {
  function notifApp(rows) {
    const calls = [];
    const pool = { query: async (sql, p) => { calls.push({ sql, p }); for (const [re, r] of rows) if (re.test(sql)) return { rows: r }; return { rows: [] }; } };
    return { calls, app: appWith(require("../routes/notifications")({ pool })) };
  }
  it("a failed email surfaces; note reminders use the APP_TIMEZONE day", async () => {
    const { calls, app } = notifApp([[/status = 'failed'/, [{ id: 7, subject: "Rent", recipient_email: "a@b.co", error_message: "535 auth failed" }]]]);
    const body = (await supertest(app).get("/api/notifications/check").expect(200)).body;
    const n = body.notifications.find((x) => x.type === "email_failed");
    assert.deepEqual([n.id, n.entity], [7, "email"]);
    assert.match(n.title, /"Rent" to a@b\.co: 535 auth failed/);
    assert.equal(body.counts.email_failed, 1);
    const rem = calls.find((c) => /FROM notes/.test(c.sql));
    assert.match(rem.sql, /\(reminder_at AT TIME ZONE \$2\)::date = \$1/);
    assert.equal(rem.p[1], process.env.APP_TIMEZONE || "UTC");
  });
  it("the dashboard notifies on email_failed and links to Emails; Job Radar waits a week", () => {
    const d = read("pages/dashboard-script.js");
    assert.match(d, /email_failed: 'Email not sent: '/);
    assert.match(d, /n\.type === 'email_failed'\) return true/);
    assert.match(d, /var NOTIFY_WINDOW_BY_TYPE = \{ job_radar: 7 \* 24 \* 60 \* 60 \* 1000 \};/);
  });
  it("Job Radar counts new main listings only and reports the newest", async () => {
    const { gatherJobRadarSummary } = require("../routes/jobs");
    const row = (id, status, first_seen) => ({ id, status, first_seen, trust_score: 80, fit_score: 90, legitimacy: "real" });
    const pool = { query: async () => ({ rows: [row(1, "saved", "2026-10-01"), row(2, "new", "2026-10-05"), row(3, "new", "2026-10-09")] }) };
    const s = await gatherJobRadarSummary(pool);
    assert.deepEqual([s.counts.main, s.counts.main_new], [3, 2]);
    assert.equal(s.top_new.id, 2);
    assert.equal(s.newest_first_seen.slice(0, 10), "2026-10-09");
  });
  it("perfin_webhook_recipient must be one address; /api/stats overdue uses today in APP_TIMEZONE", async () => {
    const calls = [];
    const pool = { query: async (sql, p) => { calls.push({ sql, p }); return { rows: [{ pending: 0, done: 0, urgent: 0, overdue: 0, total: 0 }] }; } };
    const app = appWith(require("../routes/settings")({ pool, config }));
    await supertest(app).patch("/api/settings").send({ perfin_webhook_recipient: "Bob" }).expect(400);
    await supertest(app).patch("/api/settings").send({ perfin_webhook_recipient: "a@x.com,b@y.com" }).expect(400);
    await supertest(app).patch("/api/settings").send({ perfin_webhook_recipient: " me@example.com " }).expect(200);
    const upd = calls.find((c) => /perfin_webhook_recipient = \$/.test(c.sql));
    assert.ok(upd.p.includes("me@example.com"));
    await supertest(app).get("/api/stats").expect(200);
    const st = calls.find((c) => /due_date <= \$1::date/.test(c.sql));
    assert.deepEqual(st.p, [require("../routes/health").todayStr()]);
  });
});

// ---------------------------------------------------------------------------
describe("F116 — webhooks and Slack fire", () => {
  it("fireWebhooks posts one Slack line; a missing Slack URL is a no-op", async () => {
    assert.equal(helpers.slackLineFor("email_sent", { subject: "Hi", recipient_email: "a@b.co" }), 'Email sent: "Hi" to a@b.co');
    assert.equal(helpers.slackLineFor("reminder_due", { title: "Call mom" }), "Reminder: Call mom");
    const seen = [];
    stubDb(async (sql) => { seen.push(sql); return { rows: [] }; });
    await helpers.fireWebhooks("note_created", { title: "x" });
    assert.ok(seen.some((s) => /FROM webhooks/.test(s)));
    assert.ok(seen.some((s) => /slack_webhook_url/.test(s)), "Slack is consulted for every event");
  });
  it("processDueReminders claims each due reminder once, within the last day", async () => {
    const q = [];
    const dbx = { query: async (sql) => { q.push(sql); return { rows: /UPDATE notes/.test(sql) ? [{ id: 1, title: "Call", reminder_at: new Date() }] : [] }; } };
    stubDb(async () => ({ rows: [] }));
    assert.equal(await helpers.processDueReminders(dbx), 1);
    assert.match(q[0], /reminder_at <= now\(\) AND reminder_at > now\(\) - interval '1 day'/);
    assert.match(q[0], /reminder_fired_at IS NULL OR reminder_fired_at < reminder_at/);
  });
  it("the three events are wired: email send (manual + cron), note create, reminder cron", () => {
    assert.match(read("routes/emails.js"), /fireWebhooks\('email_sent'/);
    assert.match(read("server.js"), /fireWebhooks\("email_sent"/);
    assert.match(read("server.js"), /await processDueReminders\(pool\)/);
    assert.match(read("routes/notes.js"), /fireWebhooks\('note_created', \{ id: n\.id, title: n\.title, tags: n\.tags, created_at: n\.created_at \}\)/);
    assert.match(read("db", "026_note_reminder_fired.sql"), /ADD COLUMN IF NOT EXISTS reminder_fired_at TIMESTAMPTZ/);
  });
});

// ---------------------------------------------------------------------------
describe("F117 / F118 / F119 / F120 / F123", () => {
  it("F117: the refresh is single-flight and a scheduled call skips a recent refresh", async () => {
    const src = read("routes/jobs.js");
    assert.match(src, /if \(_refreshInFlight\) return _refreshInFlight;/);
    const pool = { query: async (sql) => (/job_radar_enabled/.test(sql) ? { rows: [{ job_radar_enabled: true }] } : { rows: [{ "?column?": 1 }] }) };
    const res = await supertest(appWith(require("../routes/jobs")({ pool }))).post("/api/jobs/refresh").expect(200);
    assert.deepEqual(res.body, { ok: true, skipped: "recent" });
    assert.match(fs.readFileSync(path.join(__dirname, "../../../.github/workflows/job-radar.yml"), "utf8"), /cron: '47 9 \* \* 1'/);
  });
  it("F118: Ask sends totals over all data and says the lists are samples", () => {
    const src = read("routes/ai.js");
    assert.match(src, /Totals over ALL data \(use these for counts\)/);
    assert.match(src, /todos_overdue/);
  });
  it("F119: the review's upcoming list starts today", async () => {
    const calls = [];
    const pool = { query: async (sql, p) => { calls.push({ sql, p }); return { rows: [{ cnt: "0" }] }; } };
    await supertest(appWith(require("../routes/review")({ pool }))).get("/api/review").expect(200);
    const up = calls.find((c) => /due_date >= \$1 AND due_date < \$2/.test(c.sql));
    assert.equal(up.p[0], require("../routes/health").todayStr());
  });
  it("F120: a sent email can't be changed; 'scheduled' needs a time; only draft/scheduled settable", async () => {
    const mk = (row) => appWith(require("../routes/emails")({ pool: { query: async (sql) => (/SELECT status, scheduled_at/.test(sql) ? { rows: [row] } : { rows: [{ id: 1 }] }) }, config, helpers: {} }));
    await supertest(mk({ status: "sent" })).patch("/api/emails/1").send({ status: "draft" }).expect(409);
    await supertest(mk({ status: "draft", scheduled_at: null })).patch("/api/emails/1").send({ status: "scheduled" }).expect(400);
    await supertest(mk({ status: "draft", scheduled_at: null })).patch("/api/emails/1").send({ status: "sent" }).expect(400);
    await supertest(mk({ status: "draft", scheduled_at: null })).patch("/api/emails/1").send({ status: "scheduled", scheduled_at: "2030-01-01T09:00:00Z" }).expect(200);
    await supertest(mk({ status: "draft", scheduled_at: "2030-01-01T09:00:00Z" })).patch("/api/emails/1").send({ status: "scheduled" }).expect(200);
  });
  it("F123: the general limiter is skipped when embedded", () => {
    assert.match(read("middleware.js"), /max: 200,[\s\S]{0,120}skip: \(req\) => !!req\.app\.get\("embedded"\),/);
  });
});

// ---------------------------------------------------------------------------
describe("F121 / F122 — attachments and trash", () => {
  it("lists never ship file bytes; downloads read the row", () => {
    const src = read("routes/attachments.js");
    assert.match(src, /storage: multer\.memoryStorage\(\)/);
    assert.match(src, /SELECT \$\{META_COLUMNS\} FROM attachments WHERE entity_type/);
    assert.doesNotMatch(src, /SELECT \* FROM attachments WHERE entity_type/);
    assert.match(read("db", "025_attachments_data.sql"), /ADD COLUMN IF NOT EXISTS data BYTEA/);
  });
  it("the download route is reachable (declared before /:entityType/:entityId)", async () => {
    const src = read("routes/attachments.js");
    assert.ok(src.indexOf('router.get("/api/attachments/download/:id"') < src.indexOf('router.get("/api/attachments/:entityType/:entityId"'));
    const pool = { query: async () => ({ rows: [{ id: 3, original_name: "a.txt", mime_type: "text/plain", data: Buffer.from("hi") }] }) };
    const res = await supertest(appWith(require("../routes/attachments")({ pool }))).get("/api/attachments/download/3").expect(200);
    assert.equal(res.text, "hi");
  });
  it("migrateDiskAttachments copies files still on disk into the row", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "att-"));
    fs.writeFileSync(path.join(dir, "1-a.txt"), "hello");
    const updates = [];
    const pool = { query: async (sql, p) => {
      if (/WHERE data IS NULL$/.test(sql)) return { rows: [{ id: 1, filename: "1-a.txt" }, { id: 2, filename: "gone.txt" }] };
      updates.push(p); return { rows: [] };
    } };
    const { migrateDiskAttachments } = require("../routes/attachments");
    assert.equal(await migrateDiskAttachments(pool, dir), 1);
    assert.equal(updates[0][0].toString(), "hello");
    assert.equal(updates[0][1], 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("purgeTrash removes old trash with its attachments, links and note chunks", async () => {
    const calls = [];
    const pool = { query: async (sql, p) => { calls.push({ sql, p }); return { rows: /RETURNING id/.test(sql) ? [{ id: 9 }] : [] }; } };
    const trash = require("../routes/trash");
    const out = await trash.purgeTrash(pool, trash.TRASH_RETENTION_DAYS);
    assert.deepEqual(out, { todos: 1, emails: 1, notes: 1 });
    assert.ok(calls.some((c) => /DELETE FROM todos WHERE deleted_at < now\(\) - make_interval\(days => \$1\)/.test(c.sql) && c.p[0] === 30));
    for (const t of ["todo", "email", "note"]) {
      assert.ok(calls.some((c) => /DELETE FROM attachments WHERE entity_type = \$1/.test(c.sql) && c.p[0] === t), t);
      assert.ok(calls.some((c) => /DELETE FROM entity_links/.test(c.sql) && c.p[0] === t), t);
    }
    assert.ok(calls.some((c) => /DELETE FROM chunks/.test(c.sql)));
    assert.match(read("server.js"), /trash\.purgeTrash\(pool, trash\.TRASH_RETENTION_DAYS\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F124 — grouped fixes", () => {
  it("parse-todo answers are shaped and the preview escapes them", () => {
    const { normalizeParsedTodo } = require("../routes/ai");
    assert.deepEqual(normalizeParsedTodo({ title: " Call ", priority: "mega", horizon: "long", category: 7, due_date: "2026-02-30" }, "x"),
      { title: "Call", priority: "medium", horizon: "long", category: null, due_date: null });
    assert.equal(normalizeParsedTodo({ due_date: "2026-03-01" }, "in").due_date, "2026-03-01");
    assert.equal(normalizeParsedTodo(null, "Pay rent").title, "Pay rent");
    assert.match(read("routes/ai.js"), /const today = todayStr\(\);\n      const text = await capped\("quick_add", model,/);
    assert.match(read("pages/todos-script-2.js"), /esc\(String\(r\.priority\)\)[\s\S]*esc\(r\.due_date\|\|'None'\)/);
  });
  it("search matches % and _ literally", async () => {
    const calls = [];
    const pool = { query: async (sql, p) => { calls.push(p); return { rows: [] }; } };
    await supertest(appWith(require("../routes/search")({ pool }))).get("/api/search?q=" + encodeURIComponent("100%_x")).expect(200);
    assert.equal(calls[0][0], "%100\\%\\_x%");
  });
  it("streak_milestone fires only when the log newly meets the day's target", async () => {
    const fired = [];
    const realFire = helpers.fireWebhooks;
    helpers.fireWebhooks = async (e) => { fired.push(e); };
    try {
      const run = async (prev) => {
        const pool = { query: async (sql) => {
          if (/FROM habits WHERE id/.test(sql)) return { rows: [{ id: 1, kind: "check", schedule: "daily", name: "Walk", created_at: "2020-01-01" }] };
          if (/SELECT value FROM habit_logs WHERE habit_id = \$1 AND log_date = \$2/.test(sql)) return { rows: prev };
          if (/INSERT INTO habit_logs/.test(sql)) return { rows: [{ id: 1 }] };
          // seven consecutive days ending today → a 7-day milestone
          const today = require("../routes/health").todayStr();
          return { rows: Array.from({ length: 7 }, (_, i) => ({ log_date: new Date(Date.parse(today + "T00:00:00Z") - i * 86400000).toISOString().slice(0, 10), value: 1 })) };
        } };
        await supertest(appWith(require("../routes/health")({ pool, helpers }))).post("/api/habits/1/log").send({}).expect(200);
      };
      await run([]);
      await run([{ value: 1 }]);
      assert.deepEqual(fired, ["streak_milestone"], "a re-tick of an already-met day doesn't fire again");
    } finally { helpers.fireWebhooks = realFire; }
  });
  it("undo restores the streak the task had before a late completion", async () => {
    const steps = [];
    const client = { query: async (sql, p) => {
      steps.push({ sql, p });
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: 5, recurring: true, completed: true, missed: false, recurrence_parent_id: null, streak_before_completion: 12 }] };
      if (/^DELETE FROM todos/.test(sql)) return { rows: [{ streak_count: 1 }] };
      return { rows: [] };
    }, release() {} };
    await require("../routes/todos").undoCompleteRecurringTodo({ connect: async () => client }, 5, 6);
    const reopen = steps.find((s) => /SET completed = false, completed_at = NULL, streak_count = \$2/.test(s.sql));
    assert.deepEqual(reopen.p, [5, 12]);
    assert.match(read("routes/todos.js"), /streak_before_completion = \$5 WHERE id = \$1",\n      \[todo\.id, newStreak, newBest, today, todo\.streak_count \|\| 0\]/);
  });
  it("PIN length, projection bound, webhook status 0 and the parity paths", () => {
    assert.match(read("routes/auth.js"), /if \(pin\.length >= 64 \|\| submitting\) return;/);
    assert.match(read("routes/calendar.js"), /while \(nextDate < end && safety\+\+ < 5000\)/);
    assert.match(read("pages/settings-script.js"), /w\.last_status!=null\?/);
    assert.match(read("routes/bulk.js"), /\(done\.rows \|\| \[\]\)\.forEach\(\(t\) => announceTodoEvent\("todo_completed", t\)\);/);
    assert.equal((read("routes/links.js").match(/announceTodoEvent\("todo_created", todo\.rows\[0\]\)/g) || []).length, 2);
    assert.match(read("routes/todoTemplates.js"), /announceTodoEvent\("todo_created", todo\)/);
  });
});
