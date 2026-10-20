// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 3 — backstops, outcomes, operator state
// ============================================================================
// F8    job heartbeats record the run's OUTCOME; data-health flushes first and
//       raises failed jobs; housing-ledger is watched
// F15   the Rent & Utilities reminders are an "away" channel (not activity-gated)
// F63   the insights auto-trigger checks the cap before the sync chain, stamps
//       every attempt and backs off; an insight whose INSERT fails is charged
// F73   a failed settings read fails generateInsights before the Claude call
// F23   wholesale / thrown sync failures are recorded in last_sync_result
// F69   a failed audit-finding INSERT marks the run incomplete, not clean
// F14   the compromised Teller cert is a data-health issue + a boot log line
// F5    daily-sync.yml backstop steps run independently and report timeouts
// F3/F16 workflow permissions, backup verify (pinned in broad-scan-fixes),
//       generic test-notification error, shutdown stops scheduled jobs
// Policy: no NEW bare catch in server code (empty-catch scan, KNOWN_GAPS)
// ============================================================================

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const jobHealth = require("../teller/services/job-health");

let origQuery;
before(() => { origQuery = dbModule.pool.query; });
after(() => { dbModule.pool.query = origQuery; });

// ---------------------------------------------------------------------------
describe("F8 — job outcomes, not just heartbeats", () => {
  beforeEach(() => { jobHealth._memoryTicks.clear(); jobHealth._memoryResults.clear(); jobHealth._flushedTicks.clear(); });

  it("flush writes a recorded outcome once and keeps the stored one on a tick-only flush", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    jobHealth.tick("budget-alerts");
    jobHealth.result("budget-alerts", { ok: false, error: "relation \"budgets\" does not exist" });
    await jobHealth.flush(pool);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.slice(2), ["error", "relation \"budgets\" does not exist"]);
    assert.match(calls[0].sql, /last_status = CASE WHEN \$3::text IS NULL THEN job_runs\.last_status ELSE \$3::text END/);
    assert.match(calls[0].sql, /last_error = CASE WHEN \$3::text IS NULL THEN job_runs\.last_error ELSE \$4::text END/);
    assert.doesNotMatch(calls[0].sql, /last_status = 'ok'/, "status is no longer hard-coded");
    // Nothing new since → nothing written (data-health flushes on every load).
    calls.length = 0;
    await jobHealth.flush(pool);
    assert.equal(calls.length, 0);
    // Persisted exactly once: a later tick-only flush passes NULLs → keep.
    jobHealth._memoryTicks.set("budget-alerts", Date.now() + 1000);
    await jobHealth.flush(pool);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.slice(2), [null, null]);
  });

  it("a success clears the error; error text is bounded", () => {
    jobHealth.result("x", { ok: false, error: "e".repeat(1000) });
    assert.equal(jobHealth._memoryResults.get("x").error.length, 300);
    jobHealth.result("x", { ok: true, error: "ignored" });
    assert.deepEqual(jobHealth._memoryResults.get("x"), { status: "ok", error: null });
  });

  it("housing-ledger is watched like every other ticked job", () => {
    assert.equal(jobHealth.JOB_INTERVALS_MS["housing-ledger"], 6 * 3600e3);
  });

  it("every job that ticks also reports an outcome in startup.js", () => {
    const src = read("teller", "startup.js");
    for (const job of Object.keys(jobHealth.JOB_INTERVALS_MS)) {
      assert.ok(src.includes(`jobHealth.result("${job}"`), `startup.js must record an outcome for "${job}"`);
    }
  });

  it("data-health flushes in-memory heartbeats BEFORE reading job_runs and raises a failed job", async () => {
    const order = [];
    jobHealth.tick("bank-auto-sync");
    dbModule.pool.query = async (sql) => {
      if (/INSERT INTO job_runs/.test(sql)) { order.push("flush"); return { rows: [] }; }
      if (/FROM job_runs/.test(sql)) {
        order.push("read");
        return { rows: [
          { job_name: "bank-auto-sync", last_run_at: new Date(), last_status: "error", last_error: "transaction sync failed" },
          { job_name: "goal-milestones", last_run_at: new Date(), last_status: "ok", last_error: null },
        ] };
      }
      if (/FROM user_settings/.test(sql)) return { rows: [{ last_txn_sync_at: new Date(), last_balance_sync_at: new Date() }] };
      return { rows: [{ total: 0, disconnected: 0, not_good: 0 }] };
    };
    const app = express(); app.use(require("../teller/routes/settings"));
    const res = await supertest(app).get("/api/data-health").expect(200);
    assert.deepEqual(order, ["flush", "read"]);
    const bank = res.body.jobs.find((j) => j.job === "bank-auto-sync");
    assert.equal(bank.last_status, "error");
    assert.equal(bank.last_error, "transaction sync failed");
    assert.equal(res.body.jobs.find((j) => j.job === "goal-milestones").last_error, null);
    assert.ok(res.body.issues.some((i) => /Scheduled job bank-auto-sync failed its last run: transaction sync failed/.test(i.message)));
    assert.equal(res.body.ok, false);
  });
});

