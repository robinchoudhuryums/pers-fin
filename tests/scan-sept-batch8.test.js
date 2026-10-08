// ============================================================================
// Broad-scan (Sept 2026) Batch 8 regression tests — notifications & schedulers
// (Perfin side; Per-sistant pins live in apps/per-sistant/tests/scan-sept-batch8.test.js)
// ============================================================================
// PSC-1 / DD-7  auto-sync reads sync_notifications_enabled; only balances that
//               actually moved count as activity (accounts_changed)
// PSC-3  digests, budget alerts and the CSV reminder are watermark-gated, not
//        activity-gated, with a per-local-day memo to keep Neon idle-friendly
// PSC-2  the keep-alive.yml probe doesn't count as activity and is served from
//        a cache (no Neon query per probe)
// PSC-12 runCategorize / syncAllTransactions / syncAllBalances are single-flight
// DD-5   balance deltas: baseline before the watermark's day, same-day current
// DD-6   credit/loan deltas coloured as debt; signs before the "$"
// ============================================================================

delete process.env.APP_TIMEZONE;
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

// ---------------------------------------------------------------------------
// PSC-1 / DD-7
// ---------------------------------------------------------------------------
describe("PSC-1 / DD-7 — auto-sync notification gate", () => {
  const tellerApi = require("../teller/services/teller-api");
  const origTeller = tellerApi.tellerRequest;
  let enr;
  before(() => {
    tellerApi.tellerRequest = async (ep) => {
      if (ep === "/accounts") return [{ id: "a1", name: "Checking", type: "depository" }, { id: "a2", name: "Savings", type: "depository" }];
      return { available: "100.00", ledger: "100.00" };
    };
    delete require.cache[require.resolve("../teller/routes/enrollments")];
    enr = require("../teller/routes/enrollments");
  });
  after(() => {
    tellerApi.tellerRequest = origTeller;
    delete require.cache[require.resolve("../teller/routes/enrollments")];
  });

  it("syncAllBalances counts accounts_changed only for balances that moved", async () => {
    let n = 0;
    dbModule.pool.query = async (sql, p) => {
      if (/FROM teller_enrollments WHERE status = 'GOOD'/.test(sql)) return { rows: [{ id: 1, enrollment_id: "e", institution_name: "Bank", access_token: "tok" }] };
      if (/UPDATE linked_accounts la/.test(sql)) {
        n++;
        // a1 unchanged, a2 moved
        return { rows: [{ id: n, changed: p[2] === "a2" }] };
      }
      return { rows: [] };
    };
    const out = await enr.syncAllBalances();
    assert.equal(out.accounts_updated, 2, "both refreshed");
    assert.equal(out.accounts_changed, 1, "only a2 moved");
  });

  it("the balance UPDATE compares against the pre-update values at column precision", () => {
    const src = read("teller", "routes", "enrollments.js");
    assert.match(src, /WITH prev AS \(\s*SELECT id, available_balance, current_balance FROM linked_accounts WHERE account_id = \$3/);
    assert.match(src, /prev\.available_balance IS DISTINCT FROM ROUND\(\$1::numeric, 2\)/);
  });

  it("the auto-sync reads the toggle and gates on accounts_changed", () => {
    const src = read("teller", "startup.js");
    assert.match(src, /last_sync_result, sync_notifications_enabled FROM user_settings/);
    assert.match(src, /const anyChanged = txnsAdded > 0 \|\| balancesChanged > 0;/);
    assert.doesNotMatch(src, /balancesUpdated > 0/);
  });
});

// ---------------------------------------------------------------------------
// PSC-3 — "away" jobs
// ---------------------------------------------------------------------------
describe("PSC-3 — digests / alerts / CSV reminder are watermark-gated", () => {
  const startup = require("../teller/startup");
  const insights = require("../teller/routes/insights");
  const fq = require("../teller/services/financial-queries");
  const origWeekly = insights.runWeeklyDigest;
  const origDaily = insights.runDailyDigest;
  const origHour = insights.DAILY_DIGEST_HOUR;
  afterEach(() => {
    insights.runWeeklyDigest = origWeekly;
    insights.runDailyDigest = origDaily;
    insights.DAILY_DIGEST_HOUR = origHour;
    startup._awayJobs.reset();
  });
  const weekday = new Date(fq.todayStr() + "T00:00:00Z").getUTCDay();

  it("no away job consults the activity gate", () => {
    const src = read("teller", "startup.js");
    for (const fn of ["runBudgetAlertTick", "runWeeklyDigestTick", "runDailyDigestTick", "runCsvReminderTick"]) {
      const body = src.slice(src.indexOf("async function " + fn + "()"));
      const end = body.indexOf("\n}\n");
      assert.doesNotMatch(body.slice(0, end), /isUserActive\(\)/, fn);
    }
  });

  it("weekly digest: runs on the configured day, then skips its DB read for the rest of the day", async () => {
    let queries = 0, runs = 0;
    dbModule.pool.query = async () => { queries++; return { rows: [{ weekly_digest_enabled: true, weekly_digest_day: weekday }] }; };
    insights.runWeeklyDigest = async () => { runs++; return { sent: true }; };
    await startup._awayJobs.runWeeklyDigestTick();
    await startup._awayJobs.runWeeklyDigestTick();
    assert.equal(runs, 1);
    assert.equal(queries, 1, "second tick of the day: no DB read");
  });

  it("weekly digest: a failed send stays unsettled and retries next tick", async () => {
    let runs = 0;
    dbModule.pool.query = async () => ({ rows: [{ weekly_digest_enabled: true, weekly_digest_day: weekday }] });
    insights.runWeeklyDigest = async () => { runs++; return { sent: false, reason: "webhook_failed" }; };
    await startup._awayJobs.runWeeklyDigestTick();
    await startup._awayJobs.runWeeklyDigestTick();
    assert.equal(runs, 2);
  });

  it("daily digest: before the send hour no DB read; after it, once per day", async () => {
    let runs = 0;
    insights.runDailyDigest = async () => { runs++; return { sent: false, reason: "nothing_new" }; };
    insights.DAILY_DIGEST_HOUR = 25; // always "too early"
    await startup._awayJobs.runDailyDigestTick();
    assert.equal(runs, 0);
    insights.DAILY_DIGEST_HOUR = 0;
    await startup._awayJobs.runDailyDigestTick();
    await startup._awayJobs.runDailyDigestTick();
    assert.equal(runs, 1, "settled after the first evaluation");
  });

  it("CSV reminder: a reminder within 24h → no stale-account query; otherwise evaluate + stamp", async () => {
    const seen = [];
    dbModule.pool.query = async (sql) => {
      seen.push(sql);
      if (/csv_reminder_enabled/.test(sql)) return { rows: [{ csv_reminder_enabled: true, csv_reminder_days: 14, last_csv_reminder_at: new Date(Date.now() - 3600e3) }] };
      return { rows: [] };
    };
    await startup._awayJobs.runCsvReminderTick();
    assert.ok(!seen.some((s) => /FROM linked_accounts la/.test(s)));
    startup._awayJobs.reset();
    seen.length = 0;
    dbModule.pool.query = async (sql) => {
      seen.push(sql);
      if (/csv_reminder_enabled/.test(sql)) return { rows: [{ csv_reminder_enabled: true, csv_reminder_days: 14, last_csv_reminder_at: null }] };
      return { rows: [] };
    };
    await startup._awayJobs.runCsvReminderTick();
    assert.ok(seen.some((s) => /FROM linked_accounts la/.test(s)), "stale accounts evaluated");
    assert.ok(seen.some((s) => /SET last_csv_reminder_at = now\(\)/.test(s)), "watermark stamped");
  });

  it("the CSV reminder ticks hourly (watchdog interval follows)", () => {
    assert.equal(require("../teller/services/job-health").JOB_INTERVALS_MS["csv-reminder"], 3600e3);
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS last_csv_reminder_at TIMESTAMPTZ/);
  });

  it("budget alerts run without recent user activity", async () => {
    let read_ = false;
    dbModule.pool.query = async (sql) => { if (/FROM budgets/.test(sql)) read_ = true; return { rows: [] }; };
    await startup._awayJobs.runBudgetAlertTick();
    assert.ok(read_, "budgets queried");
  });
});

