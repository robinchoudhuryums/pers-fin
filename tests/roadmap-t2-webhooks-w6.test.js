// ============================================================================
// Roadmap T2.1 — W6: webhook visibility
// ============================================================================
//  - services/webhook-status.js: getWebhookStatus reads webhook_events per
//    provider (last event + status, 24h count and failures), the Plaid
//    registration (an Item counts when its webhook_url sits under PUBLIC_URL and
//    ends /api/webhooks/plaid) and the Teller enrollment count — fail-soft;
//    webhookChecks' every branch (Plaid off / not registered = warn / quiet /
//    ok; Teller off / quiet / ok; both omitted with nothing connected)
//  - getOperatorChecks includes the webhook checks (a passed-in status means no
//    second read) and a not-registered warn reaches data-health's issues
//  - GET /api/data-health: webhooks + per-connection freshness, a failed
//    webhook event raised as an issue, both blocks fail-soft
//  - the Sync Health UI's Webhooks line, Register button and Connections list,
//    run in a vm from settings.ejs
// The database-backed half is tests/contract/webhooks-w6.contract.test.js.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const dbModule = require("../teller/services/database");
const plaidClientModule = require("../teller/services/plaid-client");
const ws = require("../teller/services/webhook-status");
const oc = require("../teller/services/operator-checks");

const originalQuery = dbModule.pool.query;
const originalGetPlaidClient = plaidClientModule.getPlaidClient;
afterEach(() => {
  dbModule.pool.query = originalQuery;
  plaidClientModule.getPlaidClient = originalGetPlaidClient;
  oc._resetCache();
});

const BASE = "https://fin.example.com";
const quietConsole = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

function fakePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
      return { rows: [] };
    },
  };
}

// ---------------------------------------------------------------------------
describe("W6 — getWebhookStatus", () => {
  it("reads events per provider, the Plaid registration under PUBLIC_URL and the Teller count", async () => {
    plaidClientModule.getPlaidClient = () => ({});
    const at = new Date("2026-10-22T10:00:00Z");
    const pool = fakePool([
      [/FROM webhook_events/, () => ({ rows: [
        { provider: "plaid", last_event_at: at, last_status: "done", events_24h: 4, failed_24h: 1 },
        { provider: "teller", last_event_at: null, last_status: null, events_24h: 0, failed_24h: 0 },
        { provider: "other", last_event_at: at, last_status: "done", events_24h: 9, failed_24h: 9 },
      ] })],
      [/FROM plaid_items WHERE status = 'GOOD'/, () => ({ rows: [{ total: 3, registered: 2 }] })],
      [/FROM teller_enrollments/, () => ({ rows: [{ n: 2 }] })],
    ]);
    const s = await ws.getWebhookStatus(pool, { env: { PUBLIC_URL: BASE + "/", TELLER_WEBHOOK_SECRET: "a, b" } });
    assert.deepEqual(s.plaid, { configured: true, opted_in: true, base_url: BASE, items_total: 3, items_registered: 2,
      last_event_at: at, last_status: "done", events_24h: 4, failed_24h: 1 });
    assert.deepEqual(s.teller, { configured: true, enrollments_total: 2, last_event_at: null, last_status: null, events_24h: 0, failed_24h: 0 });
    assert.equal(s.error, undefined);
    const reg = pool.calls.find((c) => /FROM plaid_items WHERE status = 'GOOD'/.test(c.sql));
    assert.deepEqual(reg.params, [BASE]);
    assert.match(reg.sql, /left\(webhook_url, length\(\$1::text\)\) = \$1::text/);
    assert.match(reg.sql, /right\(webhook_url, 19\) = '\/api\/webhooks\/plaid'/);
    assert.match(reg.sql, /NOT EXISTS \(SELECT 1 FROM plaid_items pi WHERE pi\.item_id = pii\.item_id\)/, "a combined Item counts once");
    assert.match(pool.calls.find((c) => /FROM teller_enrollments/.test(c.sql)).sql, /status <> 'SUSPENDED'/);
    assert.doesNotMatch(pool.calls.map((c) => c.sql).join("\n"), /\bbody\b/i, "never reads a body");
  });

  it("without PUBLIC_URL (even with RENDER_EXTERNAL_URL) nothing counts as registered; no secret = Teller off", async () => {
    plaidClientModule.getPlaidClient = () => null;
    const pool = fakePool([[/FROM plaid_items/, () => ({ rows: [{ total: 1, registered: 0 }] })]]);
    const s = await ws.getWebhookStatus(pool, { env: { RENDER_EXTERNAL_URL: "https://x.onrender.com" } });
    assert.equal(s.plaid.configured, false);
    assert.equal(s.plaid.opted_in, false);
    assert.equal(s.plaid.base_url, null);
    assert.deepEqual(pool.calls.find((c) => /FROM plaid_items/.test(c.sql)).params, [""]);
    assert.equal(s.teller.configured, false);
  });

  it("a failed query leaves its part empty and flags error — it never throws", async () => {
    plaidClientModule.getPlaidClient = () => ({});
    const boom = () => { throw new Error("db down"); };
    const pool = fakePool([[/FROM webhook_events/, boom], [/FROM plaid_items/, boom], [/FROM teller_enrollments/, boom]]);
    const s = await quietConsole(() => ws.getWebhookStatus(pool, { env: { PUBLIC_URL: BASE } }));
    assert.equal(s.error, true);
    assert.equal(s.plaid.items_total, 0);
    assert.equal(s.plaid.last_event_at, null);
    assert.equal(s.teller.enrollments_total, 0);
  });
});