// ---------------------------------------------------------------------------
describe("F15 — Rent & Utilities reminders reach an away user", () => {
  const startup = require("../teller/startup");
  const housing = require("../teller/routes/housing");
  const origGen = housing.generateHousingObligations;
  const origRem = housing.runHousingReminders;
  afterEach(() => {
    housing.generateHousingObligations = origGen;
    housing.runHousingReminders = origRem;
    startup._awayJobs.reset();
    jobHealth._memoryResults.clear();
  });

  it("is not activity-gated, and settles for the local day after a successful pass", async () => {
    const src = read("teller", "startup.js");
    const body = src.slice(src.indexOf("async function runHousingLedgerTick()"));
    assert.doesNotMatch(body.slice(0, body.indexOf("\n}\n")), /isUserActive\(\)/);
    assert.match(src, /setInterval\(\(\) => runHousingLedgerTick\(\), 6 \* 60 \* 60 \* 1000\)/);
    let gen = 0, rem = 0;
    housing.generateHousingObligations = async () => { gen++; return { generated: 0 }; };
    housing.runHousingReminders = async () => { rem++; return { sent: 1 }; };
    await startup._awayJobs.runHousingLedgerTick();
    await startup._awayJobs.runHousingLedgerTick();
    assert.equal(gen, 1);
    assert.equal(rem, 1);
    assert.equal(jobHealth._memoryResults.get("housing-ledger").status, "ok");
  });

  it("a failed pass is recorded and retried on the next tick", async () => {
    let gen = 0;
    housing.generateHousingObligations = async () => { gen++; throw new Error("payee_obligations missing"); };
    housing.runHousingReminders = async () => ({ sent: 0 });
    await startup._awayJobs.runHousingLedgerTick();
    assert.deepEqual(jobHealth._memoryResults.get("housing-ledger"), { status: "error", error: "payee_obligations missing" });
    await startup._awayJobs.runHousingLedgerTick();
    assert.equal(gen, 2, "not settled → retried");
  });
});

