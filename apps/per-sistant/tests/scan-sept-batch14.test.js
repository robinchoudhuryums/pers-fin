// ============================================================================
// Broad-scan (Sept 2026) Batch 14 — Per-sistant correctness & UI
// ============================================================================
// PB-4   a profile edit clears the cached profile embedding + fit scores
// PB-5   trust re-scored for live listings, fit backfilled, stale excluded,
//        unscored fit is "verify first", embeds batched
// PB-6   a 'scam' verdict is hidden; 'suspect' is verify-first
// PB-7   removing a company deactivates it (the boot seed can't revive it)
// PB-9   dismiss doesn't lower the whole source's trust; no re-nudge
// PB-17  service worker: no fake ok, no secret caching, safe replay
// PB-19  outbound fetch timeouts
// PD-5   task location kept on create and on every recurrence
// PD-6   automations: only runnable rules, wired triggers, per-rule isolation
// PD-7   Ask / Smart Suggestions have their own model settings
// PD-9   recipient validated on PATCH, contacts and the cron
// PD-11  iCal escaping, DTSTAMP, all-day DTEND, folding
// PD-12  trashed blockers don't block; longer cycles refused
// PD-13  template validation + transactional apply
// PD-14  weekly review "overdue" = due before today
// PUI-3  no "undo send"; recurring undo removes the generated instance
// PUI-4  Job Radar errors + saved/applied/dismissed views
// PUI-5  keyboard access + modal dialogs
// PUI-6  webhook events validated on PATCH and escaped
// PUI-7  only http(s) apply links
// PUI-8  keep-alive controls hidden when embedded
// ============================================================================

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const config = require("../config");
const db = require("../db");
const helpers = require("../helpers");
const ai = require("../ai");
const embeddings = require("../services/embeddings");
const jobs = require("../routes/jobs");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

function appWith(router, { embedded = false } = {}) {
  const app = express();
  if (embedded) app.set("embedded", true);
  app.use(express.json());
  app.use((req, res, next) => { res.locals.nonce = "n"; next(); });
  app.use(router);
  return app;
}

// Stub the shared db pool (helpers.js / ai.js read it directly).
let realQuery;
function stubDb(fn) { realQuery = realQuery || db.pool.query; db.pool.query = fn; }
afterEach(() => { if (realQuery) { db.pool.query = realQuery; realQuery = null; } });

// ===========================================================================
// Job Radar
// ===========================================================================
describe("PB-4 — a profile change clears the embedding and fit scores", () => {
  function profileApp(calls) {
    return appWith(jobs({ pool: { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^UPDATE job_profile SET resume_text|^UPDATE job_profile SET preferences_text|^UPDATE job_profile SET min_salary/.test(sql)) return { rows: [{ id: 1 }] };
      return { rows: [], rowCount: 0 };
    } } }));
  }
  it("clears profile_embedding and the fit scores ranked against it", async () => {
    const calls = [];
    const r = await supertest(profileApp(calls)).patch("/api/job-profile").send({ preferences_text: "Data engineer" }).expect(200);
    assert.equal(r.body.rescore_needed, true);
    assert.ok(calls.some((c) => /SET profile_embedding = NULL/.test(c.sql)), "embedding cleared");
    assert.ok(calls.some((c) => /UPDATE job_listings SET fit_score = NULL, fit_rationale = NULL/.test(c.sql)), "fit scores cleared");
  });
  it("leaves them alone when only non-text fields change", async () => {
    const calls = [];
    const r = await supertest(profileApp(calls)).patch("/api/job-profile").send({ min_salary: 150000 }).expect(200);
    assert.equal(r.body.rescore_needed, false);
    assert.ok(!calls.some((c) => /profile_embedding = NULL|fit_score = NULL/.test(c.sql)));
  });
  it("a missing pgvector column can't fail the save (separate fail-soft statement)", async () => {
    const app = appWith(jobs({ pool: { query: async (sql) => {
      if (/profile_embedding = NULL/.test(sql)) throw new Error('column "profile_embedding" does not exist');
      return { rows: [{ id: 1 }] };
    } } }));
    await supertest(app).patch("/api/job-profile").send({ resume_text: "x" }).expect(200);
  });
});

