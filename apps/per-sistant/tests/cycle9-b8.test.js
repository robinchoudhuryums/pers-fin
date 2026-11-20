// ============================================================================
// Cycle 9 (Nov 2026 broad scan) Batch 8 — Per-sistant behaviour and UI
// ============================================================================
// F52  a task edit that doesn't change the due date keeps the month-end anchor
// F53  a Job Radar profile save clears fit scores only when its text changed
// F50  a frontmatter privacy value on the line after its key is honoured
// F54  past-due scheduled emails are reported while SMTP isn't set up
// F55  Skip isn't a completion; a snooze doesn't move the schedule; a
//      recurring task with no rule isn't re-created and can be completed
// F56  a todo made from a private / secret note never carries its text
// F58  the finance gate ignores ordinary words; Slack failures are logged;
//      the briefing counts new roles only
// F65  the dashboard mini-calendar reads event_date
// F66  the automation / webhook On-Off buttons ask for the other state
// F67  "Use template" fills the compose form
// F68  a note's bulk checkbox doesn't open the note
// F69  single-key shortcuts ignore Ctrl / Cmd / Alt
// F70  the Theme select changes the page's mode; Auto follows the system
// F71  a refused vault setting is shown
// F72  quick parsers: "email to Bob", "wedding", "jan 5"
// The database-backed half is the root tests/contract/c9-batch8.contract.test.js.
// ============================================================================

const { describe, it, afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const dns = require("dns");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const config = require("../config");
const db = require("../db");
const helpers = require("../helpers");
const ai = require("../ai");
const todosRoutes = require("../routes/todos");
const jobs = require("../routes/jobs");
const vault = require("../services/vault-sync");
const notifRoutes = require("../routes/notifications");
const linksRoutes = require("../routes/links");
const { looksFinancial } = require("../routes/rag");
const { todayStr } = require("../routes/health");
const views = require("../views");

const JS = (() => { const j = require("../views/js.js"); return typeof j === "string" ? j : Object.values(j).find((v) => typeof v === "string"); })();

function appWith(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}
const realQuery = db.pool.query;
const realFetch = global.fetch;
const realLookup = dns.promises.lookup;
const realError = console.error;
afterEach(() => { db.pool.query = realQuery; global.fetch = realFetch; dns.promises.lookup = realLookup; console.error = realError; });

// A top-level function out of an emitted client script.
function extractFunction(src, name) {
  let start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "function " + name + " present in the emitted source");
  if (src.slice(start - 6, start) === "async ") start -= 6;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
// The statement that starts at `marker` and ends at its closing "});".
function extractCall(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, marker + " present");
  let depth = 0;
  for (let i = src.indexOf("(", start); i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(start, i + 1) + ";";
  }
  throw new Error("unbalanced: " + marker);
}
function renderPage(page) {
  let html = "";
  require("../pages/" + page)()({ query: {}, app: { get: () => false } }, { send: (h) => { html = h; }, set() { return this; }, locals: {} });
  return html;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// F52
// ---------------------------------------------------------------------------
describe("F52 — the month-end anchor survives an edit that keeps the due date", () => {
  it("the due-date SET clears the anchor only when the stored date differs", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 5 }] }; } };
    await supertest(appWith(todosRoutes({ pool, config }))).patch("/api/todos/5")
      .send({ title: "Pay rent", due_date: "2027-02-28" }).expect(200);
    const { sql, params } = calls[0];
    assert.deepEqual(params, ["Pay rent", "2027-02-28", "5"]);
    assert.match(sql, /due_date = \$2,/);
    assert.match(sql, /recurrence_anchor_day = CASE WHEN due_date IS DISTINCT FROM \$2::date THEN NULL ELSE recurrence_anchor_day END/);
    assert.match(sql, /snoozed_from = CASE WHEN due_date IS DISTINCT FROM \$2::date THEN NULL ELSE snoozed_from END/);
    assert.doesNotMatch(sql, /recurrence_anchor_day = NULL/);
  });
  it("a cleared due date is compared as NULL; an edit without a due date leaves both alone", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 5 }] }; } };
    const app = appWith(todosRoutes({ pool, config }));
    await supertest(app).patch("/api/todos/5").send({ due_date: "" }).expect(200);
    assert.deepEqual(calls[0].params, [null, "5"]);
    await supertest(app).patch("/api/todos/5").send({ title: "x" }).expect(200);
    assert.doesNotMatch(calls[1].sql, /recurrence_anchor_day|snoozed_from/);
  });
});