// ---------------------------------------------------------------------------
describe("F63 — the insights auto-trigger doesn't rerun a failing chain every 6 hours", () => {
  const startup = require("../teller/startup");
  const enrollments = require("../teller/routes/enrollments");
  const subscriptions = require("../teller/routes/subscriptions");
  const investments = require("../teller/routes/investments");
  const categorize = require("../teller/routes/categorize");
  const transfers = require("../scripts/detect-transfers");
  const insights = require("../teller/routes/insights");
  const saved = {};
  const PATCH = [
    [enrollments, "syncAllTransactions"], [enrollments, "syncAllBalances"],
    [subscriptions, "runSubscriptionDetection"], [investments, "syncAllPlaidHoldings"],
    [investments, "syncAllPlaidInvestmentFlows"], [categorize, "runCategorize"],
    [transfers, "detectRecurringTransfers"], [insights, "generateInsights"],
    [insights, "getAiBudgetCents"], [insights, "monthAiSpendCents"],
  ];
  let calls, stamps, prevKey;
  before(() => {
    prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    for (const [m, k] of PATCH) saved[k] = m[k];
  });
  after(() => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    for (const [m, k] of PATCH) m[k] = saved[k];
    jobHealth._memoryResults.clear();
  });

  function setup({ settings, spend = 0, budget = 500, insight = { ok: true } }) {
    calls = []; stamps = 0;
    for (const [m, k] of PATCH) m[k] = async () => { calls.push(k); return { ok: true }; };
    insights.monthAiSpendCents = async () => spend;
    insights.getAiBudgetCents = async () => budget;
    insights.generateInsights = async () => { calls.push("generateInsights"); return insight; };
    dbModule.pool.query = async (sql) => {
      if (/insights_last_attempt_at FROM user_settings/.test(sql)) return { rows: [settings] };
      if (/SET insights_last_attempt_at = now\(\)/.test(sql)) { stamps++; return { rows: [] }; }
      return { rows: [] };
    };
  }
  const DAY = 86400e3;
  const due = { insights_enabled: true, insights_cadence_days: 30, insights_last_run: new Date(Date.now() - 40 * DAY), insights_last_attempt_at: null };

  it("over the monthly cap: no sync chain, no paid call, no attempt stamp", async () => {
    setup({ settings: due, spend: 600, budget: 500 });
    await startup._awayJobs.runInsightsAutoTriggerTick();
    assert.deepEqual(calls, []);
    assert.equal(stamps, 0);
    assert.equal(jobHealth._memoryResults.get("insights-auto-trigger").status, "ok");
  });

  it("due: stamps the attempt BEFORE running the chain; a failed generate is recorded", async () => {
    setup({ settings: due, insight: { ok: false, status: 502, error: "The model returned no insight text." } });
    await startup._awayJobs.runInsightsAutoTriggerTick();
    assert.equal(stamps, 1);
    assert.equal(calls[0], "syncAllTransactions");
    assert.equal(calls[calls.length - 1], "generateInsights");
    assert.deepEqual(jobHealth._memoryResults.get("insights-auto-trigger"),
      { status: "error", error: "insights: The model returned no insight text." });
  });

  it("a recent failed attempt is not retried until INSIGHTS_RETRY_MS has passed", async () => {
    setup({ settings: { ...due, insights_last_attempt_at: new Date(Date.now() - 6 * 3600e3) } });
    await startup._awayJobs.runInsightsAutoTriggerTick();
    assert.deepEqual(calls, [], "6h after a failed attempt → skip");
    setup({ settings: { ...due, insights_last_attempt_at: new Date(Date.now() - 25 * 3600e3) } });
    await startup._awayJobs.runInsightsAutoTriggerTick();
    assert.ok(calls.includes("generateInsights"), "25h later → retry");
  });

  it("an attempt OLDER than the last successful run doesn't block the next cadence", async () => {
    const lastRun = new Date(Date.now() - 31 * DAY);
    setup({ settings: { ...due, insights_last_run: lastRun, insights_last_attempt_at: new Date(lastRun.getTime() - 1000) } });
    await startup._awayJobs.runInsightsAutoTriggerTick();
    assert.ok(calls.includes("generateInsights"));
  });

  it("not due yet: nothing runs", async () => {
    setup({ settings: { ...due, insights_last_run: new Date(Date.now() - 2 * DAY) } });
    await startup._awayJobs.runInsightsAutoTriggerTick();
    assert.deepEqual(calls, []);
    assert.equal(stamps, 0);
  });

  it("the attempt column is migrated", () => {
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS insights_last_attempt_at TIMESTAMPTZ/);
  });
});