describe("PB-5/PB-6 — the aggregator buckets", () => {
  const rows = [
    { id: 1, trust_score: 80, fit_score: 90, legitimacy: "real", status: "new" },
    { id: 2, trust_score: 80, fit_score: null, legitimacy: "real", status: "new" },   // unscored
    { id: 3, trust_score: 80, fit_score: 90, legitimacy: "suspect", status: "new" },  // suspect
    { id: 4, trust_score: 80, fit_score: 90, legitimacy: "scam", status: "new" },     // scam
  ];
  it("main needs a real fit; unscored + suspect are verify-first; scam is hidden", async () => {
    let sql = "";
    const s = await jobs.gatherJobRadarSummary({ query: async (q) => { sql = q; return { rows }; } });
    assert.deepEqual(s.main.map((r) => r.id), [1]);
    assert.deepEqual(s.verify_first.map((r) => r.id).sort(), [2, 3]);
    assert.equal(s.top_pick.id, 1);
    assert.match(sql, /legitimacy <> 'scam'/, "scam excluded in SQL too");
    assert.match(sql, /status = 'saved' OR last_seen >= \(SELECT MAX\(last_seen\) FROM job_listings\) - make_interval\(days => 14\)/,
      "a stale 'new' listing (source stopped returning it) is dropped; saved ones stay");
  });
});

describe("PB-5 — the refresh re-scores live listings and backfills fit", () => {
  it("trust runs over new + live ids; fit over new + unscored live ids", async () => {
    const seen = { trust: null, fitIds: null };
    const pool = { query: async (sql, params) => {
      if (/SELECT key FROM job_sources/.test(sql)) return { rows: [] };
      if (/SELECT id FROM job_listings[\s\S]*fit_score IS NULL/.test(sql)) return { rows: [{ id: 7 }] };
      if (/SELECT id FROM job_listings\s+WHERE status IN \('new','saved'\)/.test(sql)) return { rows: [{ id: 7 }, { id: 8 }] };
      if (/WHERE jl\.id = ANY/.test(sql)) { seen.trust = params[0]; return { rows: [] }; }
      if (/UPDATE job_listings SET description = NULL/.test(sql)) return { rowCount: 0 };
      return { rows: [] };
    } };
    const origFit = embeddings.isConfigured;
    embeddings.isConfigured = () => false; // fit pass returns early; we only check its ids
    try {
      const r = await jobs.runRefresh(pool, {});
      assert.deepEqual(seen.trust.sort(), [7, 8], "every live listing re-scored (ghost decay applies)");
      assert.equal(r.added, 0);
    } finally { embeddings.isConfigured = origFit; }
  });

  it("re-scoring keeps a Claude legitimacy verdict", () => {
    assert.match(read("routes", "jobs.js"), /legitimacy = CASE WHEN legitimacy_reasons IS NOT NULL THEN legitimacy ELSE \$2 END/);
  });

  it("embeds only unembedded rows, in groups, and one failed group doesn't stop the rest", async () => {
    const orig = { isConfigured: embeddings.isConfigured, embed: embeddings.embed, model: ai.getAIModelForFeature };
    const groups = [];
    embeddings.isConfigured = () => true;
    embeddings.embed = async (texts) => { groups.push(texts.length); if (groups.length === 1) throw new Error("Voyage 429"); return texts.map(() => [0.1, 0.2]); };
    ai.getAIModelForFeature = async () => "off";
    let selectSql = "";
    const updates = [];
    const ids = Array.from({ length: 70 }, (_, i) => i + 1);
    const pool = { query: async (sql, params) => {
      if (/SELECT id, title, company, location, description FROM job_listings/.test(sql)) {
        selectSql = sql;
        return { rows: ids.map((id) => ({ id, title: "T" + id, company: "C" })) };
      }
      if (/UPDATE job_listings SET embedding/.test(sql)) { updates.push(params[1]); return {}; }
      if (/FROM job_profile/.test(sql)) return { rows: [{}] };
      return { rows: [] };
    } };
    try {
      const r = await jobs.runFitPass(pool, ids, {});
      assert.match(selectSql, /AND embedding IS NULL/);
      assert.deepEqual(groups, [64, 6], "batched, not one call per listing");
      assert.equal(r.embedded, 6, "the second group still embedded after the first failed");
      assert.deepEqual(updates, [65, 66, 67, 68, 69, 70]);
    } finally { Object.assign(embeddings, { isConfigured: orig.isConfigured, embed: orig.embed }); ai.getAIModelForFeature = orig.model; }
  });

  it("fit candidates are the unscored ones", () => {
    assert.match(read("routes", "jobs.js"), /embedding IS NOT NULL AND fit_score IS NULL/);
  });
});