// ---------------------------------------------------------------------------
// F55
// ---------------------------------------------------------------------------
describe("F55 — skip, snooze and a recurring task with no rule", () => {
  function clientFor(row, log) {
    return {
      query: async (sql, params) => {
        log.push({ sql, params });
        if (/FOR UPDATE/.test(sql)) return { rows: row ? [row] : [] };
        if (/^INSERT INTO todos/.test(sql)) return { rows: [{ id: 99, due_date: params[5] }] };
        if (/RETURNING \*/.test(sql)) return { rows: [{ ...row, completed: true }] };
        return { rows: [] };
      },
      release() {},
    };
  }
  const weekly = { id: 5, title: "Water plants", recurring: true, recurrence_rule: "weekly", recurrence_interval: 1, completed: false, streak_count: 3, best_streak: 7, skipped_count: 1 };

  it("a skip leaves the active list without a completion time, flagged skipped", async () => {
    const log = [];
    const out = await todosRoutes.skipRecurringTodo({ connect: async () => clientFor({ ...weekly, due_date: todayStr() }, log) }, 5);
    assert.equal(out.next.id, 99);
    const upd = log.find((c) => /^UPDATE todos SET completed = true/.test(c.sql));
    assert.match(upd.sql, /completed_at = NULL, skipped = true, skipped_count = COALESCE\(skipped_count,0\) \+ 1/);
    assert.doesNotMatch(upd.sql, /completed_at = now\(\)/);
  });
  it("a hand change of the completed state ends the skip", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 5 }] }; } };
    await supertest(appWith(todosRoutes({ pool, config }))).patch("/api/todos/5").send({ completed: false }).expect(200);
    assert.match(calls[0].sql, /skipped = false/);
  });
  it("undo refuses a skipped instance (it isn't a completion)", async () => {
    const log = [];
    const out = await todosRoutes.undoCompleteRecurringTodo({ connect: async () => clientFor({ ...weekly, completed: true, skipped: true }, log) }, 5, 99);
    assert.equal(out.status, 400);
    assert.ok(!log.some((c) => /^DELETE/.test(c.sql)));
  });

  it("the next instance steps from the date before the snooze — a monthly task keeps February", () => {
    const snoozed = { due_date: "2027-02-03", snoozed_from: "2027-01-31", recurrence_rule: "monthly", recurrence_interval: 1, recurrence_anchor_day: 31 };
    assert.equal(helpers.ymdLocal(helpers.nextDueAfter(snoozed, "2027-02-03")), "2027-02-28");
    // Without the pre-snooze date (the old shape) February was skipped.
    assert.equal(helpers.ymdLocal(helpers.nextDueAfter({ ...snoozed, snoozed_from: null }, "2027-02-03")), "2027-03-31");
  });
  it("a weekly task keeps its weekday; a task that was never snoozed is unchanged", () => {
    const weeklyTask = { due_date: "2027-01-06", snoozed_from: "2027-01-04", recurrence_rule: "weekly", recurrence_interval: 1 };
    assert.equal(helpers.ymdLocal(helpers.nextDueAfter(weeklyTask, "2027-01-06")), "2027-01-11");
    assert.equal(helpers.ymdLocal(helpers.nextDueAfter({ due_date: "2027-01-04", recurrence_rule: "weekly", recurrence_interval: 1 }, "2027-01-04")), "2027-01-11");
    // Completed long after the snooze: still caught up past today.
    assert.equal(helpers.ymdLocal(helpers.nextDueAfter(weeklyTask, "2027-01-20")), "2027-01-25");
  });
  it("scheduleBase: the pre-snooze date, else the due date, else nothing", () => {
    assert.equal(helpers.ymdLocal(helpers.scheduleBase({ due_date: "2027-02-03", snoozed_from: "2027-01-31" })), "2027-01-31");
    assert.equal(helpers.ymdLocal(helpers.scheduleBase({ due_date: "2027-02-03" })), "2027-02-03");
    assert.equal(helpers.scheduleBase({}), null);
  });
  it("the snooze route records the date it replaces and the chain's day of month", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 5 }] }; } };
    await supertest(appWith(todosRoutes({ pool, config }))).post("/api/todos/5/snooze").send({ until: "2027-02-03" }).expect(200);
    assert.deepEqual(calls[0].params, ["2027-02-03", "5"]);
    assert.match(calls[0].sql, /snoozed_until = \$1, due_date = \$1/);
    assert.match(calls[0].sql, /snoozed_from = COALESCE\(snoozed_from, due_date\)/, "the FIRST pre-snooze date is kept across repeat snoozes");
    assert.match(calls[0].sql, /recurrence_anchor_day = COALESCE\(recurrence_anchor_day,\s+CASE WHEN recurring AND recurrence_rule IN \('monthly', 'custom_months', 'yearly'\)/);
  });

  it("the midnight roll leaves a recurring task with no rule alone and steps a snoozed one from its old date", async () => {
    const log = [];
    const row = { id: 8, title: "Rent", recurring: true, recurrence_rule: "monthly", recurrence_interval: 1, recurrence_anchor_day: 31, due_date: "2027-02-03", snoozed_from: "2027-01-31", best_streak: 2 };
    const dbFake = { query: async (sql, params) => {
      log.push({ sql, params });
      if (/^SELECT \* FROM todos/.test(sql)) return { rows: [row] };
      if (/^UPDATE todos SET completed = true/.test(sql)) return { rows: [{ id: 8 }] };
      return { rows: [] };
    } };
    const out = await helpers.rollMissedRecurring(dbFake, "2027-02-10");
    assert.equal(out.rolled, 1);
    assert.match(log[0].sql, /recurring = true AND recurrence_rule IS NOT NULL AND completed = false AND due_date < \$1/);
    const ins = log.find((c) => /^INSERT INTO todos/.test(c.sql));
    assert.equal(ins.params[5], "2027-02-28", "the February occurrence, not March's");
  });
  it("complete-recurring completes a recurring task that has no rule as a plain task", async () => {
    const log = [];
    db.pool.query = async () => ({ rows: [] }); // the webhook / automation lookups
    const out = await todosRoutes.completeRecurringTodo({ connect: async () => clientFor({ id: 6, title: "Odd one", recurring: true, recurrence_rule: null, completed: false, streak_count: 0 }, log) }, 6);
    assert.equal(out.next, null);
    assert.equal(out.completed.completed, true);
    assert.deepEqual(log.map((c) => c.sql.split(" ").slice(0, 2).join(" ")), ["BEGIN", "SELECT *", "UPDATE todos", "COMMIT"]);
    assert.ok(!log.some((c) => /^INSERT INTO todos/.test(c.sql)), "no next instance");
    await settle();
  });
  it("a task that isn't recurring at all is still refused, and so is Skip without a rule", async () => {
    const log = [];
    const plain = await todosRoutes.completeRecurringTodo({ connect: async () => clientFor({ id: 7, recurring: false, completed: false }, log) }, 7);
    assert.deepEqual(plain, { status: 400, error: "Not a recurring task." });
    const skip = await todosRoutes.skipRecurringTodo({ connect: async () => clientFor({ id: 6, recurring: true, recurrence_rule: null, completed: false }, log) }, 6);
    assert.deepEqual(skip, { status: 400, error: "Not a recurring task." });
  });

  it("the calendar projects a snoozed task from its old date", async () => {
    const row = { id: 8, title: "Rent", priority: "high", recurrence_rule: "monthly", recurrence_interval: 1, recurrence_anchor_day: 31, due_date: "2027-02-03", snoozed_from: "2027-01-31" };
    const pool = { query: async (sql, params) => {
      if (/recurring = true AND completed = false/.test(sql)) { assert.match(sql, /snoozed_from/); return { rows: [row] }; }
      if (/due_date as event_date/.test(sql)) return { rows: params[0] === "2027-02-01" ? [{ id: 8, title: "Rent", event_date: "2027-02-03", priority: "high", type: "todo" }] : [] };
      return { rows: [] };
    } };
    const app = appWith(require("../routes/calendar")({ pool, config, helpers }));
    const feb = (await supertest(app).get("/api/calendar?month=2&year=2027").expect(200)).body;
    assert.deepEqual(feb.filter((e) => e.recurring_projection).map((e) => e.event_date), ["2027-02-28"]);
    const mar = (await supertest(app).get("/api/calendar?month=3&year=2027").expect(200)).body;
    assert.deepEqual(mar.filter((e) => e.recurring_projection).map((e) => e.event_date), ["2027-03-31"]);
    const jan = (await supertest(app).get("/api/calendar?month=1&year=2027").expect(200)).body;
    assert.deepEqual(jan.filter((e) => e.recurring_projection), [], "the old date is this instance itself, not a projection");
  });
});

