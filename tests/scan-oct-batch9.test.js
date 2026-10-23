// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 9 — Sheets and cross-app
// ============================================================================
// The database-backed half (Utilities / Important Dates placement, the Credit
// Scores change, notification retention, the in-process digest draft) lives in
// tests/contract/sheets-crossapp.contract.test.js. This file covers what needs
// no database:
// F75   the Sheets Avg Monthly / Daily Spend over completed months
// F77   resetFormats on the Income, AI Trust and Watchlist tabs
// F78   Sheets sync single-flight
// F79   a draft-only digest is not "sent", and settles the day
// F80   Per-sistant's Perfin widget figures
// F83   the formula guard lets plain signed numbers through
// F84   Code.gs guards what it writes
// F86   settings 400s, the dashboard env check, failed partial syncs
//       recorded, notification_log pruned once a day
// F44   the income-predicate comment
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
process.env.GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "sheet-test-id";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const sheetsSync = require("../scripts/sheets-sync");
const I = sheetsSync._internals;

// ---------------------------------------------------------------------------
describe("F75 — Sheets KPI averages over completed months", () => {
  it("the month to date is left out; days are real month lengths", () => {
    const r = I.completedMonthAverages([
      { month: "2026-08", total: "3100" }, { month: "2026-09", total: "1500" }, { month: "2026-10", total: "200" },
    ], "2026-10");
    assert.equal(r.avgMonthlySpend, 2300);
    assert.equal(r.avgDailySpend, 4600 / 61);
  });
  it("no completed month yet → blank cells, not a fake average", () => {
    assert.deepEqual(I.completedMonthAverages([{ month: "2026-10", total: "200" }], "2026-10"), { avgMonthlySpend: "", avgDailySpend: "" });
  });
  it("the dashboard no longer divides the 6-month window by 6", () => {
    assert.doesNotMatch(read("scripts", "sheets-sync.js"), /total6mo \/ 6/);
  });
});

// ---------------------------------------------------------------------------
describe("F77 / F78 / F83 — Sheets formatting, single-flight, number cells", () => {
  it("Income, AI Trust and Watchlist reset formats before re-adding them", () => {
    const src = read("scripts", "sheets-sync.js");
    for (const fn of ["syncIncome", "syncAiTrust", "syncWatchlist"]) {
      const start = src.indexOf(`async function ${fn}(`);
      const body = src.slice(start, src.indexOf("\nasync function ", start + 10));
      assert.match(body, /formatSheet\(sheets, sheetId, requests, \{ resetFormats: true \}\)/, fn);
    }
  });

  it("the same kind of run shares one promise; a different kind waits for it", async () => {
    const log = [];
    let release;
    const first = I.singleFlight("all", () => new Promise((r) => { log.push("all:start"); release = () => { log.push("all:end"); r("A"); }; }));
    const again = I.singleFlight("all", async () => { log.push("all:second"); return "B"; });
    const dash = I.singleFlight("dashboard", async () => { log.push("dashboard"); return "D"; });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, ["all:start"], "the dashboard run waits for the running sync");
    release();
    assert.equal(await first, "A");
    assert.equal(await again, "A", "the second caller got the first run's result");
    assert.equal(await dash, "D");
    assert.deepEqual(log, ["all:start", "all:end", "dashboard"]);
    // After it settles, a new run starts fresh.
    assert.equal(await I.singleFlight("all", async () => "C"), "C");
  });

  it("plain signed numbers / amounts / percentages are not turned into text", () => {
    for (const v of ["-12.5%", "-$45.00", "+20", "-1,234.56", "12"]) assert.equal(I.guardCell(v), v, v);
    for (const v of ["=SUM(A1)", "-1+2", "- bullet", "@x", "7-11", "+A1"]) assert.equal(I.guardCell(v), "'" + v, v);
  });
});