describe("PB-7 — removing a company deactivates it", () => {
  it("DELETE sets active=false (no hard delete) and GET lists active ones", async () => {
    const calls = [];
    const app = appWith(jobs({ pool: { query: async (sql) => { calls.push(sql); return { rows: [{ id: 3 }] }; } } }));
    await supertest(app).delete("/api/job-companies/3").expect(200);
    assert.ok(calls.some((s) => /UPDATE job_target_companies SET active = false WHERE id = \$1/.test(s)));
    assert.ok(!calls.some((s) => /DELETE FROM job_target_companies/.test(s)));
    await supertest(app).get("/api/job-companies").expect(200);
    assert.ok(calls.some((s) => /FROM job_target_companies WHERE active = true/.test(s)));
  });
  it("the db/021 seed is ON CONFLICT DO NOTHING, so a kept inactive row stays off", () => {
    assert.match(read("db", "021_jobs.sql"), /INSERT INTO job_target_companies[\s\S]*ON CONFLICT \(ats, slug\) DO NOTHING/);
  });
});

describe("PB-9 — feedback nudges", () => {
  it("dismiss never nudges; re-setting the same status doesn't nudge again", async () => {
    const q = [];
    const pool = { query: async (sql, params) => { q.push(params); return { rows: [] }; } };
    await jobs.applyFeedbackToSource(pool, 5, "dismissed", "new");
    await jobs.applyFeedbackToSource(pool, 5, "saved", "saved");
    assert.equal(q.length, 0);
    await jobs.applyFeedbackToSource(pool, 5, "saved", "new");
    assert.equal(q.length, 1);
    assert.equal(q[0][0], 1);
  });
  it("PATCH passes the previous status through", async () => {
    const q = [];
    const app = appWith(jobs({ pool: { query: async (sql, params) => {
      q.push(sql);
      if (/UPDATE job_listings SET status/.test(sql)) return { rows: [{ id: 5, status: "saved", prev_status: "saved" }] };
      return { rows: [] };
    } } }));
    const r = await supertest(app).patch("/api/jobs/5").send({ status: "saved" }).expect(200);
    assert.equal(r.body.prev_status, "saved");
    assert.ok(!q.some((s) => /UPDATE job_sources/.test(s)), "no re-nudge on an unchanged status");
  });
});

describe("PB-19 / PUI-7 — ingest fetches time out and keep only http(s) links", () => {
  it("every board fetch carries an AbortSignal; javascript: apply links are dropped", async () => {
    const signals = [];
    const fetchImpl = async (url, init) => {
      signals.push(init && init.signal);
      return { ok: true, json: async () => ({ jobs: [
        { id: 1, title: "Good", absolute_url: "https://boards.greenhouse.io/x/1" },
        { id: 2, title: "Bad", absolute_url: "javascript:alert(1)" },
      ] }) };
    };
    const pool = { query: async (sql) => {
      if (/FROM job_sources/.test(sql)) return { rows: [{ key: "greenhouse" }] };
      if (/FROM job_target_companies/.test(sql)) return { rows: [{ slug: "x", ats: "greenhouse" }] };
      return { rows: [] };
    } };
    const out = await jobs.runIngest(pool, { fetchImpl });
    assert.ok(signals.length && signals.every((s) => s instanceof AbortSignal));
    assert.deepEqual(out.map((n) => n.title), ["Good"]);
    assert.equal(jobs.isHttpUrl("data:text/html,x"), false);
    assert.equal(jobs.isHttpUrl("http://a.example/x"), true);
  });
  it("the keep-alive ping has a timeout", () => {
    assert.match(read("services", "keep-alive.js"), /fetch\(pingUrl, \{ signal: AbortSignal\.timeout\(10000\) \}\)/);
  });
});

describe("PUI-4 — Job Radar views + error states", () => {
  it("GET /api/jobs/list returns a status view and 400s an unknown one", async () => {
    const app = appWith(jobs({ pool: { query: async (sql, params) => ({ rows: [{ id: 1, status: params[0] }] }) } }));
    await supertest(app).get("/api/jobs/list?status=bogus").expect(400);
    const r = await supertest(app).get("/api/jobs/list?status=dismissed").expect(200);
    assert.equal(r.body.listings[0].status, "dismissed");
  });
  it("the page checks responses, disables Refresh while running and offers the views", async () => {
    const r = await supertest(appWith(express.Router().get("/jobs", require("../pages/jobs")()))).get("/jobs").expect(200);
    for (const v of ["radar", "saved", "applied", "dismissed"]) assert.ok(r.text.includes('data-view="' + v + '"'), v);
    assert.match(r.text, /if\(!r\.ok \|\| data\.error\)/, "a 500 / error:true summary shows an error, not 'no matches'");
    assert.match(r.text, /btn\.disabled = true;/);
    assert.match(r.text, /box\.checked = !on;/, "the Enabled box reverts when the save fails");
    assert.match(r.text, /function safeUrl\(u\)/, "PUI-7 client-side guard");
  });
});

