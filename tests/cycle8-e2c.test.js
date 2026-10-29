// ============================================================================
// Cycle 8 E2c (ST3) — id watermarks with an overlap rescan
// ============================================================================
// services/txn-watermark.js (the mark, the window, the never-backwards
// advance) and its two callers over fake pools:
//   - runAnomalyCheck: the mark read before the candidates, the window +
//     transaction_id dedupe in the candidate SQL, data.transaction_id on the
//     push, the advance to the mark, no pg_stat_activity read, an unlogged or
//     failed push holding the watermark, an empty table reading nothing more
//   - runPaydayLanded: the window, overlap deposits deduped by their tag, the
//     advance (to the mark, or just before a deposit whose alert wasn't logged)
//   - the migrations' backfill from the time watermarks
// The database-backed half (a lower id committing after a check; a long-open
// transaction no longer holding the anomaly alerts back; the backfill) is
// tests/contract/txn-watermark-e2c.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const dbModule = require("../teller/services/database");
const tw = require("../teller/services/txn-watermark");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

// ---------------------------------------------------------------------------
describe("services/txn-watermark.js", () => {
  it("readMark: MAX(id) (0 for an empty table) and now(), as text, in one read", async () => {
    const seen = [];
    const db = { query: async (sql) => { seen.push(sql); return { rows: [{ mark_id: "77", mark_at: "2026-10-29 10:00:00.123456+00" }] }; } };
    assert.deepEqual(await tw.readMark(db), { id: "77", at: "2026-10-29 10:00:00.123456+00" });
    assert.deepEqual(seen, [tw.MARK_SQL]);
    assert.match(tw.MARK_SQL, /COALESCE\(MAX\(id\), 0\)::text AS mark_id, now\(\)::text AS mark_at FROM transactions/);
    assert.deepEqual(await tw.readMark({ query: async () => ({ rows: [] }) }), { id: "0", at: null });
  });

  it("windowSql: above the id, or at / below it and created within the overlap of the previous check — never past the mark", () => {
    const w = tw.windowSql({ alias: "t", watermark: "$1", since: "$2", mark: "$3" });
    assert.equal(w.where, "(t.id <= $3::bigint AND (t.id > $1::bigint OR ($2::timestamptz IS NOT NULL AND t.created_at > $2::timestamptz - make_interval(hours => 24))))");
    assert.equal(w.inOverlap, "(t.id <= $1::bigint)");
    const bare = tw.windowSql({ alias: "", watermark: "$1", since: "$2", mark: "$3", overlapHours: 6 });
    assert.match(bare.where, /^\(id <= \$3::bigint AND \(id > \$1::bigint OR .* created_at > \$2::timestamptz - make_interval\(hours => 6\)\)\)\)$/);
    assert.equal(tw.OVERLAP_HOURS, 24);
    for (const bad of [-1, 1.5, "6; DROP TABLE x", NaN]) assert.throws(() => tw.windowSql({ watermark: "$1", since: "$2", mark: "$3", overlapHours: bad }));
  });

  it("advanceSql: both columns forward only", () => {
    assert.equal(tw.advanceSql("last_x_txn_id", "last_x_at"),
      "UPDATE user_settings SET last_x_txn_id = GREATEST(COALESCE(last_x_txn_id, 0), $1::bigint), last_x_at = GREATEST(last_x_at, $2::timestamptz) WHERE id = 1");
  });
});