// ---------------------------------------------------------------------------
// F53
// ---------------------------------------------------------------------------
describe("F53 — a profile save clears fit scores only when its text changed", () => {
  it("profileTextChanged compares only the text the request sent", () => {
    const c = jobs.profileTextChanged;
    assert.equal(c({ resume_text: "A", preferences_text: "B" }, { resume_text: "A", preferences_text: "B" }), false);
    assert.equal(c({ resume_text: "A2", preferences_text: "B" }, { resume_text: "A", preferences_text: "B" }), true);
    assert.equal(c({ preferences_text: "B2" }, { resume_text: "A", preferences_text: "B" }), true);
    assert.equal(c({}, { resume_text: "A" }), false, "a save without the text fields can't have changed them");
    assert.equal(c({ resume_text: "" }, { resume_text: null }), false, "NULL and empty are the same");
    assert.equal(c({ resume_text: "a\nb" }, { resume_text: "a\r\nb" }), false, "a textarea returns LF for stored CRLF");
  });
  function profileApp(calls, prev) {
    return appWith(jobs({ pool: { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^UPDATE job_profile SET (resume_text|preferences_text|min_salary)/.test(sql)) {
        return { rows: [{ id: 1, resume_text: params[0], min_salary: 150000, prev_resume_text: prev.resume_text, prev_preferences_text: prev.preferences_text }] };
      }
      return { rows: [], rowCount: 0 };
    } } }));
  }
  it("the page's save (both text fields, unchanged, plus a new salary) keeps every fit score", async () => {
    const calls = [];
    const prev = { resume_text: "Ten years of Go", preferences_text: "Remote, staff level" };
    const r = await supertest(profileApp(calls, prev)).patch("/api/job-profile")
      .send({ preferences_text: prev.preferences_text, resume_text: prev.resume_text, remote_pref: "remote", locations: ["NYC"], min_salary: 150000 }).expect(200);
    assert.equal(r.body.rescore_needed, false);
    assert.ok(!calls.some((c) => /profile_embedding = NULL|fit_score = NULL/.test(c.sql)));
    assert.match(calls.find((c) => /^UPDATE job_profile SET/.test(c.sql)).sql, /FROM \(SELECT resume_text AS prev_resume_text, preferences_text AS prev_preferences_text FROM job_profile WHERE id = 1\) p/);
    assert.ok(!("prev_resume_text" in r.body) && !("prev_preferences_text" in r.body), "the previous text isn't echoed");
  });
  it("a changed resume clears the embedding and the scores", async () => {
    const calls = [];
    const r = await supertest(profileApp(calls, { resume_text: "Ten years of Go", preferences_text: "Remote" })).patch("/api/job-profile")
      .send({ preferences_text: "Remote", resume_text: "Ten years of Go and Rust" }).expect(200);
    assert.equal(r.body.rescore_needed, true);
    assert.ok(calls.some((c) => /SET profile_embedding = NULL/.test(c.sql)));
    assert.ok(calls.some((c) => /UPDATE job_listings SET fit_score = NULL, fit_rationale = NULL/.test(c.sql)));
  });
});