// ---------------------------------------------------------------------------
// PSC-2 — keep-alive probe
// ---------------------------------------------------------------------------
describe("PSC-2 — keep-alive probe neither counts as activity nor queries Neon each time", () => {
  it("touchActivity excludes /api/keep-alive-schedule; the route uses the cache", () => {
    const src = read("teller", "server.js");
    assert.match(src, /req\.path !== "\/api\/keep-alive-schedule"\)/);
    assert.match(src, /const config = await getKeepAliveConfigCached\(\);/);
  });
  it("the schedule is cached until a keep_alive_* settings change invalidates it", async () => {
    const ka = require("../teller/services/keep-alive");
    ka.invalidateKeepAliveCache();
    let q = 0;
    dbModule.pool.query = async () => { q++; return { rows: [{ keep_alive_enabled: true, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "UTC" }] }; };
    await ka.getKeepAliveConfigCached();
    await ka.getKeepAliveConfigCached();
    assert.equal(q, 1);
    ka.invalidateKeepAliveCache();
    await ka.getKeepAliveConfigCached();
    assert.equal(q, 2);
    assert.match(read("teller", "routes", "settings.js"), /k\.startsWith\("keep_alive_"\)[\s\S]{0,120}invalidateKeepAliveCache\(\)/);
  });
});