// ---------------------------------------------------------------------------
describe("runAnomalyCheck on the id watermark", () => {
  const enr = require("../teller/routes/enrollments");
  const notifications = require("../teller/routes/notifications");
  const persistent = require("../teller/routes/persistent");
  const realSend = notifications.sendToAll, realEmail = persistent.sendCriticalAlertEmail;
  afterEach(() => { notifications.sendToAll = realSend; persistent.sendCriticalAlertEmail = realEmail; });

  function fake({ settings = { last_anomaly_txn_id: "400", last_anomaly_check_at: "2026-10-27 08:00:00.123456+00" }, mark = { mark_id: "500", mark_at: "2026-10-29 09:00:00.654321+00" }, candidates = [] } = {}) {
    const log = [];
    dbModule.pool.query = async (sql, params) => {
      log.push({ sql, params });
      if (sql.includes("FROM user_settings WHERE id = 1") && sql.startsWith("SELECT")) return { rows: [settings] };
      if (sql === tw.MARK_SQL) return { rows: [mark] };
      if (sql.includes("avg_tbl")) return { rows: candidates };
      return { rows: [] };
    };
    return log;
  }
  const find = (log, re) => log.filter((x) => re.test(x.sql));
  const BIG = { transaction_id: "txn-9", merchant_name: "COFFEECO", name: "COFFEECO", amount: "100", date: "2026-10-29", avg_amount: "10" };

  it("reads the id and time watermarks, then the mark, then the candidates bounded by the window", async () => {
    const log = fake();
    notifications.sendToAll = async () => ({ logged: true });
    await enr.runAnomalyCheck();
    assert.match(log[0].sql, /SELECT last_anomaly_txn_id::text AS last_anomaly_txn_id, last_anomaly_check_at::text AS last_anomaly_check_at FROM user_settings/);
    assert.equal(log[1].sql, tw.MARK_SQL, "the mark comes before the candidates");
    const cand = find(log, /avg_tbl/)[0];
    assert.ok(cand.sql.includes(tw.windowSql({ alias: "t", watermark: "$1", since: "$2", mark: "$3" }).where));
    assert.deepEqual(cand.params, ["400", "2026-10-27 08:00:00.123456+00", "500"]);
    assert.match(cand.sql, /NOT EXISTS \(\s*SELECT 1 FROM notification_log n\s*WHERE n\.type LIKE 'anomaly-%'\s*AND n\.data->>'transaction_id' = t\.transaction_id\s*AND n\.created_at > now\(\) - make_interval\(days => 30\)\)/);
    assert.match(cand.sql, /SELECT t\.transaction_id,/);
  });

  it("no pg_stat_activity read and no created_at watermark left", () => {
    const src = read("teller", "routes", "enrollments.js");
    const fn = src.slice(src.indexOf("async function runAnomalyCheck()"), src.indexOf("// recordSyncResult —"));
    assert.doesNotMatch(fn, /pg_stat_activity|xact_start|::text AS hw/);
    assert.doesNotMatch(fn, /t\.created_at > \$1|created_at <= \$2/);
  });

  it("advances to the mark (id and time, never backwards)", async () => {
    const log = fake();
    await enr.runAnomalyCheck();
    const up = find(log, /^UPDATE user_settings/);
    assert.equal(up.length, 1);
    assert.equal(up[0].sql, tw.advanceSql("last_anomaly_txn_id", "last_anomaly_check_at"));
    assert.deepEqual(up[0].params, ["500", "2026-10-29 09:00:00.654321+00"]);
  });

  it("each push carries its transaction_id (the overlap dedupe reads it); the tag stays per merchant", async () => {
    fake({ candidates: [BIG] });
    const sent = [];
    notifications.sendToAll = async (p) => { sent.push(p); return { logged: true }; };
    persistent.sendCriticalAlertEmail = async () => {};
    await enr.runAnomalyCheck();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].tag, "anomaly-coffeeco");
    assert.deepEqual(sent[0].data, { url: "/transactions", transaction_id: "txn-9" });
  });

  it("a push that throws or isn't logged holds the watermark", async () => {
    persistent.sendCriticalAlertEmail = async () => {};
    const quiet = console.error; console.error = () => {};
    try {
      for (const send of [async () => { throw new Error("push down"); }, async () => ({ sent: 0, failed: 0, logged: false })]) {
        const log = fake({ candidates: [BIG] });
        notifications.sendToAll = send;
        await enr.runAnomalyCheck();
        assert.equal(find(log, /^UPDATE user_settings/).length, 0);
      }
    } finally { console.error = quiet; }
  });

  it("an empty transactions table: the mark only, no candidate read or update; no stored id reads as 0", async () => {
    let log = fake({ mark: { mark_id: "0", mark_at: "2026-10-29 09:00:00+00" } });
    await enr.runAnomalyCheck();
    assert.equal(find(log, /avg_tbl|^UPDATE/).length, 0);
    log = fake({ settings: { last_anomaly_txn_id: null, last_anomaly_check_at: null } });
    await enr.runAnomalyCheck();
    assert.deepEqual(find(log, /avg_tbl/)[0].params, ["0", null, "500"]);
  });
});