// ---------------------------------------------------------------------------
// F50
// ---------------------------------------------------------------------------
describe("F50 — a privacy value on the line after its key", () => {
  const tier = (fm) => vault.resolveSensitivity(vault.parseFrontmatter("---\n" + fm + "\n---\nbody").meta);
  it("an indented value under an empty privacy key is that key's value", () => {
    assert.equal(tier("sensitivity:\n  secret"), "secret");
    assert.equal(tier("sensitivity:\n  private\ntitle: x"), "private");
    assert.equal(tier("embed:\n  false"), "private");
    assert.equal(tier("private:\n  yes"), "private");
    assert.equal(tier("sensitivity:\n  # the tier\n  secret"), "secret", "a comment line between them is skipped");
  });
  it("a block list after a blank line is still that key's list", () => {
    assert.equal(tier("sensitivity:\n\n  - secret"), "secret");
    assert.equal(tier("sensitivity:\n\n- private"), "private");
    assert.deepEqual(vault.parseFrontmatter("---\ntags:\n\n  - a\n  - b\ntitle: x\n---\nb").meta, { tags: ["a", "b"], title: "x" });
  });
  it("anything else under an empty privacy key fails closed", () => {
    assert.equal(tier("sensitivity:\n  level: secret"), "private");
    assert.equal(tier("sensitivity:\n  -secret"), "private");
    assert.equal(tier("sensitivity:\n  publicish"), "private");
  });
  it("a truly empty key, a normal value and an explicit opt-in stay normal", () => {
    assert.equal(tier("sensitivity:"), "normal");
    assert.equal(tier("sensitivity:\ntitle: x"), "normal");
    assert.equal(tier("sensitivity:\n  normal"), "normal");
    assert.equal(tier("embed:\n  true"), "normal");
    assert.equal(tier("title: x\ntags:\n  - a"), "normal");
  });
  it("the parse version moved, so the operator checks ask for one full reindex", () => {
    assert.equal(vault.VAULT_PARSE_VERSION, 4);
  });
});