// ---------------------------------------------------------------------------
// PSC-12 — single-flight
// ---------------------------------------------------------------------------
describe("PSC-12 — concurrent callers share one run", () => {
  it("runCategorize", async () => {
    const { runCategorize } = require("../teller/routes/categorize");
    const a = runCategorize(); const b = runCategorize();
    assert.equal(a, b, "same in-flight promise");
    await a;
    assert.notEqual(runCategorize(), a, "a later call starts a new run");
  });
  it("syncAllTransactions / syncAllBalances", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const enr = require("../teller/routes/enrollments");
    const a = enr.syncAllTransactions(); const b = enr.syncAllTransactions();
    assert.equal(a, b);
    const c = enr.syncAllBalances(); const d = enr.syncAllBalances();
    assert.equal(c, d);
    await Promise.allSettled([a, c]);
  });
});

// ---------------------------------------------------------------------------
// DD-5 / DD-6
// ---------------------------------------------------------------------------
describe("DD-5 / DD-6 — balance deltas", () => {
  const { gatherWhatsNew } = require("../teller/routes/whats-new");
  it("baseline before the watermark's day, current may be the same day; debt flagged", async () => {
    let balSql;
    dbModule.pool.query = async (sql) => {
      if (/WITH baselines AS/.test(sql)) {
        balSql = sql;
        return { rows: [
          { source: "linked", source_id: 1, account_name: "Visa", account_type: "credit", baseline_balance: "500", current_balance: "2500", delta: "2000" },
          { source: "linked", source_id: 2, account_name: "Car loan", account_type: "loan", baseline_balance: "9000", current_balance: "8600", delta: "-400" },
          { source: "linked", source_id: 3, account_name: "Checking", account_type: "depository", baseline_balance: "100", current_balance: "3100", delta: "3000" },
        ] };
      }
      return { rows: [] };
    };
    const out = await gatherWhatsNew(new Date());
    assert.match(balSql, /WHERE snapshot_date < \$1::date/);
    assert.match(balSql, /WHERE c\.current_date >= \$1::date/);
    const [visa, loan, chk] = out.balance_changes;
    assert.deepEqual([visa.is_debt, visa.favorable], [true, false], "card balance owed up = bad");
    assert.deepEqual([loan.is_debt, loan.favorable], [true, true], "loan paid down = good");
    assert.deepEqual([chk.is_debt, chk.favorable], [false, true]);
  });

  it("digest colours debt increases red and prints signs before the $", () => {
    const { renderDailyDigestEmail, renderDailyDigestText } = require("../teller/routes/insights-email");
    const data = {
      counts: { transactions: 1, balance_changes: 1, subscriptions: 0, notifications: 0 },
      transactions: [{ merchant: "ACME PAYROLL", amount: "-3000", date: "2026-10-01" }],
      balance_changes: [{ account_name: "Visa", source_id: 1, delta: 2000, baseline_balance: 500, current_balance: 2500, is_debt: true, favorable: false }],
      subscriptions: [], notifications: [],
    };
    const html = renderDailyDigestEmail(data);
    assert.match(html, /color:#eb6b6b;">\+\$2000\.00<\/span>/);
    assert.match(html, /-\$3000\.00/);
    assert.doesNotMatch(html, /\$-3000/);
    const text = renderDailyDigestText(data);
    assert.match(text, /Visa: \+\$2000\.00 owed/);
    assert.match(text, /ACME PAYROLL — -\$3000\.00/);
  });

  it("the dashboard widget uses favorable for colour and shows a minus sign", () => {
    const src = read("teller", "views", "dashboard.ejs");
    assert.match(src, /var sgn = bc\.delta >= 0 \? '\+' : '-';/);
    assert.match(src, /var good = \(typeof bc\.favorable === 'boolean'\) \? bc\.favorable : bc\.delta >= 0;/);
  });
});