// ---------------------------------------------------------------------------
describe("F84 — Code.gs formula guard", () => {
  const src = read("apps-script", "Code.gs");
  it("guardCell_ prefixes formula-like text and passes numbers", () => {
    const start = src.indexOf("var PLAIN_NUMBER_RE_");
    const end = src.indexOf("\n}\n", src.indexOf("function guardRows_")) + 3;
    const ctx = {};
    vm.runInNewContext(src.slice(start, end) + ";this.g=guardRows_;", ctx);
    assert.deepEqual(ctx.g([["=IMPORTXML(\"x\")", "-$5.00", "Shop", 3, "+cmd"]]), [["'=IMPORTXML(\"x\")", "-$5.00", "Shop", 3, "'+cmd"]]);
  });
  it("every setValues / appendRow of data goes through guardRows_", () => {
    const writes = src.match(/\.(setValues|appendRow)\(/g).length;
    const guarded = (src.match(/\.(setValues|appendRow)\(guardRows_\(/g) || []).length;
    const headerOnly = (src.match(/\.setValues\(\[headers\]\)/g) || []).length;
    assert.equal(guarded + headerOnly, writes, "only the fixed header rows are written unguarded");
  });
});

// ---------------------------------------------------------------------------
describe("F80 — Per-sistant's Perfin widget", () => {
  const { widgetFigures } = require("../apps/per-sistant/routes/perfin");
  it("monthly cost = every subscription's monthly equivalent; a charge due today is upcoming", () => {
    const r = widgetFigures([
      { amount: "15", cadence_days: 30, next_expected: new Date(2026, 9, 20) },
      { amount: "120", cadence_days: 365, next_expected: "2026-10-27" },
      { amount: "30", cadence_days: 90, next_expected: "2026-10-28" },
    ], "2026-10-20");
    assert.equal(r.monthly_cost, (15 + 120 * 30 / 365 + 30 * 30 / 90).toFixed(2));
    assert.deepEqual(r.upcoming.map((s) => s.amount), ["15", "120"], "today through today + 7");
  });
});

// ---------------------------------------------------------------------------
describe("F79 — a draft-only digest", () => {
  it("in-process delivery reports a draft as not sent", async () => {
    const persistent = require("../teller/routes/persistent");
    const inserted = [];
    persistent.setEmbeddedPersistentPool({ query: async (sql, p) => {
      if (/perfin_webhook_recipient/.test(sql)) return { rows: [{ perfin_webhook_recipient: "Bob" }] };
      inserted.push({ sql, p }); return { rows: [] };
    } });
    try {
      const r = await persistent.sendPerSistantWebhook("daily_summary", { subject: "s", plain_text: "b" });
      assert.deepEqual({ sent: r.sent, reason: r.reason, stored: r.stored }, { sent: false, reason: "invalid_recipient", stored: "draft" });
      assert.match(inserted[0].sql, /'draft'/);
    } finally { persistent.setEmbeddedPersistentPool(null); }
  });

  it("the daily tick settles for the day on a draft (no hourly drafts) and reports it as a failure", async () => {
    const startup = require("../teller/startup");
    const insights = require("../teller/routes/insights");
    const jobHealth = require("../teller/services/job-health");
    const orig = { run: insights.runDailyDigest, hour: insights.DAILY_DIGEST_HOUR, result: jobHealth.result };
    let calls = 0;
    const results = [];
    insights.runDailyDigest = async () => { calls++; return { sent: false, reason: "no_recipient_configured" }; };
    insights.DAILY_DIGEST_HOUR = -1;
    jobHealth.result = (name, r) => { if (name === "daily-digest") results.push(r); };
    try {
      startup._awayJobs.reset();
      await startup._awayJobs.runDailyDigestTick();
      await startup._awayJobs.runDailyDigestTick();
      assert.equal(calls, 1, "the second hourly tick doesn't run (and store) it again");
      assert.equal(results[0].ok, false);
    } finally {
      insights.runDailyDigest = orig.run; insights.DAILY_DIGEST_HOUR = orig.hour; jobHealth.result = orig.result;
      startup._awayJobs.reset();
    }
  });
});

// ---------------------------------------------------------------------------
describe("F86 — validation bundle", () => {
  function settingsApp() {
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/settings"));
    return app;
  }
  it("an invalid settings value is a 400, not a silent drop + 200", async () => {
    let wrote = false;
    dbModule.pool.query = async (sql) => { if (/UPDATE user_settings SET/.test(sql)) wrote = true; return { rows: [{}] }; };
    const app = settingsApp();
    for (const body of [
      { theme: "purple" }, { dashboard_months: "6abc" }, { dashboard_months: 99 }, { insights_model: "gpt" },
      { insights_cadence_days: 45 }, { pyramid_data_source: "x" }, { pyramid_color_mode: "x" },
      { debt_baseline_amount: "abc" }, { sheets_auto_sync_interval: "hourly" }, { dashboard_widgets: [1] },
      { insight_modules: "x" }, { session_timeout_minutes: "15x" }, { shell_idle_timeout_minutes: "30abc" },
    ]) {
      const r = await supertest(app).patch("/api/settings").send(body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(wrote, false);
    const ok = await supertest(app).patch("/api/settings").send({ dashboard_months: "12", theme: "light", shell_idle_timeout_minutes: "30" });
    assert.equal(ok.status, 200);
  });

  it("/api/sheets/dashboard checks the Sheets env like the other endpoints", async () => {
    const prev = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    try {
      const r = await supertest(settingsApp()).post("/api/sheets/dashboard");
      if (r.status !== 501) assert.equal(r.status, 400); // 501 when googleapis isn't installed
    } finally { if (prev !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_KEY = prev; }
  });

  it("a failed partial sync is recorded; a partial success isn't", async () => {
    const src = read("teller", "routes", "settings.js");
    assert.match(src, /recordSheetsSyncResult\(\{ errors: \[\{ step: "transactions", error: err\.message \}\] \}\)/);
    assert.match(src, /recordSheetsSyncResult\(\{ errors: \[\{ step: "dashboard", error: err\.message \}\] \}\)/);
  });

  it("notification_log is pruned at most once a day, read rows past the window only", async () => {
    const n = require("../teller/routes/notifications");
    const seen = [];
    dbModule.pool.query = async (sql, p) => { seen.push({ sql, p }); return { rows: [] }; };
    const t0 = Date.now() + 10 * 86400000;
    await n.pruneNotificationLog(t0);
    await n.pruneNotificationLog(t0 + 3600 * 1000);
    const deletes = seen.filter((q) => /DELETE FROM notification_log/.test(q.sql));
    assert.equal(deletes.length, 1);
    assert.match(deletes[0].sql, /is_read = true AND created_at < now\(\) - make_interval\(days => \$1\)/);
    assert.deepEqual(deletes[0].p, [n.NOTIFICATION_RETENTION_DAYS]);
  });

  it("F44: the income-predicate comment describes the four branches", () => {
    assert.match(read("teller", "services", "financial-queries.js"), /Structured as four OR branches/);
  });
});