// ---------------------------------------------------------------------------
describe("W6 — webhookChecks", () => {
  const NOW = Date.parse("2026-10-22T12:00:00Z");
  const recent = new Date(NOW - 3600 * 1000).toISOString();
  const old = new Date(NOW - 8 * 86400 * 1000).toISOString();
  const plaid = (o) => ({ configured: true, opted_in: true, base_url: BASE, items_total: 2, items_registered: 2, last_event_at: recent, ...o });
  const teller = (o) => ({ configured: true, enrollments_total: 1, last_event_at: recent, ...o });
  const check = (status, id) => ws.webhookChecks(status, { now: NOW }).find((c) => c.id === id);

  it("Plaid: omitted without Plaid or connections; off = info; unregistered = warn; quiet = info; else ok", () => {
    assert.equal(check({ plaid: plaid({ configured: false }) }, "webhooks:plaid"), undefined);
    assert.equal(check({ plaid: plaid({ items_total: 0 }) }, "webhooks:plaid"), undefined);
    let c = check({ plaid: plaid({ opted_in: false }) }, "webhooks:plaid");
    assert.equal(c.status, "info"); assert.match(c.fix, /PUBLIC_URL/);
    c = check({ plaid: plaid({ items_registered: 1 }) }, "webhooks:plaid");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /1 of 2 Plaid connection\(s\) aren't registered at https:\/\/fin\.example\.com/);
    assert.match(c.fix, /Register Plaid webhooks/);
    assert.equal(check({ plaid: plaid({ last_event_at: old }) }, "webhooks:plaid").status, "info");
    assert.equal(check({ plaid: plaid({ last_event_at: null }) }, "webhooks:plaid").status, "info");
    assert.equal(check({ plaid: plaid() }, "webhooks:plaid").status, "ok");
  });

  it("Teller: omitted without enrollments; no secret = info; quiet = info; else ok", () => {
    assert.equal(check({ teller: teller({ enrollments_total: 0 }) }, "webhooks:teller"), undefined);
    let c = check({ teller: teller({ configured: false }) }, "webhooks:teller");
    assert.equal(c.status, "info"); assert.match(c.fix, /TELLER_WEBHOOK_SECRET/);
    c = check({ teller: teller({ last_event_at: old }) }, "webhooks:teller");
    assert.equal(c.status, "info"); assert.match(c.detail, /No Teller webhook has arrived in 7 days/);
    assert.equal(check({ teller: teller() }, "webhooks:teller").status, "ok");
    assert.deepEqual(ws.webhookChecks(null), []);
  });
});