// ---------------------------------------------------------------------------
describe("runPaydayLanded's overlap", () => {
  const pa = require("../teller/services/payday-alerts");
  beforeEach(() => pa._reset());
  const PAY = ["2026-01-04", "2026-01-18", "2026-02-01", "2026-02-15", "2026-03-01", "2026-03-15"]
    .map((date) => ({ source: "ACME PAYROLL", date, amount: "2100" }));
  const tagOf = (id) => "payday-" + crypto.createHash("sha256").update(id).digest("hex").slice(0, 12);
  function pool(candidates, announced = []) {
    const calls = { updates: [], candidateSql: null, candidateParams: null, dedupe: [] };
    return {
      calls,
      query: async (sql, params) => {
        if (/SELECT payday_alerts_enabled, last_income_alert_txn_id/.test(sql)) return { rows: [{ payday_alerts_enabled: true, last_income_alert_txn_id: "400", last_income_alert_at: "2026-03-16 10:00:00+00" }] };
        if (sql === tw.MARK_SQL) return { rows: [{ mark_id: "500", mark_at: "2026-03-19 10:00:00+00" }] };
        if (/^UPDATE user_settings/.test(sql)) { calls.updates.push({ sql, params }); return { rows: [] }; }
        if (/FROM notification_log/.test(sql)) { calls.dedupe.push({ sql, params }); return { rows: announced.filter((t) => params[0].includes(t)).map((type) => ({ type })) }; }
        if (/AS in_overlap/.test(sql)) { calls.candidateSql = sql; calls.candidateParams = params; return { rows: candidates }; }
        if (/INTERVAL '4 months'/.test(sql)) return { rows: PAY };
        throw new Error("unexpected query: " + sql.slice(0, 60));
      },
    };
  }
  const cand = (id, source, amount, date, rowId, in_overlap) => ({ id: String(rowId), transaction_id: id, source, amount: String(amount), date, in_overlap });
  const send = (sent) => async (x) => { sent.push(x); return { logged: true }; };

  it("reads the window with a 24 h overlap of the previous check and marks the overlap rows", async () => {
    const p = pool([]);
    await pa.runPaydayLanded(p, { today: "2026-03-19" });
    const w = tw.windowSql({ alias: "", watermark: "$1", since: "$2", mark: "$3", overlapHours: 24 });
    assert.ok(p.calls.candidateSql.includes(w.where));
    assert.ok(p.calls.candidateSql.includes(`${w.inOverlap} AS in_overlap`));
    assert.deepEqual(p.calls.candidateParams.slice(0, 3), ["400", "2026-03-16 10:00:00+00", "500"]);
    assert.equal(pa.LANDED_OVERLAP_HOURS, 24);
  });

  it("an overlap deposit not yet announced is announced (a CSV import committed a lower id after the check)", async () => {
    const sent = [];
    const p = pool([cand("late", "ACME PAYROLL", 2100, "2026-03-15", 390, true)]);
    const r = await pa.runPaydayLanded(p, { today: "2026-03-19", deps: { sendToAll: send(sent) } });
    assert.equal(r.notified, 1);
    assert.equal(sent[0].tag, tagOf("late"));
    assert.deepEqual(p.calls.dedupe[0].params, [[tagOf("late")]]);
  });

  it("one already announced is skipped, a new one after it announced; the advance is GREATEST to the mark", async () => {
    const sent = [];
    const p = pool([
      cand("old", "ACME PAYROLL", 2100, "2026-03-15", 380, true),
      cand("new", "ACME PAYROLL", 2100, "2026-03-16", 450, false),
    ], [tagOf("old")]);
    const r = await pa.runPaydayLanded(p, { today: "2026-03-19", deps: { sendToAll: send(sent) } });
    assert.deepEqual(sent.map((x) => x.tag), [tagOf("new")]);
    assert.equal(r.notified, 1);
    assert.deepEqual(p.calls.dedupe[0].params, [[tagOf("old")]], "only overlap rows that match a stream are looked up");
    assert.equal(p.calls.updates[0].sql, tw.advanceSql("last_income_alert_txn_id", "last_income_alert_at"));
    assert.deepEqual(p.calls.updates[0].params, ["500", "2026-03-19 10:00:00+00"]);
  });

  it("an overlap deposit whose alert isn't logged: the stored id can't move back (GREATEST), the time stays — retried next run", async () => {
    const quiet = console.error; console.error = () => {};
    let p;
    try {
      p = pool([cand("late", "ACME PAYROLL", 2100, "2026-03-15", 390, true)]);
      const r = await pa.runPaydayLanded(p, { today: "2026-03-19", deps: { sendToAll: async () => ({ logged: false }) } });
      assert.equal(r.status, "held_back");
    } finally { console.error = quiet; }
    assert.deepEqual(p.calls.updates[0].params, ["389", "2026-03-16 10:00:00+00"]);
    assert.match(p.calls.updates[0].sql, /GREATEST\(COALESCE\(last_income_alert_txn_id, 0\), \$1::bigint\)/);
  });

  it("no overlap row matches a stream: no dedupe read", async () => {
    const p = pool([cand("x", "IRS REFUND", 50, "2026-03-15", 390, true)]);
    await pa.runPaydayLanded(p, { today: "2026-03-19", deps: { sendToAll: send([]) } });
    assert.equal(p.calls.dedupe.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("the migrations", () => {
  const src = read("teller", "services", "database.js");
  it("add both BIGINT ids and backfill each once from its time watermark", () => {
    assert.match(src, /ADD COLUMN IF NOT EXISTS last_anomaly_txn_id BIGINT/);
    assert.match(src, /SET last_anomaly_txn_id = \(SELECT MAX\(id\) FROM transactions WHERE created_at <= user_settings\.last_anomaly_check_at\)\s+WHERE last_anomaly_txn_id IS NULL AND last_anomaly_check_at IS NOT NULL/);
    assert.match(src, /ADD COLUMN IF NOT EXISTS last_income_alert_txn_id BIGINT/);
    assert.match(src, /SET last_income_alert_txn_id = \(SELECT MAX\(id\) FROM transactions WHERE created_at <= user_settings\.last_income_alert_at\)\s+WHERE last_income_alert_txn_id IS NULL AND last_income_alert_at IS NOT NULL/);
    // The backfills run after the columns they read.
    assert.ok(src.indexOf("last_anomaly_check_at TIMESTAMPTZ") < src.indexOf("SET last_anomaly_txn_id ="));
    assert.ok(src.indexOf("last_income_alert_at TIMESTAMPTZ") < src.indexOf("SET last_income_alert_txn_id ="));
  });
});
