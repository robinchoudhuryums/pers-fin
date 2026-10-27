// ============================================================================
// Cycle-8 broad scan, Batch 4 — sync watermarks + webhook hardening
// ============================================================================
//   F1   the anomaly watermark is the newest created_at visible before the
//        candidate read (kept below any open writer's start), never now()
//   F51  "Paycheck landed" re-reads 24 h behind its watermark and skips a
//        deposit there that was already announced
//   F3   the Plaid verifier caches a missing kid, caps uncached key lookups,
//        shares one lookup per kid and checks iat / body hash first
// The concurrency half (an open transaction committing after a check) runs on
// real Postgres in tests/contract/c8-batch4.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

// ---------------------------------------------------------------------------
describe("F1 — the anomaly watermark", () => {
  const enr = require("../teller/routes/enrollments");
  const notifications = require("../teller/routes/notifications");
  const persistent = require("../teller/routes/persistent");
  const realSend = notifications.sendToAll, realEmail = persistent.sendCriticalAlertEmail;
  afterEach(() => { notifications.sendToAll = realSend; persistent.sendCriticalAlertEmail = realEmail; });

  function fake({ watermark = "2026-10-27 08:00:00.123456+00", hw = "2026-10-27 09:00:00.654321+00", candidates = [] } = {}) {
    const log = [];
    dbModule.pool.query = async (sql, params) => {
      log.push({ sql, params });
      if (sql.includes("last_anomaly_check_at FROM user_settings")) return { rows: [{ last_anomaly_check_at: watermark }] };
      if (sql.includes(")::text AS hw")) return { rows: [{ hw }] };
      if (sql.includes("avg_tbl")) return { rows: candidates };
      return { rows: [] };
    };
    return log;
  }
  const find = (log, re) => log.filter((x) => re.test(x.sql));

  it("reads the watermark as text and bounds the candidates by the mark taken before them", async () => {
    const log = fake();
    await enr.runAnomalyCheck();
    assert.match(find(log, /FROM user_settings/)[0].sql, /last_anomaly_check_at::text AS last_anomaly_check_at/);
    const hwAt = log.findIndex((x) => /::text AS hw/.test(x.sql));
    const candAt = log.findIndex((x) => /avg_tbl/.test(x.sql));
    assert.ok(hwAt > 0 && candAt > hwAt, "the mark is read before the candidates");
    assert.match(log[hwAt].sql, /MAX\(created_at\) FROM transactions/);
    assert.match(log[hwAt].sql, /MIN\(xact_start\) - interval '1 microsecond' FROM pg_stat_activity/);
    assert.match(log[hwAt].sql, /pid <> pg_backend_pid\(\) AND backend_xid IS NOT NULL/);
    assert.deepEqual(log[hwAt].params, ["2026-10-27 08:00:00.123456+00"]);
    assert.match(log[candAt].sql, /AND t\.created_at <= \$2::timestamptz/);
    assert.deepEqual(log[candAt].params, ["2026-10-27 08:00:00.123456+00", "2026-10-27 09:00:00.654321+00"]);
  });

  it("advances to the mark — exact text, never backwards — not to now()", async () => {
    const log = fake();
    await enr.runAnomalyCheck();
    const up = find(log, /UPDATE user_settings SET last_anomaly_check_at/);
    assert.equal(up.length, 1);
    assert.doesNotMatch(up[0].sql, /now\(\)/);
    assert.match(up[0].sql, /last_anomaly_check_at IS NULL OR last_anomaly_check_at < \$1::timestamptz/);
    assert.deepEqual(up[0].params, ["2026-10-27 09:00:00.654321+00"]);
  });

  it("nothing new since the last check: no candidate read, no update", async () => {
    const log = fake({ hw: null });
    await enr.runAnomalyCheck();
    assert.equal(find(log, /avg_tbl/).length, 0);
    assert.equal(find(log, /UPDATE user_settings/).length, 0);
  });

  it("a failed push still holds the watermark", async () => {
    const log = fake({ candidates: [{ merchant_name: "COFFEECO", name: "COFFEECO", amount: "100", date: "2026-10-27", avg_amount: "10" }] });
    notifications.sendToAll = async () => { throw new Error("push down"); };
    persistent.sendCriticalAlertEmail = async () => {};
    const quiet = console.error; console.error = () => {};
    try { await enr.runAnomalyCheck(); } finally { console.error = quiet; }
    assert.equal(find(log, /UPDATE user_settings SET last_anomaly_check_at/).length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("F51 — Paycheck landed re-reads an overlap", () => {
  const pa = require("../teller/services/payday-alerts");
  beforeEach(() => pa._reset());
  const PAY = ["2026-01-04", "2026-01-18", "2026-02-01", "2026-02-15", "2026-03-01", "2026-03-15"]
    .map((date) => ({ source: "ACME PAYROLL", date, amount: "2100" }));
  const tagOf = (id) => "payday-" + crypto.createHash("sha256").update(id).digest("hex").slice(0, 12);
  function pool(candidates, announced = []) {
    const calls = { updates: [], candidateSql: null, dedupe: [] };
    return {
      calls,
      query: async (sql, params) => {
        if (/SELECT payday_alerts_enabled, last_income_alert_at/.test(sql)) return { rows: [{ payday_alerts_enabled: true, last_income_alert_at: "2026-03-16 10:00:00+00" }] };
        if (/UPDATE user_settings SET last_income_alert_at/.test(sql)) { calls.updates.push({ sql, value: params[0] }); return { rows: [] }; }
        if (/FROM notification_log/.test(sql)) { calls.dedupe.push({ sql, params }); return { rows: announced.filter((t) => params[0].includes(t)).map((type) => ({ type })) }; }
        if (/created_at > \$1::timestamptz/.test(sql)) { calls.candidateSql = sql; return { rows: candidates }; }
        if (/INTERVAL '4 months'/.test(sql)) return { rows: PAY };
        throw new Error("unexpected query: " + sql.slice(0, 60));
      },
    };
  }
  const cand = (id, source, amount, date, created, in_overlap) => ({ transaction_id: id, source, amount: String(amount), date, created_at: created, in_overlap });

  it("reads 24 h behind the watermark and marks the overlap rows", async () => {
    const p = pool([]);
    await pa.runPaydayLanded(p, { today: "2026-03-19" });
    assert.equal(pa.LANDED_OVERLAP_HOURS, 24);
    assert.match(p.calls.candidateSql, /created_at > \$1::timestamptz - make_interval\(hours => 24\)/);
    assert.match(p.calls.candidateSql, /created_at <= \$1::timestamptz AS in_overlap/);
  });

  it("a deposit in the overlap that wasn't announced is announced (a CSV import committed after the check)", async () => {
    const sent = [];
    const p = pool([cand("late", "ACME PAYROLL", 2100, "2026-03-15", "2026-03-16 09:30:00+00", true)]);
    const r = await pa.runPaydayLanded(p, { today: "2026-03-19", deps: { sendToAll: async (x) => { sent.push(x); return { logged: true }; } } });
    assert.equal(r.notified, 1);
    assert.equal(sent[0].tag, tagOf("late"));
    assert.deepEqual(p.calls.dedupe[0].params, [[tagOf("late")]]);
    assert.match(p.calls.dedupe[0].sql, /make_interval\(days => 30\)/);
  });

  it("one already announced is skipped; a new one after it is announced; the watermark never moves back", async () => {
    const sent = [];
    const p = pool([
      cand("old", "ACME PAYROLL", 2100, "2026-03-15", "2026-03-15 10:00:00+00", true),
      cand("new", "ACME PAYROLL", 2100, "2026-03-16", "2026-03-16 11:00:00+00", false),
    ], [tagOf("old")]);
    const r = await pa.runPaydayLanded(p, { today: "2026-03-19", deps: { sendToAll: async (x) => { sent.push(x); return { logged: true }; } } });
    assert.deepEqual(sent.map((x) => x.tag), [tagOf("new")]);
    assert.equal(r.notified, 1);
    assert.deepEqual(p.calls.dedupe[0].params, [[tagOf("old")]], "only overlap rows that match a stream are looked up");
    assert.match(p.calls.updates[0].sql, /GREATEST\(last_income_alert_at, \$1::timestamptz\)/);
    assert.equal(p.calls.updates[0].value, "2026-03-16 11:00:00+00");
  });

  it("no overlap row matches a stream: no dedupe read", async () => {
    const p = pool([cand("x", "IRS REFUND", 50, "2026-03-15", "2026-03-15 10:00:00+00", true)]);
    await pa.runPaydayLanded(p, { today: "2026-03-19", deps: { sendToAll: async () => ({ logged: true }) } });
    assert.equal(p.calls.dedupe.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("F3 — Plaid key lookups", () => {
  const verify = require("../teller/services/webhook-verify");
  const KID = "kid-1";
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });
  function jwt({ kid = KID, iat = Math.floor(Date.now() / 1000), body = BODY, hash } = {}) {
    const h = b64u({ alg: "ES256", kid, typ: "JWT" });
    const p = b64u({ iat, request_body_sha256: hash || crypto.createHash("sha256").update(body).digest("hex") });
    const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `${h}.${p}.${sig}`;
  }
  const req = (token, raw = BODY) => ({ headers: { "plaid-verification": token }, rawBody: Buffer.from(raw), body: JSON.parse(raw) });
  function client({ fail } = {}) {
    const c = {
      fetches: 0, kids: [],
      async webhookVerificationKeyGet({ key_id }) {
        c.fetches++; c.kids.push(key_id);
        await new Promise((r) => setImmediate(r));
        if (fail) throw Object.assign(new Error("plaid"), { response: { status: fail } });
        if (key_id !== KID) return { data: { key: null } };
        return { data: { key: { ...jwk, alg: "ES256", kid: KID, expired_at: null } } };
      },
    };
    return c;
  }

  it("a kid with no key is remembered as a miss for an hour", async () => {
    let t = Date.now();
    const c = client();
    const v = verify.createPlaidVerifier({ getClient: () => c, now: () => t });
    for (let i = 0; i < 3; i++) assert.equal((await v.verify(req(jwt({ kid: "nope", iat: Math.floor(t / 1000) })))).ok, false);
    assert.equal(c.fetches, 1);
    t += verify.KEY_MISS_CACHE_MS + 1;
    await v.verify(req(jwt({ kid: "nope", iat: Math.floor(t / 1000) })));
    assert.equal(c.fetches, 2, "looked up again once the miss expires");
  });

  it("at most KEY_FETCH_LIMIT uncached lookups an hour; a cached key still verifies", async () => {
    const c = client();
    const v = verify.createPlaidVerifier({ getClient: () => c });
    assert.equal((await v.verify(req(jwt()))).ok, true);
    for (let i = 0; i < verify.KEY_FETCH_LIMIT + 10; i++) await v.verify(req(jwt({ kid: "k" + i })));
    assert.equal(c.fetches, verify.KEY_FETCH_LIMIT);
    assert.equal((await v.verify(req(jwt()))).ok, true, "the real key is cached");
  });

  it("concurrent deliveries for one kid share one lookup", async () => {
    const c = client();
    const v = verify.createPlaidVerifier({ getClient: () => c });
    const r = await Promise.all([1, 2, 3].map(() => v.verify(req(jwt()))));
    assert.deepEqual(r.map((x) => x.ok), [true, true, true]);
    assert.equal(c.fetches, 1);
  });

  it("a malformed kid, a stale iat or a wrong body hash is refused before any lookup", async () => {
    const c = client();
    const v = verify.createPlaidVerifier({ getClient: () => c });
    for (const kid of ["a/b", "x".repeat(129), "kid 1"]) assert.equal((await v.verify(req(jwt({ kid })))).ok, false, kid);
    assert.equal((await v.verify(req(jwt({ iat: Math.floor(Date.now() / 1000) - 600 })))).ok, false);
    assert.equal((await v.verify(req(jwt({ hash: "0".repeat(64) })))).ok, false);
    assert.equal(c.fetches, 0);
  });

  it("a 4xx from Plaid is cached as a miss; a 5xx is not", async () => {
    const c4 = client({ fail: 400 });
    const v4 = verify.createPlaidVerifier({ getClient: () => c4 });
    await v4.verify(req(jwt())); await v4.verify(req(jwt()));
    assert.equal(c4.fetches, 1);
    const c5 = client({ fail: 503 });
    const v5 = verify.createPlaidVerifier({ getClient: () => c5 });
    await v5.verify(req(jwt())); await v5.verify(req(jwt()));
    assert.equal(c5.fetches, 2);
  });
});