// ---------------------------------------------------------------------------
describe("W6 — operator checks and data-health", () => {
  const STATUS = {
    plaid: { configured: true, opted_in: true, base_url: BASE, items_total: 2, items_registered: 0, last_event_at: null, last_status: null, events_24h: 0, failed_24h: 0 },
    teller: { configured: false, enrollments_total: 1, last_event_at: null, last_status: null, events_24h: 0, failed_24h: 0 },
  };

  it("getOperatorChecks adds the webhook checks; a passed-in status is not read again; the warn reaches toIssues", async () => {
    let queried = 0;
    // Other checks read the pool too (the go-live and backup checks, cycle-8 E4a);
    // the webhook status must not be read again.
    const r = await oc.getOperatorChecks({ cachedOnly: true, env: {}, webhookStatus: STATUS, pool: { query: async (sql) => { if (/webhook/i.test(sql)) queried++; return { rows: [] }; } } });
    const plaidCheck = r.checks.find((c) => c.id === "webhooks:plaid");
    assert.equal(plaidCheck.status, "warn");
    assert.equal(r.checks.find((c) => c.id === "webhooks:teller").status, "info");
    assert.equal(queried, 0, "the status the caller read is reused");
    assert.ok(oc.toIssues(r).some((i) => i.source === "operator" && i.check === "webhooks:plaid"));
    assert.equal(oc._failingSignature(r.checks).includes("webhooks:plaid"), true, "a change notifies once (watchdog)");
  });

  it("getOperatorChecks without a pool or status adds no webhook checks", async () => {
    const r = await oc.getOperatorChecks({ cachedOnly: true, env: {} });
    assert.equal(r.checks.some((c) => /^webhooks:/.test(c.id)), false);
  });

  it("GET /api/data-health returns webhooks + per-connection freshness and raises failed webhook events", async () => {
    plaidClientModule.getPlaidClient = () => ({});
    const synced = new Date(Date.now() - 2 * 3600 * 1000);
    dbModule.pool.query = async (sql) => {
      if (/FROM user_settings/.test(sql)) return { rows: [{ last_txn_sync_at: new Date(), last_balance_sync_at: new Date() }] };
      if (/FROM webhook_events/.test(sql)) return { rows: [{ provider: "plaid", last_event_at: new Date(), last_status: "failed", events_24h: 3, failed_24h: 2 }] };
      if (/'teller' AS provider/.test(sql)) return { rows: [
        { provider: "plaid", id: 4, institution_name: "Card Co", status: "NEEDS_REAUTH", last_synced_at: null },
        { provider: "teller", id: 1, institution_name: "Chase", status: "GOOD", last_synced_at: synced },
      ] };
      return { rows: [{ total: 0, disconnected: 0, not_good: 0, n: 0, registered: 0 }] };
    };
    const app = express(); app.use(require("../teller/routes/settings"));
    const res = await supertest(app).get("/api/data-health").expect(200);
    assert.equal(res.body.webhooks.plaid.failed_24h, 2);
    assert.ok(res.body.issues.some((i) => /2 Plaid webhook event\(s\) failed in the last 24 hours/.test(i.message)));
    assert.equal(res.body.connections.length, 2);
    assert.deepEqual(res.body.connections[0], { provider: "plaid", id: 4, institution: "Card Co", status: "NEEDS_REAUTH",
      last_synced: { timestamp: null, age_seconds: null, level: "stale" } });
    assert.equal(res.body.connections[1].last_synced.level, "fresh");
  });

  it("data-health's connections query excludes CSV items and suspended enrollments and maps a re-auth code", () => {
    // Since cycle-8 E4b the query lives in services/freshness.js (CONNECTIONS_SQL),
    // shared with /api/data-freshness and the nav badge; data-health reads it there.
    assert.match(read("teller/routes/settings.js"), /freshnessSvc\.readConnections\(db, now\)/);
    const q = require("../teller/services/freshness").CONNECTIONS_SQL;
    assert.match(q, /FROM teller_enrollments WHERE status <> 'SUSPENDED'/);
    assert.match(q, /CASE WHEN last_error_code IS NOT NULL THEN 'NEEDS_REAUTH' ELSE status END/);
    assert.match(q, /FROM plaid_items WHERE status <> 'CSV'/);
  });

  it("both new data-health blocks are fail-soft", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM user_settings/.test(sql)) return { rows: [{}] };
      if (/'teller' AS provider|FROM webhook_events/.test(sql)) throw new Error("boom");
      return { rows: [{ total: 0, disconnected: 0, not_good: 0 }] };
    };
    const app = express(); app.use(require("../teller/routes/settings"));
    const res = await quietConsole(() => supertest(app).get("/api/data-health").expect(200));
    assert.deepEqual(res.body.connections, []);
    assert.equal(res.body.webhooks.error, true);
  });
});