// ---------------------------------------------------------------------------
// generateInsights harness (fake SDK + mock pool) — F63 insert charge, F73
// ---------------------------------------------------------------------------
describe("F63 / F73 — generateInsights charges an unsaved insight and fails on a settings-read error", () => {
  let created = 0;
  class FakeAnthropic {
    constructor() {
      this.messages = { create: async () => {
        created++;
        return { model: "claude-haiku-5-5", stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 300 },
          content: [{ type: "tool_use", name: "generate_financial_insight",
            input: { insights_text: "- Spending is steady.", summary: { trends: [], completed_goals: [], pending_actions: [], alerts: [] } } }] };
      } };
    }
  }
  const originalLoad = Module._load;
  const persistent = require("../teller/routes/persistent");
  const origWebhook = persistent.sendPerSistantWebhook;
  let prevKey;
  before(() => {
    prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve("../teller/routes/insights")];
    persistent.sendPerSistantWebhook = async () => ({ sent: true });
  });
  after(() => {
    Module._load = originalLoad;
    delete require.cache[require.resolve("../teller/routes/insights")];
    persistent.sendPerSistantWebhook = origWebhook;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  function pool({ settingsThrows = false, insightInsertThrows = false }) {
    const st = { inserts: [], summaryUpdates: 0 };
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("ai_monthly_budget_cents")) return { rows: [{ ai_monthly_budget_cents: 5000 }] };
      if (sql.includes("insight_modules FROM user_settings")) {
        if (settingsThrows) throw new Error("connection terminated unexpectedly");
        return { rows: [{ insights_model: "haiku", insight_modules: {}, insights_running_summary_json: null, insights_running_summary: null }] };
      }
      if (sql.includes("INSERT INTO financial_insights")) {
        st.inserts.push({ sql, params });
        if (insightInsertThrows && !/'insight_unsaved'/.test(sql)) throw new Error("disk full");
        return { rows: [{ id: 9 }] };
      }
      if (/UPDATE user_settings SET insights_running_summary/.test(sql)) { st.summaryUpdates++; return { rows: [] }; }
      if (/COUNT\(\*\) AS cnt/.test(sql)) return { rows: [{ cnt: 0, monthly: 0 }] };
      return { rows: [] };
    };
    return st;
  }

  it("F73: a failed settings read returns an error BEFORE the Claude call and writes nothing", async () => {
    created = 0;
    const st = pool({ settingsThrows: true });
    const r = await require("../teller/routes/insights").generateInsights();
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
    assert.equal(created, 0, "no paid call on a defaulted model / empty memory");
    assert.equal(st.inserts.length, 0);
    assert.equal(st.summaryUpdates, 0, "stored long-term memory is never overwritten");
  });

  it("F63: when the insight row can't be written the tokens are still charged ('insight_unsaved')", async () => {
    created = 0;
    const st = pool({ insightInsertThrows: true });
    const r = await require("../teller/routes/insights").generateInsights();
    assert.equal(created, 1);
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
    const charge = st.inserts.find((i) => /'insight_unsaved'/.test(i.sql));
    assert.ok(charge, "a usage row is written");
    assert.deepEqual(charge.params.slice(1, 4), ["claude-haiku-5-5", 1300, 1000]);
    assert.equal(st.summaryUpdates, 0, "no summary update for an unsaved insight");
  });
});

