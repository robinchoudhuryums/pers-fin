// ============================================================================
// Ops & alerts batch (broad-implement round 3)
// ============================================================================
//   - CI migration test plumbing (script + workflow job + SSL escape hatch)
//   - Out-of-process scheduling workflows (daily balances/snapshot, weekly
//     reconcile)
//   - Critical-alert emails (opt-in, budget-exceeded + anomaly)
//   - Bill-calendar .ics feed (builder + token-gated shell route)
//   - Small fry: badge cap, integer-cent splits, data-health jobs surface,
//     goal-milestone N+1

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ---------------------------------------------------------------------------
// CI migration test + out-of-process scheduling
// ---------------------------------------------------------------------------
describe("CI migration test plumbing", () => {
  it("ci.yml gains a migrations job against a real Postgres (pgvector image)", () => {
    const ci = read(".github", "workflows", "ci.yml");
    assert.match(ci, /migrations:/);
    assert.match(ci, /pgvector\/pgvector:pg16/);
    assert.match(ci, /scripts\/ci-migration-test\.js/);
  });

  it("the script runs both apps' migrations twice (idempotency)", () => {
    const s = read("scripts", "ci-migration-test.js");
    assert.equal((s.match(/perfin\.runMigrations\(\)/g) || []).length, 2);
    assert.equal((s.match(/persistent\.runMigrations\(\)/g) || []).length, 2);
    assert.match(s, /PGSSLMODE = "disable"/);
  });

  it("both pools honor PGSSLMODE=disable ONLY as the CI escape hatch", () => {
    assert.match(read("teller", "services", "database.js"),
      /ssl: process\.env\.PGSSLMODE === "disable" \? false : \{ rejectUnauthorized: true \}/);
    assert.match(read("apps", "per-sistant", "db.js"),
      /process\.env\.PGSSLMODE !== "disable"\) \? \{ rejectUnauthorized: true \} : false/);
  });

  it("daily-sync also refreshes balances + net worth; weekly reconcile exists", () => {
    const daily = read(".github", "workflows", "daily-sync.yml");
    assert.match(daily, /\/perfin\/api\/sync-balances/);
    assert.match(daily, /\/perfin\/api\/net-worth\/snapshot/);
    const weekly = read(".github", "workflows", "weekly-reconcile.yml");
    assert.match(weekly, /\/perfin\/api\/sync\/reconcile/);
    assert.match(weekly, /"provider": "teller"/);
  });
});

// ---------------------------------------------------------------------------
// Critical-alert emails
// ---------------------------------------------------------------------------
describe("critical-alert emails", () => {
  let dbModule, originalPoolQuery, persistent;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    persistent = require("../teller/routes/persistent");
  });

  afterEach(() => { dbModule.pool.query = originalPoolQuery; });

  it("is disabled by default and short-circuits without touching the webhook path", async () => {
    let calls = 0;
    dbModule.pool.query = async (sql) => {
      calls++;
      if (/critical_alert_emails_enabled/.test(sql)) return { rows: [{ critical_alert_emails_enabled: false }] };
      return { rows: [] };
    };
    const r = await persistent.sendCriticalAlertEmail("Budget exceeded: Dining", "details");
    assert.deepEqual(r, { sent: false, reason: "disabled" });
    assert.equal(calls, 1, "only the settings read — no config/webhook queries");
  });

  it("never throws — a DB error reports { sent: false }", async () => {
    dbModule.pool.query = async () => { throw new Error("boom"); };
    const r = await persistent.sendCriticalAlertEmail("t", "b");
    assert.equal(r.sent, false);
  });

  it("the email channel accepts the critical_alert event and escapes HTML", () => {
    const src = read("teller", "routes", "persistent.js");
    assert.match(src, /EMAIL_EVENTS = new Set\(\["insights_generated", "weekly_summary", "daily_summary", "critical_alert"\]\)/);
    assert.match(src, /escAlertHtml\(title\)/);
    assert.match(src, /escAlertHtml\(body\)/);
  });

  it("budget-exceeded emails share the 24h push dedup; anomaly emails are one-per-run and never hold the watermark", () => {
    const startup = read("teller", "startup.js");
    const exceedBlock = startup.slice(startup.indexOf('tag = "budget-over-'), startup.indexOf('} else if (pct >= 80)'));
    assert.match(exceedBlock, /sendCriticalAlertEmail/);
    const enroll = read("teller", "routes", "enrollments.js");
    assert.match(enroll, /sendCriticalAlertEmail\(\s*anomalies\.rows\.length > 1/);
    // The email try/catch must not set notifyFailed (that would hold the
    // anomaly watermark and re-push every later sync).
    const emailBlock = enroll.slice(enroll.indexOf("Opt-in critical-alert email"), enroll.indexOf("Anomaly alert email error"));
    assert.ok(!emailBlock.includes("notifyFailed = true"), "email failure must not hold the push watermark");
  });

  it("PATCH /api/settings persists the toggle", async () => {
    const supertest = require("supertest");
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/settings"));
    let captured;
    dbModule.pool.query = async (sql, params) => {
      if (/UPDATE user_settings SET/i.test(sql)) { captured = { sql, params }; return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    };
    await supertest(app).patch("/api/settings").send({ critical_alert_emails_enabled: true }).expect(200);
    assert.match(captured.sql, /critical_alert_emails_enabled = \$/);
    assert.ok(captured.params.includes(true));
  });
});