// ---------------------------------------------------------------------------
describe("W6 — the Sync Health UI", () => {
  const src = read("teller/views/settings.ejs");
  function loadUi() {
    const start = src.indexOf("function dhAge(");
    const dhEnd = src.indexOf("async function loadDataHealth(");
    const whStart = src.indexOf("function whLine(");
    const whEnd = src.indexOf("(function () {\n      var el = document.getElementById('data-health-body');");
    assert.ok(start > 0 && dhEnd > start && whStart > 0 && whEnd > whStart);
    const esc = (s) => (s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
    const ctx = { esc, Date, Math };
    vm.runInNewContext(src.slice(start, dhEnd) + src.slice(whStart, whEnd), ctx);
    return ctx;
  }

  it("Webhooks line: off states, last event, 24h counts + failures, and the Register button only when it can act", () => {
    const ui = loadUi();
    let html = ui.renderWebhooks({ plaid: { configured: false }, teller: { configured: false } });
    assert.match(html, /Plaid: <span[^>]*>Plaid not configured/);
    assert.match(html, /Teller: <span[^>]*>off — set TELLER_WEBHOOK_SECRET/);
    html = ui.renderWebhooks({ plaid: { configured: true, opted_in: false, items_total: 2 }, teller: { configured: true, last_event_at: null, events_24h: 0 } });
    assert.match(html, /off — set PUBLIC_URL/);
    assert.doesNotMatch(html, /register-plaid-webhooks-btn/);
    assert.match(html, /Teller: last event none yet · 0 in 24h/);
    html = ui.renderWebhooks({
      plaid: { configured: true, opted_in: true, base_url: "https://a<b>", items_total: 3, items_registered: 1, last_event_at: new Date(Date.now() - 7200 * 1000).toISOString(), last_status: "done", events_24h: 5, failed_24h: 2 },
      teller: { configured: false },
    });
    assert.match(html, /Plaid: last event 2h ago \(done\) · 5 in 24h · <span[^>]*>2 failed/);
    assert.match(html, /1 of 3 Plaid connection\(s\) registered at https:\/\/a&lt;b&gt;/);
    assert.match(html, /<button class="btn" id="register-plaid-webhooks-btn" data-e2e-skip/, "an outward action — never pressed by the e2e sweep");
    assert.equal(ui.renderWebhooks(null), "");
  });

  it("Connections list: a freshness dot, the age or 'no complete sync', the re-auth state, escaped names", () => {
    const ui = loadUi();
    const html = ui.renderConnections([
      { provider: "teller", institution: "Chase <script>", status: "GOOD", last_synced: { timestamp: "t", age_seconds: 600, level: "fresh" } },
      { provider: "plaid", institution: "Card Co", status: "NEEDS_REAUTH", last_synced: { timestamp: null, age_seconds: null, level: "stale" } },
      { provider: "teller", institution: "Old Bank", status: "DISCONNECTED", last_synced: { timestamp: "t", age_seconds: 3 * 86400, level: "stale" } },
    ]);
    assert.match(html, /<summary>Connections \(3\)<\/summary>/);
    assert.match(html, /Teller — Chase &lt;script&gt;: synced 10m ago<\/li>/);
    assert.match(html, /Plaid — Card Co: no complete sync recorded yet · <span[^>]*>needs re-auth/);
    assert.match(html, /Old Bank: synced 3d ago · <span[^>]*>disconnected/);
    assert.equal(ui.renderConnections([]), "");
  });

  it("the Register button posts the register route and reports through writeOk, then reloads", () => {
    const block = src.slice(src.indexOf("ev.target.closest('#register-plaid-webhooks-btn')"), src.indexOf("// Operator checks (cycle-7 G1 + ST4) — GET /api/operator-checks."));
    assert.match(block, /apiFetch\('\/api\/plaid\/webhooks\/register', \{ method: 'POST' \}\)/);
    assert.match(block, /await writeOk\(res, 'Register Plaid webhooks'\)/);
    assert.match(block, /loadDataHealth\(\);/);
    assert.match(block, /finally \{ btn\.disabled = false; \}/);
    assert.match(src, /out \+= renderWebhooks\(h\.webhooks\);\s*out \+= renderConnections\(h\.connections\);/);
  });
});