// ---------------------------------------------------------------------------
describe("F23 — wholesale and thrown sync failures are recorded", () => {
  const enrollments = require("../teller/routes/enrollments");
  let stored;
  function fakePool() {
    dbModule.pool.query = async (sql, params) => {
      if (/SELECT last_sync_result FROM user_settings/.test(sql)) return { rows: [{ last_sync_result: stored || null }] };
      if (/UPDATE user_settings SET last_sync_result/.test(sql)) { stored = JSON.parse(params[0]); return { rows: [] }; }
      return { rows: [] };
    };
  }
  beforeEach(() => { stored = undefined; });

  it("{ ok:false, error } with no errors[] is an error entry, not a clean run", async () => {
    fakePool();
    const r = await enrollments.recordSyncResult([
      { provider: "plaid_holdings", result: { ok: false, error: "INVALID_ACCESS_TOKEN" } },
      { provider: "plaid_flows", result: { ok: false, error: "An internal error occurred." } },
    ]);
    assert.deepEqual(r.errors.map((e) => [e.provider, e.error]),
      [["plaid_flows", "An internal error occurred."], ["plaid_holdings", "INVALID_ACCESS_TOKEN"]]);
  });

  it("'Plaid not configured' is skipped, keeping that provider's previous entry", async () => {
    fakePool();
    await enrollments.recordSyncResult([{ provider: "plaid_balance", result: { errors: [{ institution: "Discover", error: "ITEM_LOGIN_REQUIRED" }] } }]);
    const r = await enrollments.recordSyncResult([{ provider: "plaid_balance", result: { ok: false, error: "Plaid not configured" } }]);
    assert.deepEqual(r.errors.map((e) => e.error), ["ITEM_LOGIN_REQUIRED"]);
  });

  it("thrownSyncResult turns a throw into one error entry", async () => {
    fakePool();
    const r = await enrollments.recordSyncResult([{ provider: "teller_reconcile", result: enrollments.thrownSyncResult(new Error("ECONNRESET")) }]);
    assert.deepEqual(r.errors, [{ provider: "teller_reconcile", institution: null, error: "ECONNRESET" }]);
  });

  it("POST /api/sync-balances: a Teller throw is recorded, Plaid still refreshes, and it still answers 500", async () => {
    fakePool();
    const investments = require("../teller/routes/investments");
    const saved = { b: enrollments.syncAllBalances, pb: investments.syncAllPlaidBalances, h: investments.syncAllPlaidHoldings, f: investments.syncAllPlaidInvestmentFlows };
    let plaidCalled = false;
    try {
      // The route calls the module-local syncAllBalances, so make Teller throw
      // from inside it: its first query is the enrollments read.
      dbModule.pool.query = async (sql, params) => {
        if (/SELECT last_sync_result FROM user_settings/.test(sql)) return { rows: [{ last_sync_result: stored || null }] };
        if (/UPDATE user_settings SET last_sync_result/.test(sql)) { stored = JSON.parse(params[0]); return { rows: [] }; }
        if (/FROM teller_enrollments/.test(sql)) throw new Error("teller enrollments read failed");
        return { rows: [] };
      };
      investments.syncAllPlaidBalances = async () => { plaidCalled = true; return { accounts_updated: 2 }; };
      investments.syncAllPlaidHoldings = async () => ({ ok: false, error: "Plaid not configured" });
      investments.syncAllPlaidInvestmentFlows = async () => ({ ok: false, error: "Plaid not configured" });
      const app = express(); app.use(express.json()); app.use(enrollments);
      await supertest(app).post("/api/sync-balances").expect(500);
      assert.equal(plaidCalled, true);
      assert.deepEqual(stored.providers.teller_balance.errors.map((e) => e.error), ["teller enrollments read failed"]);
      assert.equal(stored.providers.plaid_holdings, undefined, "not configured → not recorded");
    } finally {
      investments.syncAllPlaidBalances = saved.pb; investments.syncAllPlaidHoldings = saved.h; investments.syncAllPlaidInvestmentFlows = saved.f;
    }
  });

  it("the auto-sync and the weekly reconcile record a thrown step", () => {
    const src = read("teller", "startup.js");
    for (const p of ["teller_txn", "plaid_holdings", "plaid_flows", "teller_balance"]) {
      assert.match(src, new RegExp(`threw\\.${p} = e;`), p);
      assert.match(src, new RegExp(`provider: "${p}", result: orThrew\\("${p}"`), p);
    }
    assert.match(src, /recordSyncResult\(\[\{ provider: "teller_reconcile", result: thrownSyncResult\(err\) \}\]\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F69 — an audit whose findings couldn't be stored is not 'clean'", () => {
  it("marks the run audit_incomplete when a finding INSERT fails", async () => {
    let marker = null;
    dbModule.pool.query = async (sql, params) => {
      if (/INSERT INTO ai_audit_log/.test(sql)) throw new Error("ai_audit_log: permission denied");
      if (/UPDATE financial_insights SET audited_at/.test(sql)) { marker = params; return { rows: [] }; }
      if (/COUNT\(\*\) AS cnt/.test(sql)) return { rows: [{ cnt: 0, monthly: 0 }] };
      return { rows: [] };
    };
    const errors = [];
    const origError = console.error;
    console.error = (...a) => { errors.push(a.join(" ")); };
    const { auditInsight } = require("../teller/services/ai-audit");
    let r;
    try { r = await auditInsight("- Dining spending increased 20% this month.\n- Dining spending decreased sharply this month.", 42); }
    finally { console.error = origError; }
    assert.deepEqual(errors.filter((e) => /Audit Tier/.test(e)), [], "every tier completed — only the INSERT failed");
    assert.ok(r.findings.length >= 1, "the contradiction is found");
    assert.equal(r.incomplete, true);
    assert.deepEqual(marker, [true, 42]);
  });
});

// ---------------------------------------------------------------------------
describe("F14 — the compromised Teller cert is visible, not just a log line", () => {
  function pemOf(der) {
    return "-----BEGIN CERTIFICATE-----\n" + der.toString("base64").match(/.{1,64}/g).join("\n") + "\n-----END CERTIFICATE-----\n";
  }
  function withEnv(env, fn) {
    const keys = ["TELLER_CERT", "TELLER_KEY", "TELLER_CERT_PATH", "TELLER_KEY_PATH"];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve("../teller/services/teller-api")];
    try { return fn(require("../teller/services/teller-api")); }
    finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
      delete require.cache[require.resolve("../teller/services/teller-api")];
    }
  }

  it("tellerCertStatus reads the configured cert without throwing", () => {
    const der = crypto.randomBytes(64);
    withEnv({ TELLER_CERT: Buffer.from(pemOf(der)).toString("base64"), TELLER_KEY: Buffer.from("k").toString("base64") }, (api) => {
      const s = api.tellerCertStatus();
      assert.equal(s.configured, true);
      assert.equal(s.compromised, false);
      assert.equal(s.fingerprint, crypto.createHash("sha256").update(der).digest("hex"));
    });
    withEnv({ TELLER_CERT_PATH: "/nonexistent/cert.pem", TELLER_KEY_PATH: "/nonexistent/key.pem" }, (api) => {
      assert.deepEqual(api.tellerCertStatus(), { configured: false, compromised: false, fingerprint: null });
    });
  });

  it("data-health raises it as an issue, and boot logs it", async () => {
    const api = require("../teller/services/teller-api");
    const orig = api.tellerCertStatus;
    api.tellerCertStatus = () => ({ configured: true, compromised: true, fingerprint: api.COMPROMISED_CERT_SHA256 });
    try {
      dbModule.pool.query = async (sql) => {
        if (/FROM user_settings/.test(sql)) return { rows: [{ last_txn_sync_at: new Date(), last_balance_sync_at: new Date() }] };
        return { rows: [{ total: 0, disconnected: 0, not_good: 0 }] };
      };
      const app = express(); app.use(require("../teller/routes/settings"));
      const res = await supertest(app).get("/api/data-health").expect(200);
      assert.ok(res.body.issues.some((i) => /Teller certificate in use is the one exposed in git history/.test(i.message)));
    } finally { api.tellerCertStatus = orig; }
    assert.match(read("teller", "startup.js"), /if \(tellerCertStatus\(\)\.compromised\) console\.error\(COMPROMISED_CERT_WARNING\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F5 / F16 — workflows", () => {
  it("daily-sync: the backstop steps run independently and a timeout is reported", () => {
    const yaml = read(".github", "workflows", "daily-sync.yml");
    for (const step of ["Sync balances + holdings + investment flows", "Net worth snapshot", "Run subscription detection", "Check for new/changed subscriptions"]) {
      const block = yaml.slice(yaml.indexOf("- name: " + step));
      assert.match(block.slice(0, 200), /if: \$\{\{ !cancelled\(\) \}\}/, step);
    }
    assert.match(yaml, /if \[ "\$2" = "000" \]; then[\s\S]*?::error::\$1: no response \(timed out or server unreachable\)/);
    assert.equal((yaml.match(/-H "Content-Type: application\/json"\) \|\| true/g) || []).length, 4, "curl failures don't kill the step before it reports");
    assert.equal((yaml.match(/check_status "/g) || []).length, 4);
    assert.match(yaml, /--max-time 420/);
  });

  it("every workflow declares least-privilege permissions", () => {
    const dir = path.join(ROOT, ".github", "workflows");
    for (const f of fs.readdirSync(dir)) {
      const yaml = fs.readFileSync(path.join(dir, f), "utf8");
      const want = f === "csv-import.yml" ? "write" : "read";
      assert.match(yaml, new RegExp(`^permissions:\\n  contents: ${want}$`, "m"), f);
    }
  });
});

// ---------------------------------------------------------------------------
describe("F16 — hygiene", () => {
  it("POST /api/notifications/test answers a generic error", async () => {
    const originalLoad = Module._load;
    process.env.VAPID_PUBLIC_KEY = "pub"; process.env.VAPID_PRIVATE_KEY = "priv";
    Module._load = function (request) {
      if (request === "web-push") return { setVapidDetails() {}, async sendNotification() {} };
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve("../teller/routes/notifications")];
    try {
      const notifications = require("../teller/routes/notifications");
      dbModule.pool.query = async () => { throw new Error("password authentication failed for user neondb_owner"); };
      const app = express(); app.use(express.json()); app.use(notifications);
      const res = await supertest(app).post("/api/notifications/test").expect(500);
      assert.deepEqual(res.body, { error: "An internal error occurred." });
    } finally {
      Module._load = originalLoad;
      delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
      delete require.cache[require.resolve("../teller/routes/notifications")];
    }
  });

  it("shutdown stops both apps' scheduled jobs before draining the pools", () => {
    const shell = read("shell", "index.js");
    const fn = shell.slice(shell.indexOf("function shutdown(signal)"));
    assert.ok(fn.indexOf("perfin.stopBackgroundJobs()") < fn.indexOf("server.close("));
    assert.ok(fn.indexOf("persistent.stopJobs()") < fn.indexOf("server.close("));
    assert.match(read("teller", "server.js"), /module\.exports = \{ app, start, pool, stopBackgroundJobs \}/);
    const ps = read("apps", "per-sistant", "server.js");
    assert.equal((ps.match(/cron\.schedule\(/g) || []).length, (ps.match(/cronTasks\.push\(cron\.schedule\(/g) || []).length,
      "every Per-sistant cron task is tracked so stopJobs can stop it");
    assert.match(ps, /module\.exports = \{ app, pool, start, stopJobs,/);
  });
});

// ---------------------------------------------------------------------------
// Policy (cycle-6 Silent Degradation response): no NEW bare catch in server
// code. A catch that swallows an error must say why (a comment inside it) or
// log it. KNOWN_GAPS holds the existing offenders as per-file counts with a
// reason: a count that grows fails (new offender), one that shrinks fails too
// (update the list) — so it only ever shrinks. `ROLLBACK").catch(() => {})`
// inside an error path is the one sanctioned idiom (the original error is
// already being handled). Browser code (public/, pages/, views/) is out of
// scope — client-side best-effort catches are a different trade-off.
// ---------------------------------------------------------------------------
describe("Policy — empty-catch scan", () => {
  const SCOPES = ["teller/routes", "teller/services", "teller/startup.js", "teller/server.js", "teller/data",
    "shell/index.js", "shell/middleware", "apps/per-sistant/routes", "apps/per-sistant/services",
    "apps/per-sistant/server.js", "apps/per-sistant/ai.js", "apps/per-sistant/config.js", "apps/per-sistant/db.js",
    "apps/per-sistant/errors.js", "apps/per-sistant/helpers.js", "apps/per-sistant/middleware.js", "scripts"];
  const EMPTY = /catch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*(\{\s*\}|null|undefined)\s*\)/g;
  const KNOWN_GAPS = {
    "teller/routes/categorize.js": [1, "times_applied counter bump — cosmetic"],
    "teller/routes/persistent.js": [4, "productivity-context fetches fail soft to null (the widget shows 'not connected')"],
    "teller/routes/settings.js": [2, "cache invalidation hooks after a settings PATCH (next TTL refresh catches up)"],
    "teller/server.js": [1, "CORS origin URL parse — an unparsable Origin falls through to the allowlist"],
    "shell/index.js": [2, "pool.end() during shutdown"],
    "apps/per-sistant/routes/ai.js": [1, "gatherHealthSummary fail-soft (INV-52)"],
    "apps/per-sistant/routes/auth.js": [1, "session timeout read falls back to the default"],
    "apps/per-sistant/routes/emails.js": [2, "automation fire-and-forget; failed-status write after a send error"],
    "apps/per-sistant/routes/health.js": [1, "streak-milestone webhook fire-and-forget"],
    "apps/per-sistant/routes/jobs.js": [2, "company score bump; profile embedding reset"],
    "apps/per-sistant/routes/notes.js": [1, "automation fire-and-forget"],
    "apps/per-sistant/routes/rag.js": [5, "status counts and keyword-search legs fail soft (INV-29); reindex kick-off"],
    "apps/per-sistant/routes/todos.js": [6, "automation / webhook fire-and-forget"],
    "apps/per-sistant/routes/trash.js": [2, "chunk / embed_state cleanup on note purge"],
    "apps/per-sistant/services/vault-sync.js": [3, "attempt / error stamps and a cache write"],
    "apps/per-sistant/helpers.js": [3, "outbound webhook / Slack delivery (recorded on the webhook row elsewhere)"], // 4 → 3: fireWebhooks logs since cycle-7 F116
  };

  function files(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isFile()) return rel.endsWith(".js") ? [rel] : [];
    return fs.readdirSync(abs).filter((f) => f !== "node_modules").flatMap((f) => files(path.join(rel, f)));
  }
  function count(rel) {
    return fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/ROLLBACK"\)\.catch\(\(\) => \{\}\)/.test(l))
      .reduce((a, l) => a + (l.match(EMPTY) || []).length, 0);
  }

  it("no new bare catch, and no stale KNOWN_GAPS entry", () => {
    const actual = {};
    for (const f of SCOPES.flatMap(files)) {
      const n = count(f);
      if (n) actual[f.split(path.sep).join("/")] = n;
    }
    for (const [f, n] of Object.entries(actual)) {
      const known = KNOWN_GAPS[f] ? KNOWN_GAPS[f][0] : 0;
      assert.ok(n <= known, `${f}: ${n} bare catch(es), ${known} known — log the error or comment why it's safe to ignore`);
    }
    for (const [f, [n]] of Object.entries(KNOWN_GAPS)) {
      assert.equal(actual[f] || 0, n, `${f}: KNOWN_GAPS lists ${n} but ${actual[f] || 0} remain — shrink the entry`);
    }
  });

  it("the files this batch touched carry no bare catch", () => {
    for (const f of ["teller/startup.js", "teller/routes/enrollments.js", "teller/routes/insights.js", "teller/services/job-health.js", "teller/services/teller-api.js"]) {
      assert.equal(count(f), 0, f);
    }
  });
});