// ---------------------------------------------------------------------------
// Bill-calendar .ics feed
// ---------------------------------------------------------------------------
describe("bill-calendar .ics feed", () => {
  let dbModule, originalPoolQuery;
  const subs = require("../teller/routes/subscriptions");

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
  });
  afterEach(() => { dbModule.pool.query = originalPoolQuery; });

  it("projects subscription charges and manual bills as all-day VEVENTs", async () => {
    const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    dbModule.pool.query = async (sql) => {
      if (/FROM detected_subscriptions/i.test(sql)) return { rows: [
        { id: 1, display_name: "Netflix, Inc; LLC", amount: "15.49", cadence_days: 30, next_expected: past },
      ]};
      if (/FROM manual_bills/i.test(sql)) return { rows: [
        { id: 7, name: "Rent", amount: "1800", due_day: 1, cadence: "monthly" },
      ]};
      return { rows: [] };
    };
    const ics = await subs.buildBillCalendarIcs(90);
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /X-WR-CALNAME:Perfin Bills/);
    // Past next_expected advanced into the window, then projected by cadence
    const events = ics.match(/BEGIN:VEVENT/g) || [];
    assert.ok(events.length >= 4, "30d cadence over 90d + monthly rent = several events, got " + events.length);
    assert.match(ics, /SUMMARY:Netflix\\, Inc\\; LLC — \$15\.49/, "RFC5545 comma/semicolon escaping");
    assert.match(ics, /UID:sub-1-\d{8}@perfin/, "stable UIDs so refetches update in place");
    assert.match(ics, /DTSTART;VALUE=DATE:\d{8}/, "all-day events");
    assert.match(ics, /SUMMARY:Rent — \$1800\.00 \(bill\)/);
  });

  it("the shell route is token-gated, constant-time, and off when unconfigured", () => {
    const shell = read("shell", "index.js");
    assert.match(shell, /CALENDAR_FEED_TOKEN/);
    assert.match(shell, /timingSafeEqual/);
    assert.match(shell, /if \(!expected\) return res\.status\(404\)\.end\(\);/, "unset env = feature off");
    // The documented API_KEY header-only rule stays intact — this is a
    // separate single-purpose token, the one sanctioned query credential.
    assert.match(shell, /deliberately separate from API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// Small fry
// ---------------------------------------------------------------------------
describe("small fry", () => {
  it("unread badge caps at 99+", () => {
    assert.match(read("teller", "views", "partials", "nav.ejs"), /unread_count > 99 \? '99\+'/);
  });

  it("split validation accumulates in integer cents", () => {
    const src = read("teller", "routes", "subscriptions.js");
    assert.match(src, /sumCents \+= Math\.round\(n \* 100\);/);
    assert.match(src, /Math\.abs\(sumCents - Math\.round\(parentAmount \* 100\)\) > 1/);
  });

  it("goal-milestone job reads notes from the main SELECT (no N+1)", () => {
    const src = read("teller", "startup.js");
    assert.match(src, /SELECT g\.id, g\.name, g\.target_amount, g\.notes,/);
    assert.ok(!src.includes('"SELECT notes FROM financial_goals WHERE id = $1"'), "per-goal re-query removed");
  });

  it("data-health surfaces job heartbeats with per-job staleness", () => {
    const src = read("teller", "routes", "settings.js");
    assert.match(src, /FROM job_runs WHERE job_name != '_watchdog'/);
    assert.match(src, /jobHealth\.thresholdMs\(j\.job_name\)/);
  });

  it("thresholdMs floors at 36h and scales with the interval", () => {
    const jobHealth = require("../teller/services/job-health");
    const H = 60 * 60 * 1000;
    assert.equal(jobHealth.thresholdMs("bank-auto-sync"), 36 * H, "hourly job → 36h floor");
    assert.equal(jobHealth.thresholdMs("csv-reminder"), 96 * H, "24h job → 4× interval");
  });
});