// ===========================================================================
// Service worker (PB-17) — run the emitted script against fakes
// ===========================================================================
describe("PB-17 — service worker queue + cache", () => {
  async function loadSw() {
    const app = appWith(require("../routes/pwa")({}));
    const src = (await supertest(app).get("/sw.js").expect(200)).text;
    const listeners = {};
    const store = new Map();
    const cache = {
      put: async (k, v) => { store.set(typeof k === "string" ? k : k.url, await v.clone().text()); },
      match: async (k) => { const v = store.get(typeof k === "string" ? k : k.url); return v == null ? undefined : new Response(v); },
      delete: async (k) => store.delete(k),
      addAll: async () => {},
    };
    const ctx = {
      self: { addEventListener: (t, fn) => { listeners[t] = fn; }, clients: { matchAll: async () => [] } },
      caches: { open: async () => cache, match: (k) => cache.match(k), keys: async () => [] },
      fetch: async () => { throw new TypeError("offline"); },
      URL, Response, Request, JSON, Date, Object, Promise, console,
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return { listeners, store, ctx };
  }
  function fire(listeners, req) {
    let p = null;
    listeners.fetch({ request: req, respondWith: (x) => { p = x; } });
    return p;
  }
  it("an offline write is a 503 (never ok:true) and is queued; a send is not queued", async () => {
    const { listeners, store } = await loadSw();
    const r1 = await fire(listeners, new Request("http://h/api/todos", { method: "POST", body: "{}" }));
    assert.equal(r1.status, 503);
    const j1 = await r1.json();
    assert.equal(j1.ok, false); assert.equal(j1.queued, true);
    assert.equal(JSON.parse(store.get("per-sistant-offline-queue")).length, 1);
    const r2 = await fire(listeners, new Request("http://h/api/emails/5/send", { method: "POST" }));
    assert.equal(r2.status, 503);
    assert.equal((await r2.json()).queued, false);
    assert.equal(JSON.parse(store.get("per-sistant-offline-queue")).length, 1, "send not queued");
  });
  it("secret-lookup responses are never cached", async () => {
    const { listeners } = await loadSw();
    let responded = false;
    listeners.fetch({ request: new Request("http://h/api/rag/secret-lookup?q=x"), respondWith: () => { responded = true; } });
    assert.equal(responded, false, "the SW stays out of it — no cache.put");
  });
  it("replay keeps 401/5xx/network failures, drops successes and stale entries", async () => {
    const { listeners, store, ctx } = await loadSw();
    const now = Date.now();
    store.set("per-sistant-offline-queue", JSON.stringify([
      { url: "http://h/api/a", method: "POST", queued_at: now },
      { url: "http://h/api/b", method: "POST", queued_at: now },
      { url: "http://h/api/c", method: "POST", queued_at: now },
      { url: "http://h/api/d", method: "POST", queued_at: now - 2 * 86400000 },
      { url: "http://h/api/e", method: "POST", queued_at: now },
    ]));
    const hits = [];
    ctx.fetch = async (url) => {
      hits.push(url);
      if (url.endsWith("/a")) return new Response("{}", { status: 200 });
      if (url.endsWith("/b")) return new Response("{}", { status: 401 });
      if (url.endsWith("/c")) return new Response("{}", { status: 400 });
      throw new TypeError("offline");
    };
    listeners.message({ data: "sync" });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!hits.some((u) => u.endsWith("/d")), "a day-old entry is dropped, not replayed");
    const left = JSON.parse(store.get("per-sistant-offline-queue")).map((e) => e.url);
    assert.deepEqual(left, ["http://h/api/b", "http://h/api/e"]);
  });
});