// ---------------------------------------------------------------------------
// F54
// ---------------------------------------------------------------------------
describe("F54 — past-due scheduled emails while SMTP isn't set up", () => {
  it("waitingEmails: no query with SMTP set, null when nothing waits, the count and oldest otherwise", async () => {
    let queries = 0;
    const pool = (row) => ({ query: async (sql) => { queries++; assert.match(sql, /status = 'scheduled' AND scheduled_at <= now\(\)/); return { rows: [row] }; } });
    assert.equal(await notifRoutes.waitingEmails(pool({ n: 3 }), { SMTP_HOST: "smtp.example" }), null);
    assert.equal(queries, 0);
    assert.equal(await notifRoutes.waitingEmails(pool({ n: 0, oldest: null }), {}), null);
    assert.deepEqual(await notifRoutes.waitingEmails(pool({ n: 3, oldest: "2026-11-01T08:00:00Z" }), {}), { count: 3, oldest: "2026-11-01T08:00:00Z" });
    assert.equal(await notifRoutes.waitingEmails({ query: async () => { throw new Error("down"); } }, {}), null, "fail-soft");
  });
  it("the notification check lists them as an email problem, once per count", async () => {
    const saved = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      const pool = { query: async (sql) => (/status = 'scheduled' AND scheduled_at <= now\(\)/.test(sql)
        ? { rows: [{ n: 2, oldest: "2026-11-01T08:00:00Z" }] } : { rows: [] }) };
      const body = (await supertest(appWith(notifRoutes({ pool }))).get("/api/notifications/check").expect(200)).body;
      const n = body.notifications.find((x) => x.id === "smtp-not-configured");
      assert.equal(n.type, "email_failed");
      assert.equal(n.title, "2 scheduled emails are waiting since 2026-11-01 — email sending isn't set up (SMTP_HOST)");
      assert.equal(n.entity, "email");
      assert.equal(body.counts.email_waiting, 2);
      process.env.SMTP_HOST = "smtp.example";
      const ok = (await supertest(appWith(notifRoutes({ pool }))).get("/api/notifications/check").expect(200)).body;
      assert.equal(ok.notifications.find((x) => x.id === "smtp-not-configured"), undefined);
      assert.equal(ok.counts.email_waiting, 0);
    } finally {
      if (saved === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// F56
// ---------------------------------------------------------------------------
describe("F56 — a todo made from a note never carries private or secret text", () => {
  it("todoFieldsFromNote by tier", () => {
    const f = linksRoutes.todoFieldsFromNote;
    assert.deepEqual(f({ title: null, content: "Buy milk and eggs", sensitivity: "normal" }), { title: "Buy milk and eggs", description: "Buy milk and eggs" });
    assert.deepEqual(f({ title: "Bank", content: "PIN 4321", sensitivity: "secret" }), { title: "Bank", description: null });
    assert.deepEqual(f({ title: null, content: "PIN 4321", sensitivity: "secret" }), { title: "Secret note", description: null });
    assert.deepEqual(f({ title: null, content: "Therapy notes", sensitivity: "private" }), { title: "Private note", description: null });
    assert.deepEqual(f({ title: null, content: "x", sensitivity: "something-new" }), { title: "Private note", description: null }, "an unknown tier is not normal");
    assert.deepEqual(f({ title: null, content: "plain" }), { title: "plain", description: "plain" }, "a row from before the tier existed");
  });
  it("the route inserts those fields and still links the todo to the note", async () => {
    const calls = [];
    db.pool.query = async () => ({ rows: [] }); // announceTodoEvent's lookups
    const pool = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT \* FROM notes/.test(sql)) return { rows: [{ id: 4, title: null, content: "The safe code is 99-12-45", sensitivity: "secret" }] };
      if (/^INSERT INTO todos/.test(sql)) return { rows: [{ id: 70, title: params[0], description: params[1] }] };
      return { rows: [] };
    } };
    const r = await supertest(appWith(linksRoutes({ pool }))).post("/api/notes/4/create-todo").send({}).expect(200);
    assert.deepEqual([r.body.title, r.body.description], ["Secret note", null]);
    const ins = calls.find((c) => /^INSERT INTO todos/.test(c.sql));
    assert.ok(!JSON.stringify(ins.params).includes("99-12-45"));
    assert.ok(calls.some((c) => /INSERT INTO entity_links/.test(c.sql) && c.params[0] === 4 && c.params[1] === 70));
    await settle();
  });
});

// ---------------------------------------------------------------------------
// F58
// ---------------------------------------------------------------------------
describe("F58 — the finance gate, Slack failures and the briefing's job line", () => {
  it("ordinary words don't open the finance gate", () => {
    for (const q of ["Bill's phone number", "bill’s birthday", "my GitHub account", "which account do I use for the forum",
      "when does my passport renewal come up", "extra credit for the course", "what is $PATH set to", "what's my passport number", "when is my dentist appointment"]) {
      assert.equal(looksFinancial(q), false, q);
    }
  });
  it("money questions still do", () => {
    for (const q of ["can I afford my insurance renewal?", "what's my credit card balance", "how much do I spend on subscriptions", "is $500 too much",
      "how much is the phone bill", "what bills are due this week", "what's in my checking account", "my accounts total", "what is my net worth",
      "did I pay the electric bill", "what's my mortgage rate", "my credit limit", "how much is my bill"]) {
      assert.equal(looksFinancial(q), true, q);
    }
  });

  it("a refused or failed Slack post is logged — without the URL", async () => {
    const logged = [];
    console.error = (...a) => { logged.push(a.join(" ")); };
    db.pool.query = async () => ({ rows: [{ slack_webhook_url: "https://hooks.example/services/T000/SECRET" }] });
    dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    global.fetch = async () => ({ ok: false, status: 404 });
    await helpers.sendSlackNotification("hi");
    global.fetch = async () => { throw new TypeError("fetch failed"); };
    await helpers.sendSlackNotification("hi");
    global.fetch = async () => ({ ok: true, status: 200 });
    await helpers.sendSlackNotification("hi");
    assert.deepEqual(logged, ["sendSlackNotification: Slack answered 404", "sendSlackNotification failed: TypeError"]);
    assert.ok(!logged.join(" ").includes("SECRET"));
  });

  describe("the daily briefing", () => {
    const saved = { b: ai.getAiBudgetCents, s: ai.monthlyAiSpendCents, r: ai.recordAiUsage, c: ai.callAIWithUsage, key: process.env.ANTHROPIC_API_KEY, g: jobs.gatherJobRadarSummary };
    let prompts;
    beforeEach(() => {
      prompts = [];
      process.env.ANTHROPIC_API_KEY = "test-key";
      db.pool.query = async () => ({ rows: [{ model: "haiku" }] });
      ai.getAiBudgetCents = async () => 100;
      ai.monthlyAiSpendCents = async () => 0;
      ai.recordAiUsage = async () => 0;
      ai.callAIWithUsage = async (model, prompt) => { prompts.push(prompt); return { text: "Busy day.", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }; };
      ai.setCache(`briefing_${todayStr()}`, null);
    });
    afterEach(() => {
      ai.getAiBudgetCents = saved.b; ai.monthlyAiSpendCents = saved.s; ai.recordAiUsage = saved.r; ai.callAIWithUsage = saved.c;
      jobs.gatherJobRadarSummary = saved.g;
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
      ai.setCache(`briefing_${todayStr()}`, null);
    });
    const briefingApp = () => appWith(require("../routes/ai")({ pool: { query: async () => ({ rows: [{ job_radar_enabled: true }], rowCount: 1 }) } }));

    it("says nothing about Job Radar when the only high-fit roles are saved ones", async () => {
      jobs.gatherJobRadarSummary = async () => ({ counts: { main: 3, main_new: 0 }, top_pick: { title: "Saved role", company: "Acme" }, top_new: null });
      await supertest(briefingApp()).get("/api/ai/daily-briefing").expect(200);
      assert.equal(prompts.length, 1);
      assert.doesNotMatch(prompts[0], /Job Radar/);
    });
    it("counts and names the NEW roles", async () => {
      jobs.gatherJobRadarSummary = async () => ({ counts: { main: 3, main_new: 1 }, top_pick: { title: "Saved role", company: "Acme" }, top_new: { title: "Staff Engineer", company: "Globex" } });
      await supertest(briefingApp()).get("/api/ai/daily-briefing").expect(200);
      assert.match(prompts[0], /Job Radar: 1 new high-fit role\(s\); top: Staff Engineer @ Globex/);
      assert.doesNotMatch(prompts[0], /Saved role/);
    });
  });
});

// ---------------------------------------------------------------------------
// F65
// ---------------------------------------------------------------------------
describe("F65 — the dashboard mini-calendar reads the API's event_date", () => {
  const DASH = require("../pages/dashboard-script");
  function calendar(events, month, year) {
    const els = { "mini-cal-grid": { innerHTML: "", querySelectorAll: () => [] }, "mini-cal-title": { textContent: "" }, "mini-cal-events": { innerHTML: "" } };
    const ctx = vm.createContext({
      Date, String, parseInt, isNaN,
      document: { getElementById: (id) => els[id] || null },
      fetch: async (url) => ({ json: async () => { ctx.requested = url; return events; } }),
      esc: (s) => String(s),
      emptyState: (o) => "EMPTY:" + o.title,
      miniCalMonth: month, miniCalYear: year, miniCalSelectedDay: 14, miniCalEvents: [],
    });
    vm.runInContext([extractFunction(JS, "parseCalDate"), extractFunction(JS, "ymdOfLocal"), extractFunction(DASH, "calEventDay"),
      extractFunction(DASH, "showMiniCalEvents"), extractFunction(DASH, "renderMiniCal")].join("\n"), ctx);
    return { ctx, els };
  }
  it("marks the day a task is due and lists it", async () => {
    const { ctx, els } = calendar([
      { id: 1, title: "File taxes", event_date: "2027-04-14", type: "todo" },
      { id: 2, title: "Dentist email", event_date: new Date(2027, 3, 20, 9, 30).toISOString(), type: "email" },
    ], 3, 2027);
    await ctx.renderMiniCal();
    assert.equal(ctx.requested, "/api/calendar?month=4&year=2027");
    const cell = (d) => new RegExp('<div data-cal-day="' + d + '" style="([^"]*)">').exec(els["mini-cal-grid"].innerHTML)[1];
    assert.match(cell(14), /text-decoration:underline/);
    assert.match(cell(20), /text-decoration:underline/, "an email on its local day");
    assert.doesNotMatch(cell(15), /underline/);
    assert.match(els["mini-cal-events"].innerHTML, /File taxes/);
    assert.doesNotMatch(els["mini-cal-events"].innerHTML, /EMPTY/);
  });
  it("a day with nothing still says so", async () => {
    const { ctx, els } = calendar([{ id: 1, title: "File taxes", event_date: "2027-04-02", type: "todo" }], 3, 2027);
    await ctx.renderMiniCal();
    assert.equal(els["mini-cal-events"].innerHTML, "EMPTY:Nothing on this day");
  });
  it("calEventDay: a DATE is its own day whatever the zone; nothing for a missing date", () => {
    const ctx = vm.createContext({ Date, String, parseInt, isNaN });
    vm.runInContext([extractFunction(JS, "parseCalDate"), extractFunction(JS, "ymdOfLocal"), extractFunction(DASH, "calEventDay")].join("\n"), ctx);
    assert.equal(ctx.calEventDay({ type: "todo", event_date: "2027-04-14" }), "2027-04-14");
    assert.equal(ctx.calEventDay({ type: "todo", event_date: "2027-04-14T00:00:00.000Z" }), "2027-04-14");
    assert.equal(ctx.calEventDay({ type: "note" }), "");
    assert.equal(ctx.calEventDay(null), "");
  });
});

// ---------------------------------------------------------------------------
// F66
// ---------------------------------------------------------------------------
describe("F66 — the On / Off buttons ask for the other state", () => {
  const SETTINGS = require("../pages/settings-script");
  function handlers() {
    const got = {}, sent = [];
    const ctx = vm.createContext({
      parseInt,
      onDelegate: (id, _ev, _sel, fn) => { got[id] = fn; },
      toggleAutomation: (id, enabled) => sent.push(["automation", id, enabled]),
      toggleWebhook: (id, enabled) => sent.push(["webhook", id, enabled]),
      editAutomation() {}, editWebhook() {}, testWebhook() {},
    });
    vm.runInContext(extractCall(SETTINGS, "onDelegate('automations-list'") + extractCall(SETTINGS, "onDelegate('webhooks-list'"), ctx);
    return { got, sent };
  }
  it("an enabled rule's button switches it off, a disabled one's on", () => {
    const { got, sent } = handlers();
    got["automations-list"].call({ dataset: { action: "toggle-auto", id: "3", enabled: "true" } });
    got["automations-list"].call({ dataset: { action: "toggle-auto", id: "4", enabled: "false" } });
    got["webhooks-list"].call({ dataset: { action: "toggle-wh", id: "5", enabled: "true" } });
    got["webhooks-list"].call({ dataset: { action: "toggle-wh", id: "6", enabled: "false" } });
    assert.deepEqual(sent, [["automation", 3, false], ["automation", 4, true], ["webhook", 5, false], ["webhook", 6, true]]);
  });
});

// ---------------------------------------------------------------------------
// F67 / F72 (emails page)
// ---------------------------------------------------------------------------
describe("F67 / F72 — the Emails page", () => {
  const html = renderPage("emails");
  it("Use template opens the compose form WITH the template", async () => {
    const els = {};
    const el = (id) => (els[id] = els[id] || { value: "stale", textContent: "", style: {}, classList: { add(c) { this.on = c; } }, remove() { this.removed = true; } });
    const ctx = vm.createContext({
      document: { getElementById: el },
      fetch: async () => ({ json: async () => [{ id: 2, name: "Follow-up", subject: "Following up", body: "Hi,\nJust checking in." }] }),
    });
    vm.runInContext(extractFunction(html, "openCompose") + "\n" + extractFunction(html, "useTemplate"), ctx);
    await ctx.useTemplate(2);
    assert.equal(els["e-subject"].value, "Following up");
    assert.equal(els["e-body"].value, "Hi,\nJust checking in.");
    assert.equal(els["e-email"].value, "", "the rest of the form is reset");
    assert.equal(els["compose-modal"].classList.on, "active");
    assert.equal(els["tpl-modal"].removed, true);
  });
  it("Quick Send's recipient is the name, not the word \"to\"", () => {
    const ctx = vm.createContext({ String });
    vm.runInContext(extractFunction(html, "quickRecipient"), ctx);
    assert.equal(ctx.quickRecipient("email to Bob about the invoice"), "Bob");
    assert.equal(ctx.quickRecipient("email Bob about the invoice"), "Bob");
    assert.equal(ctx.quickRecipient("send to mom tomorrow"), "mom");
    assert.equal(ctx.quickRecipient("remind me to email Sara on friday"), "Sara");
    assert.equal(ctx.quickRecipient("follow up about the invoice"), null);
  });
  it("a weekday is matched as a whole word", () => {
    const ctx = vm.createContext({ Date, parseInt });
    vm.runInContext(extractFunction(html, "parseTimeExpr"), ctx);
    const day = (text) => { const d = ctx.parseTimeExpr(text); return d ? d.getDay() : null; };
    // "wedding" used to schedule Wednesday, "money" Monday, "friend" Friday.
    for (const text of ["email Sam about the wedding at 9am", "money for the trip at 9am", "a friend at 9am"]) {
      const d = ctx.parseTimeExpr(text);
      if (d) assert.equal(d.toDateString(), new Date().toDateString(), text + " — no weekday shift");
    }
    assert.equal(day("email on wed at 9am"), 3);
    assert.equal(day("email next Friday morning"), 5);
  });
});

// ---------------------------------------------------------------------------
// F68
// ---------------------------------------------------------------------------
describe("F68 — ticking a note's bulk checkbox doesn't open the note", () => {
  it("the page's click handler ignores a click on the checkbox", () => {
    const html = renderPage("notes");
    const at = html.indexOf("if(act==='open-note')");
    const start = html.lastIndexOf("document.addEventListener('click'", at);
    const listeners = [], opened = [];
    const ctx = vm.createContext({
      parseInt,
      document: { addEventListener: (ev, fn) => listeners.push(fn) },
      openEditNote: (id) => opened.push(id),
      removeTag() {},
    });
    vm.runInContext(extractCall(html.slice(start), "document.addEventListener('click'"), ctx);
    const card = { dataset: { action: "open-note", id: "12" } };
    const click = (onCheckbox) => listeners[0]({ target: { closest: (sel) => (sel === ".note-bulk-check" ? (onCheckbox ? {} : null) : card) } });
    click(true);
    assert.deepEqual(opened, []);
    click(false);
    assert.deepEqual(opened, [12]);
  });
});

// ---------------------------------------------------------------------------
// F69
// ---------------------------------------------------------------------------
describe("F69 — single-key shortcuts are the key alone", () => {
  function keydownOf(src, near, sandbox) {
    const at = src.indexOf(near);
    assert.ok(at >= 0, near);
    const start = src.lastIndexOf("document.addEventListener('keydown'", at);
    const listeners = [];
    const ctx = vm.createContext({ document: { addEventListener: (ev, fn) => listeners.push(fn), getElementById: () => ({ focus() {} }) }, ...sandbox });
    vm.runInContext(extractCall(src.slice(start), "document.addEventListener('keydown'"), ctx);
    return (key, mods = {}) => { const e = { key, target: { tagName: "DIV" }, prevented: false, preventDefault() { this.prevented = true; }, ...mods }; listeners[0](e); return e; };
  }
  it("the dashboard: Cmd/Ctrl+C and Cmd/Ctrl+R are the browser's", () => {
    const location = { href: "" };
    const press = keydownOf(require("../pages/dashboard-script"), "location.href = BP + '/calendar'", { location, BP: "" });
    press("c", { metaKey: true }); press("c", { ctrlKey: true }); press("r", { ctrlKey: true }); press("n", { altKey: true });
    assert.equal(location.href, "");
    press("c");
    assert.equal(location.href, "/calendar");
  });
  it("Today: Cmd/Ctrl+R reloads the page instead of the list", () => {
    let loads = 0;
    const press = keydownOf(renderPage("today"), "if (e.key === 'r' || e.key === 'R') { e.preventDefault(); load(); }", { load: () => { loads++; } });
    assert.equal(press("r", { metaKey: true }).prevented, false);
    assert.equal(press("r", { ctrlKey: true }).prevented, false);
    assert.equal(loads, 0);
    assert.equal(press("r").prevented, true);
    assert.equal(loads, 1);
  });
  it("To-Dos: Cmd/Ctrl+N doesn't open the Add dialog", () => {
    let opened = 0;
    const press = keydownOf(require("../pages/todos-script-2"), "openQuickTodo(); }\n});", { openAdd: () => { opened++; }, openQuickTodo() {} });
    press("n", { metaKey: true }); press("n", { ctrlKey: true });
    assert.equal(opened, 0);
    press("n");
    assert.equal(opened, 1);
  });
});

// ---------------------------------------------------------------------------
// F70 / F71 (settings page)
// ---------------------------------------------------------------------------
describe("F70 — the Theme select changes the page", () => {
  const SETTINGS = require("../pages/settings-script");
  function page({ stored = null, systemDark = false } = {}) {
    const store = stored ? { "ps-ui": JSON.stringify(stored) } : {};
    const body = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    const toggle = { textContent: "" };
    const ctx = vm.createContext({
      JSON,
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
      window: { matchMedia: (q) => ({ matches: /dark/.test(q) ? systemDark : !systemDark }) },
      document: { body, getElementById: (id) => (id === "mode-toggle" ? toggle : null) },
    });
    vm.runInContext(extractFunction(SETTINGS, "applyTheme") + "\n" + extractFunction(SETTINGS, "currentTheme"), ctx);
    return { ctx, store, body, toggle };
  }
  it("Night / Day set the mode the stylesheet reads and remember it with the palette", () => {
    const p = page({ stored: { palette: "forest", mode: "light" } });
    p.ctx.applyTheme("dark");
    assert.equal(p.body.attrs["data-mode"], "dark");
    assert.deepEqual(JSON.parse(p.store["ps-ui"]), { palette: "forest", mode: "dark" });
    assert.equal(p.toggle.textContent, "Dark");
    p.ctx.applyTheme("light");
    assert.equal(p.body.attrs["data-mode"], "light");
  });
  it("Auto follows the system setting and is stored as auto", () => {
    const dark = page({ systemDark: true });
    dark.ctx.applyTheme("auto");
    assert.equal(dark.body.attrs["data-mode"], "dark");
    assert.equal(JSON.parse(dark.store["ps-ui"]).mode, "auto");
    const light = page({ systemDark: false });
    light.ctx.applyTheme("auto");
    assert.equal(light.body.attrs["data-mode"], "light");
  });
  it("the select shows this browser's choice, else the stored setting", () => {
    assert.equal(page({ stored: { mode: "dark" } }).ctx.currentTheme("light"), "dark");
    assert.equal(page({ stored: { mode: "auto" } }).ctx.currentTheme("dark"), "auto");
    assert.equal(page().ctx.currentTheme("dark"), "dark");
    assert.equal(page().ctx.currentTheme(undefined), "light");
    assert.equal(page({ stored: { palette: "plum" } }).ctx.currentTheme("auto"), "auto");
  });
  it("loading the settings no longer repaints the page from the server's value", () => {
    const load = extractFunction(SETTINGS, "load");
    assert.doesNotMatch(load, /applyTheme\(/);
    assert.match(load, /getElementById\('s-theme'\)\.value = currentTheme\(s\.theme\)/);
  });
  it("every page paints Auto from the system setting (views.js themeScript)", () => {
    const script = views.themeScript();
    const mk = (dark) => { const c = vm.createContext({ window: { matchMedia: () => ({ matches: dark }) } }); vm.runInContext(extractFunction(script, "effectiveMode"), c); return c.effectiveMode; };
    assert.deepEqual([mk(true)("auto"), mk(false)("auto"), mk(false)("dark"), mk(true)("light"), mk(true)(undefined)], ["dark", "light", "dark", "light", "light"]);
    assert.match(script, /function applyMode\(m\) \{ document\.body && document\.body\.setAttribute\('data-mode', effectiveMode\(m\)\); \}/);
    assert.match(script, /s\.theme === 'dark' \|\| s\.theme === 'light' \|\| s\.theme === 'auto'/);
  });
});

describe("F71 — a refused vault setting is shown", () => {
  it("the error is written with the visible error class", async () => {
    const SETTINGS = require("../pages/settings-script");
    const status = { className: "status-msg", textContent: "" };
    const els = { status, "vault-enabled": { checked: true }, "vault-repo": { value: "https://github.com/me/vault" }, "vault-branch": { value: "main" } };
    let reloaded = 0;
    const ctx = vm.createContext({
      JSON, setTimeout: () => {},
      settingsReady: () => true,
      loadVaultStatus: () => { reloaded++; },
      document: { getElementById: (id) => els[id] },
      fetch: async () => ({ json: async () => ({ error: "vault_repo must look like owner/name." }) }),
    });
    vm.runInContext(extractFunction(SETTINGS, "saveVault"), ctx);
    await ctx.saveVault();
    assert.equal(status.className, "status-msg error");
    assert.equal(status.textContent, "vault_repo must look like owner/name.");
    assert.equal(reloaded, 0);
  });
});

// ---------------------------------------------------------------------------
// F72 (Quick Add)
// ---------------------------------------------------------------------------
describe("F72 — Quick Add reads a month and a day as the next such date", () => {
  const src = require("../pages/todos-script-2");
  const ctx = vm.createContext({ Date, String, parseInt });
  vm.runInContext(extractFunction(src, "quickMonthDay"), ctx);
  const day = (input, now) => { const d = ctx.quickMonthDay(input, now); return d ? d.toISOString().slice(0, 10) : null; };
  const NOV = new Date(2026, 10, 19);
  it("\"jan 5\" in November is next January, not the year 2001", () => {
    assert.equal(day("dentist jan 5", NOV), "2027-01-05");
    assert.equal(day("party December 25", NOV), "2026-12-25");
    assert.equal(day("report nov 19", NOV), "2026-11-19", "today is still this year");
    assert.equal(day("report nov 18", NOV), "2027-11-18", "yesterday's date is next year's");
  });
  it("an explicit year, ordinals and short forms", () => {
    assert.equal(day("renew passport Mar 3rd, 2028", NOV), "2028-03-03");
    assert.equal(day("call on sept. 9", NOV), "2027-09-09");
    assert.equal(day("trip june 30 2027", NOV), "2027-06-30");
  });
  it("not a date: a word that only starts like a month, a day the month lacks, no month", () => {
    assert.equal(day("market 5 stalls", NOV), null);
    assert.equal(day("pay feb 30", NOV), null);
    assert.equal(day("buy milk", NOV), null);
  });
  it("parseQuickTodo uses it, and an ISO date still wins", () => {
    const el = { value: "dentist jan 5", innerHTML: "", style: {} };
    const document = { getElementById: (id) => (id === "qt-input" ? el : { innerHTML: "", style: {} }) };
    const c = vm.createContext({ Date, String, parseInt, document });
    vm.runInContext("var parsedTodo = null;\n" + extractFunction(src, "quickMonthDay") + "\n" + extractFunction(src, "parseQuickTodo") + "\nfunction esc(s){return String(s);}", c);
    c.parseQuickTodo();
    const due = c.parsedTodo.due_date;
    assert.match(due, /^\d{4}-01-05$/);
    assert.ok(Number(due.slice(0, 4)) >= new Date().getFullYear(), "never 2001");
    el.value = "file taxes 2027-04-15";
    c.parseQuickTodo();
    assert.equal(c.parsedTodo.due_date, "2027-04-15");
  });
});
