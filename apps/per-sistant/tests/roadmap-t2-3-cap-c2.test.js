// ============================================================================
// Roadmap T2.3 C2 — the nine routes/ai.js features on the capped wrapper
// ============================================================================
// Every feature runs through ai.cappedAI with its own entry_type: under the cap
// one model call and one charged ai_usage row; over it the seven action routes
// answer 429 { ai_cap } with no data query and no model call (their 400s and
// the 501 still first), an unreadable spend answers 503, and Ask / Smart
// Suggestions keep their 200 shapes with ai_cap. Cache hits make no call, no
// cap read and no charge. Smart Suggestions' day is the APP_TIMEZONE date. A
// source guard: no routes/*.js file calls callAI / answerWithCitations
// directly (KNOWN_GAPS shrinks — C3 empties it).
// ============================================================================
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ai = require("../ai");
const db = require("../db");
const { todayStr } = require("../routes/health");

const saved = {
  b: ai.getAiBudgetCents, s: ai.monthlyAiSpendCents, r: ai.recordAiUsage, c: ai.callAIWithUsage,
  q: db.pool.query, key: process.env.ANTHROPIC_API_KEY, tz: process.env.APP_TIMEZONE,
};
let state;
beforeEach(() => {
  state = { budget: 100, spent: 0, spentThrows: false, charged: [], calls: [], capReads: 0, reply: "ok" };
  process.env.ANTHROPIC_API_KEY = "test-key";
  db.pool.query = async () => ({ rows: [{ model: "haiku" }] }); // getAIModelForFeature
  ai.getAiBudgetCents = async () => state.budget;
  ai.monthlyAiSpendCents = async () => { state.capReads++; if (state.spentThrows) throw new Error("db down"); return state.spent; };
  ai.recordAiUsage = async (_p, row) => { state.charged.push(row); return 0; };
  ai.callAIWithUsage = async (model, prompt, maxTokens, system) => {
    state.calls.push({ model, prompt, maxTokens, system });
    return { text: typeof state.reply === "function" ? state.reply(prompt) : state.reply, usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" };
  };
  // A cached briefing / suggestion from an earlier test must not leak in.
  const today = todayStr();
  ai.setCache(`briefing_${today}`, null);
  ai.setCache(`suggestions_${today}_${new Date().getHours()}`, null);
});
afterEach(() => {
  ai.getAiBudgetCents = saved.b; ai.monthlyAiSpendCents = saved.s; ai.recordAiUsage = saved.r; ai.callAIWithUsage = saved.c;
  db.pool.query = saved.q;
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.tz === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = saved.tz;
});

function appFor(rows = []) {
  const queries = [];
  const pool = { query: async (sql) => { queries.push(sql); return { rows, rowCount: rows.length }; } };
  const app = express();
  app.use(express.json());
  app.use(require("../routes/ai")({ pool }));
  return { app, queries };
}
const send = (app, [method, url, body]) => { const r = supertest(app)[method](url); return body ? r.send(body) : r; };

// [request, entry_type, model reply, expected body check]
const ROUTES = [
  [["post", "/api/ai/draft-email", { prompt: "ask for the invoice" }], "email_draft", '{"subject":"Invoice","body":"Hi"}', (b) => assert.equal(b.subject, "Invoice")],
  [["post", "/api/ai/task-breakdown", { title: "Move house" }], "task_breakdown", '["Pack","Book van"]', (b) => assert.deepEqual(b.subtasks, ["Pack", "Book van"])],
  [["post", "/api/ai/parse-todo", { input: "pay rent asap" }], "quick_add", '{"title":"Pay rent","priority":"urgent"}', (b) => assert.equal(b.priority, "urgent")],
  [["post", "/api/ai/review-summary", { stats: { tasks_completed: 3 } }], "review_summary", "A good week.", (b) => assert.equal(b.summary, "A good week.")],
  [["post", "/api/ai/adjust-tone", { body: "hey", tone: "more formal" }], "email_tone", "Dear Sir", (b) => assert.equal(b.body, "Dear Sir")],
  [["get", "/api/ai/daily-briefing", null], "daily_briefing", "Busy day.", (b) => assert.equal(b.briefing, "Busy day.")],
  [["post", "/api/ai/suggest-tags", { content: "meeting notes" }], "note_tagging", '["meeting"]', (b) => assert.deepEqual(b.tags, ["meeting"])],
];
const ACTION = ROUTES.map((r) => r[0]);
const TODO = { id: 7, title: "File taxes", priority: "high", horizon: "short", category: null, due_date: null, recurring: false, recurrence_rule: null, streak_count: 0 };

describe("under the cap: one call, one charged row per feature", () => {
  it("each action route charges its own entry_type and answers as before", async () => {
    for (const [req, entry_type, reply, check] of ROUTES) {
      state.charged = []; state.calls = []; state.reply = reply;
      const { app } = appFor();
      const r = await send(app, req);
      assert.equal(r.status, 200, req[1]);
      check(r.body);
      assert.equal(state.calls.length, 1, req[1]);
      assert.equal(state.calls[0].model, "haiku");
      assert.deepEqual(state.charged.map((c) => [c.entry_type, c.model]), [[entry_type, "haiku"]], req[1]);
    }
  });

  it("Ask charges natural_language_query", async () => {
    state.reply = "You have 2 overdue tasks.";
    const { app } = appFor();
    const r = await supertest(app).post("/api/ai/query").send({ query: "how many overdue?" }).expect(200);
    assert.equal(r.body.answer, "You have 2 overdue tasks.");
    assert.equal(r.body.ai_cap, undefined);
    assert.deepEqual(state.charged.map((c) => c.entry_type), ["natural_language_query"]);
  });

  it("Smart Suggestions charges smart_suggestions", async () => {
    state.reply = '[{"suggestion":"Do taxes","task_ids":[7]}]';
    const { app } = appFor([TODO]);
    const r = await supertest(app).get("/api/ai/smart-suggestions").expect(200);
    assert.equal(r.body.suggestions[0].suggestion, "Do taxes");
    assert.deepEqual(state.charged.map((c) => c.entry_type), ["smart_suggestions"]);
  });
});

describe("over the cap", () => {
  it("the seven action routes answer 429 with the budget — no data query, no model call, nothing charged", async () => {
    state.spent = 100;
    for (const req of ACTION) {
      const { app, queries } = appFor([TODO]);
      const r = await send(app, req);
      assert.equal(r.status, 429, req[1]);
      assert.equal(r.body.ai_cap, true, req[1]);
      assert.equal(r.body.error, "Monthly AI budget reached ($1.00 of $1.00) — raise it in Settings → AI.", req[1]);
      assert.deepEqual(queries, [], req[1] + " ran a data query");
    }
    assert.equal(state.calls.length, 0);
    assert.equal(state.charged.length, 0);
  });

  it("the 400s and the 501 still come first", async () => {
    state.spent = 500;
    const { app } = appFor();
    await supertest(app).post("/api/ai/draft-email").send({}).expect(400);
    await supertest(app).post("/api/ai/suggest-tags").send({ content: "x", sensitivity: "secret" }).expect(400);
    delete process.env.ANTHROPIC_API_KEY;
    const r = await supertest(app).post("/api/ai/task-breakdown").send({ title: "x" }).expect(501);
    assert.equal(r.body.ai_unavailable, true);
    assert.equal(state.capReads, 0, "no cap read before a 400 / 501");
  });

  it("Ask keeps its 200 shape: the answer says the budget is reached, ai_cap, no query", async () => {
    state.spent = 250;
    const { app, queries } = appFor();
    const r = await supertest(app).post("/api/ai/query").send({ query: "what's due?" }).expect(200);
    assert.deepEqual(r.body, { answer: "Monthly AI budget reached ($2.50 of $1.00) — raise it in Settings → AI.", data: null, ai_cap: true });
    assert.deepEqual(queries, []);
    assert.equal(state.calls.length, 0);
  });

  it("Smart Suggestions keeps its 200 shape: suggestions null + ai_cap, no query", async () => {
    state.spent = 100;
    const { app, queries } = appFor([TODO]);
    const r = await supertest(app).get("/api/ai/smart-suggestions").expect(200);
    assert.equal(r.body.suggestions, null);
    assert.equal(r.body.ai_cap, true);
    assert.deepEqual(queries, []);
    assert.equal(state.calls.length, 0);
  });

  it("a cap reached between the gate and the call (a concurrent call) still answers 429, not 500", async () => {
    // The gate reads 0, the wrapper's own check reads 100.
    let n = 0;
    ai.monthlyAiSpendCents = async () => (n++ === 0 ? 0 : 100);
    const { app } = appFor();
    const r = await supertest(app).get("/api/ai/daily-briefing").expect(429);
    assert.equal(r.body.ai_cap, true);
    assert.equal(state.calls.length, 0);
  });
});

describe("an unreadable spend refuses the call", () => {
  it("action routes answer 503 with no model call", async () => {
    state.spentThrows = true;
    const orig = console.error; console.error = () => {};
    try {
      for (const req of ACTION) {
        const { app, queries } = appFor();
        const r = await send(app, req);
        assert.equal(r.status, 503, req[1]);
        assert.equal(r.body.ai_cap_check_failed, true);
        assert.match(r.body.error, /couldn't be checked/);
        assert.deepEqual(queries, []);
      }
      const { app } = appFor([TODO]);
      const a = await supertest(app).post("/api/ai/query").send({ query: "q" }).expect(200);
      assert.equal(a.body.ai_cap_check_failed, true);
      assert.match(a.body.answer, /couldn't be checked/);
      const s = await supertest(app).get("/api/ai/smart-suggestions").expect(200);
      assert.equal(s.body.suggestions, null);
      assert.equal(s.body.ai_cap_check_failed, true);
    } finally { console.error = orig; }
    assert.equal(state.calls.length, 0);
  });
});

describe("cache hits are free", () => {
  it("a cached briefing: no cap read, no query, no call, no charge — even over the cap", async () => {
    ai.setCache(`briefing_${todayStr()}`, "Cached briefing.");
    state.spent = 999;
    const { app, queries } = appFor();
    const r = await supertest(app).get("/api/ai/daily-briefing").expect(200);
    assert.equal(r.body.briefing, "Cached briefing.");
    assert.equal(state.capReads, 0);
    assert.deepEqual(queries, []);
    assert.equal(state.calls.length + state.charged.length, 0);
  });

  it("a second briefing within 10 minutes reuses the first answer", async () => {
    state.reply = "Fresh briefing.";
    const { app } = appFor();
    await supertest(app).get("/api/ai/daily-briefing").expect(200);
    const r = await supertest(app).get("/api/ai/daily-briefing").expect(200);
    assert.equal(r.body.briefing, "Fresh briefing.");
    assert.equal(state.calls.length, 1);
    assert.equal(state.charged.length, 1);
  });

  it("cached suggestions: no cap read, no query, no call", async () => {
    ai.setCache(`suggestions_${todayStr()}_${new Date().getHours()}`, [{ suggestion: "cached", task_ids: [] }]);
    state.spent = 999;
    const { app, queries } = appFor([TODO]);
    const r = await supertest(app).get("/api/ai/smart-suggestions").expect(200);
    assert.equal(r.body.suggestions[0].suggestion, "cached");
    assert.equal(state.capReads, 0);
    assert.deepEqual(queries, []);
    assert.equal(state.calls.length, 0);
  });
});

describe("Smart Suggestions uses the APP_TIMEZONE day", () => {
  // APP_TIMEZONE is read when config loads, so each zone runs in a child process.
  const CHILD = `
    const ai = require("./ai"); const db = require("./db");
    db.pool.query = async () => ({ rows: [{ model: "haiku" }] });
    ai.getAiBudgetCents = async () => 100; ai.monthlyAiSpendCents = async () => 0; ai.recordAiUsage = async () => 0;
    let prompt; ai.callAIWithUsage = async (m, p) => { prompt = p; return { text: "[]", usage: {} }; };
    const express = require("express"); const supertest = require("supertest");
    const app = express(); app.use(require("./routes/ai")({ pool: { query: async () => ({ rows: [${JSON.stringify(TODO)}] }) } }));
    supertest(app).get("/api/ai/smart-suggestions").then(() => { process.stdout.write(JSON.stringify(prompt)); process.exit(0); });`;
  it("the prompt's date and weekday are the zone's, not UTC's", () => {
    const { execFileSync } = require("child_process");
    for (const tz of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
      const out = execFileSync(process.execPath, ["-e", CHILD], {
        cwd: path.join(__dirname, ".."), encoding: "utf8",
        env: { ...process.env, APP_TIMEZONE: tz, ANTHROPIC_API_KEY: "test-key", SESSION_SECRET: "x" },
      });
      const prompt = JSON.parse(out);
      const fmt = (o) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, ...o }).format(new Date());
      const today = fmt({ year: "numeric", month: "2-digit", day: "2-digit" });
      const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date());
      assert.match(prompt, new RegExp(`^Today is ${day}, ${today}\\.`), tz);
    }
  });
});

describe("source guard: routes call the model only through the capped wrappers", () => {
  // Shrinking list: a new direct call fails, and so does a listed file whose
  // count changed without an update here. C3 moves rag.js and empties it.
  const KNOWN_GAPS = { "rag.js": 6 };
  it("no routes/*.js file names callAI / answerWithCitations outside KNOWN_GAPS", () => {
    const dir = path.join(__dirname, "../routes");
    const found = {};
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const code = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      const n = (code.match(/\b(callAI|answerWithCitations)\b/g) || []).length;
      if (n) found[f] = n;
    }
    assert.deepEqual(found, KNOWN_GAPS);
  });
});