// ===========================================================================
// To-dos
// ===========================================================================
describe("PD-5 — task location", () => {
  it("POST stores location_* and 400s an out-of-range latitude", async () => {
    stubDb(async () => ({ rows: [] })); // todo_created automations / webhooks
    let params = null;
    const app = appWith(require("../routes/todos")({ pool: { query: async (sql, p) => { params = p; return { rows: [{ id: 1 }] }; } }, config }));
    await supertest(app).post("/api/todos").send({ title: "Pharmacy", location_name: "CVS", location_lat: 40.1, location_lng: -73.9, location_radius: 150 }).expect(200);
    assert.deepEqual(params.slice(9), ["CVS", 40.1, -73.9, 150]);
    await supertest(app).post("/api/todos").send({ title: "x", location_lat: 123 }).expect(400);
  });
  it("the next recurring instance carries the location (complete + midnight roll)", async () => {
    const todo = { id: 5, title: "Gym", recurring: true, recurrence_rule: "daily", recurrence_interval: 1, completed: false,
      due_date: new Date(Date.now() + 86400000), streak_count: 0, best_streak: 0, location_name: "Gym", location_lat: 1.5, location_lng: 2.5, location_radius: 300 };
    let insert = null;
    const client = { query: async (sql, p) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [todo] };
      if (/INSERT INTO todos/.test(sql)) { insert = { sql, p }; return { rows: [{ id: 6 }] }; }
      return { rows: [] };
    }, release() {} };
    stubDb(async () => ({ rows: [] })); // runAutomations / fireWebhooks
    await require("../routes/todos").completeRecurringTodo({ connect: async () => client }, 5);
    assert.match(insert.sql, /location_name, location_lat, location_lng, location_radius/);
    assert.deepEqual(insert.p.slice(14), ["Gym", 1.5, 2.5, 300]);

    let rollInsert = null;
    const rollDb = { query: async (sql, p) => {
      if (/^SELECT \* FROM todos/.test(sql)) return { rows: [{ ...todo, due_date: new Date("2026-10-01T00:00:00") }] };
      if (/^UPDATE todos SET completed = true/.test(sql)) return { rows: [{ id: 5 }] };
      if (/^INSERT INTO todos/.test(sql)) { rollInsert = p; return { rows: [] }; }
      return { rows: [] };
    } };
    await helpers.rollMissedRecurring(rollDb, "2026-10-08");
    assert.deepEqual(rollInsert.slice(12), ["Gym", 1.5, 2.5, 300]);
  });
});

describe("PD-6 — automations", () => {
  it("validateAutomationRule refuses rules that could never run", () => {
    const v = helpers.validateAutomationRule;
    assert.match(v({ trigger_type: "schedule", action_type: "create_todo", action_data: { title: "x" } }), /Invalid trigger/);
    assert.match(v({ trigger_type: "todo_created", action_type: "send_notification", action_data: {} }), /Invalid action/);
    assert.match(v({ trigger_type: "todo_created", action_type: "set_priority", action_data: { priority: "High" } }), /Priority must be/);
    assert.match(v({ trigger_type: "note_created", action_type: "set_priority", action_data: { priority: "high" } }), /can't run on a note/);
    assert.match(v({ trigger_type: "todo_created", action_type: "set_category", action_data: {} }), /required/);
    assert.equal(v({ trigger_type: "email_created", action_type: "create_todo", action_data: { title: "Follow up" } }), null);
  });
  it("POST/PATCH /api/automations 400 an invalid rule", async () => {
    const app = appWith(require("../routes/automations")({ pool: { query: async () => ({ rows: [{ id: 1, trigger_type: "todo_created", action_type: "set_priority", action_data: { priority: "high" } }] }) }, config }));
    await supertest(app).post("/api/automations").send({ name: "n", trigger_type: "todo_created", action_type: "set_priority", action_data: { priority: "High" } }).expect(400);
    await supertest(app).post("/api/automations").send({ name: "n", trigger_type: "schedule", action_type: "create_todo", action_data: { title: "x" } }).expect(400);
    await supertest(app).patch("/api/automations/1").send({ action_data: { priority: "nope" } }).expect(400);
    await supertest(app).patch("/api/automations/1").send({ action_data: { priority: "urgent" } }).expect(200);
  });
  it("runAutomations isolates each rule and never runs a todo action on another entity", async () => {
    const ran = [];
    stubDb(async (sql, params) => {
      if (/SELECT \* FROM automations/.test(sql)) return { rows: [
        { id: 1, trigger_type: "todo_created", action_type: "set_category", action_data: { category: "boom" }, conditions: {} },
        { id: 2, trigger_type: "todo_created", action_type: "set_priority", action_data: { priority: "High" }, conditions: {} }, // legacy bad row
        { id: 3, trigger_type: "todo_created", action_type: "set_horizon", action_data: { horizon: "long" }, conditions: {} },
      ] };
      ran.push(sql);
      if (/SET category/.test(sql)) throw new Error("db blip");
      return { rows: [] };
    });
    await helpers.runAutomations("todo_created", { id: 9, title: "t" }, "todo");
    assert.ok(ran.some((s) => /SET horizon/.test(s)), "rule 3 still ran after rule 1 threw");
    assert.ok(!ran.some((s) => /SET priority/.test(s)), "the invalid legacy rule is skipped, not run");

    const ran2 = [];
    stubDb(async (sql) => {
      if (/SELECT \* FROM automations/.test(sql)) return { rows: [{ id: 4, trigger_type: "email_created", action_type: "set_priority", action_data: { priority: "high" }, conditions: {} }] };
      ran2.push(sql); return { rows: [] };
    });
    await helpers.runAutomations("email_created", { id: 9, subject: "s" }, "email");
    assert.equal(ran2.length, 0, "an email id never rewrites the todo with the same id");
  });
  it("note/email creation and recurring completion fire their automations", async () => {
    const fired = [];
    const h = { runAutomations: async (t) => { fired.push(t); }, fireWebhooks: async () => {}, sendSlackNotification: async () => {} };
    const pool = { query: async () => ({ rows: [{ id: 1 }] }) };
    await supertest(appWith(require("../routes/notes")({ pool, config, helpers: h }))).post("/api/notes").send({ content: "hi" }).expect(200);
    await supertest(appWith(require("../routes/emails")({ pool, config, helpers: h }))).post("/api/emails").send({ recipient_email: "a@b.co", subject: "s", body: "b" }).expect(200);
    assert.deepEqual(fired, ["note_created", "email_created"]);
    assert.match(read("routes", "todos.js"), /runAutomations\('todo_completed', \{ \.\.\.todo, completed: true \}, 'todo'\)/);
  });
});

describe("PD-12 — dependencies", () => {
  it("trashed tasks are filtered out of both dependency lists", async () => {
    const sqls = [];
    const app = appWith(require("../routes/todos")({ pool: { query: async (s) => { sqls.push(s); return { rows: [] }; } }, config }));
    await supertest(app).get("/api/todos/1/dependencies").expect(200);
    assert.equal(sqls.filter((s) => /JOIN todos t[\s\S]*AND t\.deleted_at IS NULL/.test(s)).length, 2);
  });
  it("a longer cycle (A→B→C→A) is refused via a recursive reachability check", async () => {
    let cycleSql = "", cycleParams = null;
    const app = appWith(require("../routes/todos")({ pool: { query: async (s, p) => {
      if (/WITH RECURSIVE reach/.test(s)) { cycleSql = s; cycleParams = p; return { rows: [{ "?column?": 1 }] }; }
      return { rows: [{ id: 1 }] };
    } }, config }));
    const r = await supertest(app).post("/api/todos/1/dependencies").send({ depends_on_id: 2 }).expect(400);
    assert.match(r.body.error, /Circular/);
    assert.match(cycleSql, /UNION\s+SELECT td\.depends_on_id FROM task_dependencies td JOIN reach/);
    assert.deepEqual(cycleParams.map(String), ["2", "1"]);
  });
});

describe("PD-13 — templates", () => {
  const { validateTemplateFields } = require("../routes/todoTemplates");
  it("validates rule, interval, priority, horizon and subtasks", () => {
    assert.match(validateTemplateFields({ name: "n", title: "t", recurring: true, recurrence_rule: "biweekly" }), /recurrence rule/);
    assert.match(validateTemplateFields({ name: "n", title: "t", recurrence_interval: 0 }), /interval/);
    assert.match(validateTemplateFields({ priority: "High" }, { partial: true }), /priority/);
    assert.match(validateTemplateFields({ name: "n", title: "t", subtasks: ["ok", { title: "" }] }), /subtask/);
    assert.equal(validateTemplateFields({ name: "n", title: "t", recurring: true, recurrence_rule: "weekly", recurrence_interval: 2 }), null);
  });
  it("apply is one transaction — a failing subtask rolls the todo back", async () => {
    const steps = [];
    const client = { query: async (sql) => {
      steps.push(sql.split(" ")[0]);
      if (/INSERT INTO todos/.test(sql)) return { rows: [{ id: 50 }] };
      if (/INSERT INTO subtasks/.test(sql)) throw new Error("null title");
      return { rows: [] };
    }, release() {} };
    const pool = {
      query: async () => ({ rows: [{ id: 1, title: "T", priority: "medium", horizon: "short", recurring: false, subtasks: ["a"] }] }),
      connect: async () => client,
    };
    await supertest(appWith(require("../routes/todoTemplates")({ pool }))).post("/api/todo-templates/1/apply").send({}).expect(500);
    assert.deepEqual(steps, ["BEGIN", "INSERT", "INSERT", "ROLLBACK"]);
  });
});

describe("PD-14 — weekly review overdue", () => {
  it("overdue = open tasks due before TODAY (APP_TIMEZONE), not before the week's start", async () => {
    const calls = [];
    const app = appWith(require("../routes/review")({ pool: { query: async (s, p) => { calls.push({ s, p }); return { rows: [{ cnt: "0" }] }; } } }));
    await supertest(app).get("/api/review").expect(200);
    const od = calls.find((c) => /due_date < \$1 AND NOT completed/.test(c.s));
    assert.equal(od.p[0], require("../routes/health").todayStr());
  });
});

describe("PUI-3 — undo semantics", () => {
  it("there is no 'undo send' — sending shows a plain message", () => {
    const js = read("views", "js.js");
    assert.ok(!/status:'draft'/.test(js), "Undo no longer flips a sent email back to draft");
    for (const f of ["pages/dashboard-script.js", "pages/today.js"]) {
      assert.ok(!/showUndo\('Email sent','email',id,'send'\)|showUndo\('Email sent', 'email', id, 'send'\)/.test(read(f)), f);
    }
  });
  it("undo on a recurring completion removes the generated instance and re-opens the task", async () => {
    const steps = [];
    const client = { query: async (sql, p) => {
      steps.push({ sql, p });
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: 5, recurring: true, completed: true, missed: false, recurrence_parent_id: null }] };
      if (/^DELETE FROM todos/.test(sql)) return { rows: [{ streak_count: 4 }] };
      return { rows: [] };
    }, release() {} };
    const out = await require("../routes/todos").undoCompleteRecurringTodo({ connect: async () => client }, 5, 6);
    assert.equal(out.ok, true);
    const del = steps.find((s) => /^DELETE FROM todos/.test(s.sql));
    assert.deepEqual(del.p, [6, 5]);
    assert.match(del.sql, /completed = false AND deleted_at IS NULL/, "only an untouched instance is removed");
    const reopen = steps.find((s) => /SET completed = false, completed_at = NULL, streak_count = \$2/.test(s.sql));
    assert.deepEqual(reopen.p, [5, 3]);
  });
  it("409s when the next instance has already changed", async () => {
    const client = { query: async (sql) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: 5, recurring: true, completed: true }] };
      if (/^DELETE/.test(sql)) return { rows: [] };
      return { rows: [] };
    }, release() {} };
    const out = await require("../routes/todos").undoCompleteRecurringTodo({ connect: async () => client }, 5, 6);
    assert.equal(out.status, 409);
  });
});

describe("PUI-5 — keyboard access + dialogs", () => {
  it("custom controls are focusable with roles; Enter/Space and Esc are handled globally", () => {
    assert.match(read("pages", "todos-script-1.js"), /class="todo-check'[^\n]*role="checkbox" tabindex="0" aria-checked=/);
    assert.match(read("pages", "notes.js"), /role="button" tabindex="0" aria-label="'\+escAttr\('Open note: '/);
    assert.match(read("pages", "health.js"), /aria-pressed="'\+on\+'"/);
    const js = read("views", "js.js");
    assert.match(js, /key==='Escape'/);
    assert.match(js, /role==='button'\|\|role==='checkbox'/);
    assert.match(js, /box\.setAttribute\('role','dialog'\)/);
  });
  it("the shared bundle still parses (one template literal — no eaten backslashes)", () => {
    const src = require("../views/js.js");
    const code = typeof src === "string" ? src : Object.values(src).find((v) => typeof v === "string");
    assert.doesNotThrow(() => new vm.Script(code));
  });
});

// ===========================================================================
// Email, contacts, calendar, AI, settings
// ===========================================================================
describe("PD-9 — one recipient address", () => {
  it("EMAIL_REGEX rejects lists and display-name forms", () => {
    for (const bad of ["a@x.com,b@y.com", "a@x.com,b.com", "a@x.com;b@y.com", "Name <a@x.com>"]) assert.equal(config.EMAIL_REGEX.test(bad), false, bad);
    assert.equal(config.EMAIL_REGEX.test("test.user+tag@domain.org"), true);
  });
  it("emails PATCH and contacts POST/PATCH validate", async () => {
    const pool = { query: async () => ({ rows: [{ id: 1 }] }) };
    await supertest(appWith(require("../routes/emails")({ pool, config, helpers: {} }))).patch("/api/emails/1").send({ recipient_email: "a@x.com,b.com" }).expect(400);
    const contacts = appWith(require("../routes/contacts")({ pool, config }));
    await supertest(contacts).post("/api/contacts").send({ name: "A", email: "nope" }).expect(400);
    await supertest(contacts).patch("/api/contacts/1").send({ email: "a@x.com,b@y.com" }).expect(400);
    await supertest(contacts).post("/api/contacts").send({ name: "A", email: "a@b.co" }).expect(200);
  });
  it("the scheduled-send cron fails an invalid recipient instead of sending", () => {
    assert.match(read("server.js"), /if \(!config\.EMAIL_REGEX\.test\(String\(email\.recipient_email \|\| ""\)\)\) \{[\s\S]*status = 'failed'[\s\S]*continue;/);
  });
});

describe("PD-11 — iCal export", () => {
  it("escapes text, adds DTSTAMP, ends all-day events the next day, folds long lines", async () => {
    const pool = { query: async (sql) => {
      if (/FROM todos/.test(sql)) return { rows: [{ id: 1, title: "Pay rent\nnow, today; ok", description: "Line1\nLine2 \\ x", due_date: new Date(2026, 9, 31), priority: "high" }] };
      return { rows: [{ id: 2, subject: "Hi, there", recipient_email: "a@b.co", scheduled_at: new Date("2026-10-09T15:00:00Z") }] };
    } };
    const app = appWith(require("../routes/calendar")({ pool, advanceRecurrence: helpers.advanceRecurrence }));
    const r = await supertest(app).get("/api/calendar.ics").expect(200);
    const text = r.text;
    assert.ok(text.includes("SUMMARY:[HIGH] Pay rent\\nnow\\, today\\; ok"));
    assert.ok(text.includes("DESCRIPTION:Line1\\nLine2 \\\\ x"));
    assert.ok(text.includes("DTSTART;VALUE=DATE:20261031"));
    assert.ok(text.includes("DTEND;VALUE=DATE:20261101"), "next day, across a month end");
    assert.equal((text.match(/DTSTAMP:\d{8}T\d{6}Z/g) || []).length, 2);
    for (const line of text.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, "line ≤ 75 octets: " + line);
    assert.ok(!/\n(?!$)/.test(text.replace(/\r\n/g, "")), "no bare newline inside a property");
  });
});

describe("PD-7 — Ask has its own model setting", () => {
  it("migration 024 adds both columns, inherits once, and defaults Ask on", () => {
    const sql = read("db", "024_ask_suggestion_models.sql");
    assert.match(sql, /ADD COLUMN IF NOT EXISTS ai_model_natural_language_query/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS ai_model_smart_suggestions/);
    assert.match(sql, /WHERE ai_model_natural_language_query IS NULL/);
    assert.match(sql, /ai_model_natural_language_query SET DEFAULT 'haiku'/);
  });
  it("/api/ai/query reads ai_model_natural_language_query (not daily_briefing)", async () => {
    const asked = [];
    stubDb(async (sql) => { asked.push(sql); return { rows: [{ model: "off" }] }; });
    const app = appWith(require("../routes/ai")({ pool: { query: async () => ({ rows: [] }) } }));
    const r = await supertest(app).post("/api/ai/query").send({ query: "how many tasks?" }).expect(200);
    assert.ok(asked.some((s) => /ai_model_natural_language_query/.test(s)));
    assert.ok(!asked.some((s) => /ai_model_daily_briefing/.test(s)));
    assert.match(r.body.answer, /Ask is turned off/);
  });
  it("Settings lists and saves both", () => {
    assert.match(read("pages", "settings.js"), /id="aim-natural_language_query"[\s\S]*id="aim-smart_suggestions"/);
    assert.match(read("pages", "settings-script.js"), /'natural_language_query','smart_suggestions'\]/);
    assert.match(read("routes", "ai.js"), /"ai_model_natural_language_query", "ai_model_smart_suggestions"\]/);
  });
});

describe("PUI-6 — webhook events", () => {
  it("PATCH 400s events that aren't a list of known events", async () => {
    const app = appWith(require("../routes/webhooks")({ pool: { query: async () => ({ rows: [{ id: 1 }] }) }, config, helpers: { sendWebhook: async () => ({}) } }));
    await supertest(app).patch("/api/webhooks/1").send({ events: ["<img src=x>"] }).expect(400);
    await supertest(app).patch("/api/webhooks/1").send({ events: "todo_created" }).expect(400);
    await supertest(app).patch("/api/webhooks/1").send({ events: ["todo_created"] }).expect(200);
  });
  it("the list escapes events, trigger and action types", () => {
    const s = read("pages", "settings-script.js");
    assert.match(s, /Events: '\+esc\(\(w\.events\|\|\[\]\)\.join\(', '\)\)/);
    assert.match(s, /\+esc\(a\.trigger_type\)\+condText\+' &rarr; '\+esc\(a\.action_type\)/);
  });
});

describe("PUI-8 — keep-alive is Perfin's when embedded", () => {
  it("hides the controls (kept in the DOM for the script) and says where to set it", async () => {
    const page = require("../pages/settings")("");
    const emb = await supertest(appWith(express.Router().get("/s", page), { embedded: true })).get("/s").expect(200);
    assert.ok(emb.text.includes('display:none;flex-direction:column;gap:12px;" id="ka-controls"'));
    assert.match(emb.text, /set in Perfin &rarr; Settings &rarr; Keep-Alive/);
    assert.ok(emb.text.includes('id="ka-enabled"'), "still present for settings-script");
    const std = await supertest(appWith(express.Router().get("/s", page))).get("/s").expect(200);
    assert.ok(std.text.includes('display:flex;flex-direction:column;gap:12px;" id="ka-controls"'));
  });
});
