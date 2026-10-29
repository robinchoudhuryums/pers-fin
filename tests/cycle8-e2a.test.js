// ============================================================================
// Cycle 8 E2a (ST1) — the due-based job runner (services/job-runner.js)
// ============================================================================
// Over a fake job_runs table with one clock for the app and the database:
// registration checks; the one job_runs read on the first check and none after
// when nothing is due; due jobs run once, oldest-due first, one at a time with
// the gap between them; a time loaded from job_runs respected; a claim another
// process took → not run and the time refreshed; a failed read → every job
// due; a failed claim → run anyway; a closed / throwing gate → no query, still
// due, run once it opens; a throwing run logged and the next one run; checks
// never overlapping; start / stop scheduling and a stop mid-check; the claim
// SQL and the migration. The database-backed half is
// tests/contract/job-runner-e2a.contract.test.js.
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createJobRunner, CLAIM_SQL, LOAD_SQL, LAST_RAN_SQL, DEFAULTS } = require("../teller/services/job-runner");

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);

// A fake job_runs keyed by name → last_ran_at (ms), sharing `clock` with the app.
function fakeDb({ rows = {}, failLoad = false, failClaim = false } = {}) {
  const clock = { t: T0 };
  const store = new Map(Object.entries(rows));
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === LOAD_SQL) {
        if (failLoad) throw new Error("db down");
        return { rows: params[0].filter((n) => store.has(n)).map((n) => ({ job_name: n, ran_ms: store.get(n) })) };
      }
      if (sql === CLAIM_SQL) {
        if (failClaim) throw new Error("db down");
        const [name, secs] = params;
        const prev = store.has(name) ? store.get(name) : null;
        if (prev == null || prev <= clock.t - secs * 1000) {
          store.set(name, clock.t);
          return { rows: [{ prev_ms: prev }] };
        }
        return { rows: [] };
      }
      if (sql === LAST_RAN_SQL) return { rows: store.has(params[0]) ? [{ ran_ms: store.get(params[0]) }] : [] };
      throw new Error("unexpected query " + sql);
    },
  };
  return { pool, clock, store, queries };
}

function setup(dbOpts = {}, runnerOpts = {}) {
  const db = fakeDb(dbOpts);
  const sleeps = [];
  const errors = [];
  const ran = [];
  const runner = createJobRunner({
    pool: db.pool,
    now: () => db.clock.t,
    sleep: async (ms) => { sleeps.push(ms); },
    log: { error: (...a) => errors.push(a.join(" ")) },
    ...runnerOpts,
  });
  const job = (name, everyMs, extra = {}) => runner.register({ name, everyMs, run: async () => { ran.push(name); }, ...extra });
  return { db, runner, sleeps, errors, ran, job };
}
const kinds = (qs) => qs.map((q) => (q.sql === LOAD_SQL ? "load" : q.sql === CLAIM_SQL ? "claim:" + q.params[0] : "last:" + q.params[0]));

describe("registration", () => {
  it("refuses a duplicate name, a bad cadence or a missing run", () => {
    const { runner, job } = setup();
    job("a", HOUR);
    assert.throws(() => job("a", HOUR), /registered twice/);
    assert.throws(() => runner.register({ name: "b", everyMs: 0, run: () => {} }), /positive/);
    assert.throws(() => runner.register({ name: "c", everyMs: NaN, run: () => {} }), /positive/);
    assert.throws(() => runner.register({ name: "d", everyMs: HOUR }), /run must be a function/);
    assert.throws(() => runner.register({ everyMs: HOUR, run: () => {} }), /name required/);
    assert.deepEqual(runner.list(), [{ name: "a", everyMs: HOUR, gated: false }]);
  });
});

describe("due checks", () => {
  it("with no history every job is due: each claimed and run once, in registration order, a gap between them", async () => {
    const { db, runner, ran, sleeps, job } = setup();
    job("cash", HOUR); job("digest", HOUR); job("insights", 6 * HOUR);
    const out = await runner.check();
    assert.deepEqual(out.ran, ["cash", "digest", "insights"]);
    assert.deepEqual(ran, ["cash", "digest", "insights"]);
    assert.deepEqual(kinds(db.queries), ["load", "claim:cash", "claim:digest", "claim:insights"]);
    assert.deepEqual(sleeps, [DEFAULTS.gapMs, DEFAULTS.gapMs], "a gap between jobs, none before the first");
    assert.equal(db.queries.find((q) => q.sql === CLAIM_SQL).params[1], HOUR * 0.9 / 1000, "the claim's slack is 90% of the cadence");
  });

  it("a check with nothing due makes no query", async () => {
    const { db, runner, job } = setup();
    job("cash", HOUR);
    await runner.check();
    const n = db.queries.length;
    db.clock.t += 30 * 60 * 1000;
    assert.deepEqual((await runner.check()).ran, []);
    assert.equal(db.queries.length, n, "no load again, no claim");
    db.clock.t += 30 * 60 * 1000;
    assert.deepEqual((await runner.check()).ran, ["cash"], "due a cadence after its last run");
  });

  it("respects the times in job_runs: a job that ran 10 minutes ago waits; one that ran 2 hours ago runs", async () => {
    const { runner, ran, job } = setup({ rows: { fresh: T0 - 10 * 60 * 1000, stale: T0 - 2 * HOUR, other: T0 } });
    job("fresh", HOUR); job("stale", HOUR);
    await runner.check();
    assert.deepEqual(ran, ["stale"]);
    assert.deepEqual(runner._lastRan.get("fresh"), T0 - 10 * 60 * 1000);
    assert.ok(!runner._lastRan.has("other"), "a row of an unregistered job is ignored");
  });

  it("runs the oldest-due first", async () => {
    const { runner, ran, job } = setup({ rows: { a: T0 - 2 * HOUR, b: T0 - 30 * HOUR, c: T0 - 7 * HOUR } });
    job("a", HOUR); job("b", 24 * HOUR); job("c", 6 * HOUR); job("d", HOUR);
    await runner.check();
    // due at: a T0−1h, b T0−6h, c T0−1h, d never run (−∞)
    assert.deepEqual(ran, ["d", "b", "a", "c"]);
  });

  it("a job another process just claimed isn't run, and its time is taken from the row", async () => {
    const { db, runner, ran, job } = setup();
    job("cash", HOUR);
    await runner.check(); // loads; ran
    ran.length = 0;
    db.clock.t += HOUR;
    db.store.set("cash", db.clock.t - 5000); // the other process ran it 5 s ago
    const out = await runner.check();
    assert.deepEqual(out.ran, []);
    assert.equal(runner._lastRan.get("cash"), db.clock.t - 5000);
    assert.deepEqual(kinds(db.queries).slice(-2), ["claim:cash", "last:cash"]);
    db.clock.t += 30 * 60 * 1000;
    const n = db.queries.length;
    await runner.check();
    assert.equal(db.queries.length, n, "not due again until a cadence after the other process's run");
  });

  it("a failed job_runs read treats every job as due; a failed claim runs the job anyway", async () => {
    const a = setup({ rows: { recent: T0 - 60 * 1000 }, failLoad: true });
    a.job("cash", HOUR); a.job("recent", HOUR);
    await a.runner.check();
    assert.deepEqual(a.ran, ["cash"], "both due; the claim still stops a re-run of the one that ran a minute ago");
    assert.deepEqual(kinds(a.db.queries), ["load", "claim:cash", "claim:recent", "last:recent"]);
    assert.match(a.errors[0], /could not read job_runs/);
    assert.equal(a.runner._isLoaded(), true, "the read isn't retried every check");

    const b = setup({ failClaim: true });
    b.job("cash", HOUR);
    await b.runner.check();
    assert.deepEqual(b.ran, ["cash"]);
    assert.match(b.errors[0], /claim for cash failed — running it anyway/);
    const n = b.db.queries.length;
    await b.runner.check();
    assert.equal(b.db.queries.length, n, "its in-memory time still moved, so it isn't re-run at once");
  });
});

describe("gates", () => {
  it("a closed gate costs no query and keeps the job due; it runs at the first check after the gate opens", async () => {
    let active = false;
    const { db, runner, ran, sleeps, job } = setup();
    job("snapshot", 6 * HOUR, { when: () => active });
    job("cash", HOUR);
    await runner.check();
    assert.deepEqual(ran, ["cash"]);
    assert.ok(!kinds(db.queries).includes("claim:snapshot"));
    assert.deepEqual(sleeps, [], "a gated-off job doesn't take a gap");
    db.clock.t += 5 * 60 * 1000;
    active = true;
    await runner.check();
    assert.deepEqual(ran, ["cash", "snapshot"], "five minutes later, not a full cadence");
  });

  it("a gate that throws counts as closed", async () => {
    const { runner, ran, errors, job } = setup();
    job("x", HOUR, { when: () => { throw new Error("boom"); } });
    await runner.check();
    assert.deepEqual(ran, []);
    assert.match(errors[0], /x's gate threw: boom/);
  });
});

describe("runs", () => {
  it("a run that throws is logged, the next job runs, and the failed one waits a cadence", async () => {
    const { db, runner, ran, errors } = setup();
    runner.register({ name: "bad", everyMs: HOUR, run: async () => { throw new Error("kaput"); } });
    runner.register({ name: "good", everyMs: HOUR, run: async () => { ran.push("good"); } });
    const out = await runner.check();
    assert.deepEqual(out.ran, ["bad", "good"]);
    assert.match(errors[0], /bad failed: kaput/);
    db.clock.t += 10 * 60 * 1000;
    assert.deepEqual((await runner.check()).ran, []);
  });

  it("one job at a time, and a check called during another returns the same promise", async () => {
    let release;
    let inFlight = 0, maxInFlight = 0;
    const { runner } = setup();
    const body = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => { release = r; }); inFlight--; };
    runner.register({ name: "a", everyMs: HOUR, run: body });
    runner.register({ name: "b", everyMs: HOUR, run: async () => {} });
    const p1 = runner.check();
    const p2 = runner.check();
    assert.equal(p1, p2);
    while (!release) await new Promise((r) => setImmediate(r));
    release();
    assert.deepEqual((await p1).ran, ["a", "b"]);
    assert.equal(maxInFlight, 1);
    assert.notEqual(runner.check(), p1, "a later check is a new one");
  });

  it("onCheck sees every registered job on each check, and a throwing onCheck doesn't stop it", async () => {
    const seen = [];
    const { runner, ran, job } = setup({}, { onCheck: (n) => { seen.push(n); if (n === "a") throw new Error("x"); } });
    job("a", HOUR); job("b", HOUR);
    await runner.check();
    await runner.check();
    assert.deepEqual(seen, ["a", "b", "a", "b"]);
    assert.deepEqual(ran, ["a", "b"]);
  });
});

describe("start / stop", () => {
  function timers() {
    const set = [];
    return {
      set,
      setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; set.push(h); return h; },
      clearTimer: (h) => { h.cleared = true; },
    };
  }

  it("the first check comes firstCheckMs after start, then every checkEveryMs; nothing queries at start", async () => {
    const tm = timers();
    const { db, runner, ran, job } = setup({}, { setTimer: tm.setTimer, clearTimer: tm.clearTimer });
    job("cash", HOUR);
    runner.start();
    runner.start(); // idempotent
    assert.equal(tm.set.length, 1);
    assert.equal(tm.set[0].ms, DEFAULTS.firstCheckMs);
    assert.equal(db.queries.length, 0);
    await tm.set[0].fn();
    assert.deepEqual(ran, ["cash"]);
    assert.equal(tm.set.length, 2);
    assert.equal(tm.set[1].ms, DEFAULTS.checkEveryMs);
    runner.stop();
    assert.equal(tm.set[1].cleared, true);
  });

  it("stop during a check runs no further job, and no new check is scheduled", async () => {
    const tm = timers();
    let release;
    const { runner, ran } = setup({}, { setTimer: tm.setTimer, clearTimer: tm.clearTimer });
    runner.register({ name: "a", everyMs: HOUR, run: async () => { ran.push("a"); await new Promise((r) => { release = r; }); } });
    runner.register({ name: "b", everyMs: HOUR, run: async () => { ran.push("b"); } });
    runner.start();
    const tick = tm.set[0].fn();
    while (!release) await new Promise((r) => setImmediate(r));
    const stopped = runner.stop();
    release();
    await stopped;
    await tick;
    assert.deepEqual(ran, ["a"]);
    assert.equal(tm.set.length, 1, "no check scheduled after stop");
  });

  it("the default timers are unref'd so the runner never keeps the process alive", () => {
    const { runner, job } = setup();
    job("cash", HOUR);
    const orig = global.setTimeout;
    let unrefd = false;
    global.setTimeout = (fn, ms) => { const h = orig(() => {}, 0); const u = h.unref.bind(h); h.unref = () => { unrefd = true; return u(); }; clearTimeout(h); return h; };
    try {
      const r = createJobRunner({ pool: { query: async () => ({ rows: [] }) } });
      r.register({ name: "x", everyMs: HOUR, run: () => {} });
      r.start();
      r.stop();
    } finally { global.setTimeout = orig; }
    assert.equal(unrefd, true);
    runner.stop();
  });
});

describe("SQL and schema", () => {
  it("the claim takes the row only when its last run is old enough, and reports the previous time", () => {
    assert.match(CLAIM_SQL, /WITH prev AS \(SELECT last_ran_at FROM job_runs WHERE job_name = \$1\)/);
    assert.match(CLAIM_SQL, /ON CONFLICT \(job_name\) DO UPDATE SET last_ran_at = now\(\)/);
    assert.match(CLAIM_SQL, /WHERE job_runs\.last_ran_at IS NULL\s+OR job_runs\.last_ran_at <= now\(\) - make_interval\(secs => \$2::float8\)/);
    assert.match(LOAD_SQL, /WHERE job_name = ANY\(\$1::text\[\]\)/);
  });
  it("job_runs gains last_ran_at", () => {
    const db = fs.readFileSync(path.join(__dirname, "..", "teller", "services", "database.js"), "utf8");
    assert.match(db, /ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS last_ran_at TIMESTAMPTZ/);
    assert.ok(db.indexOf("ADD COLUMN IF NOT EXISTS last_ran_at") > db.indexOf("CREATE TABLE IF NOT EXISTS job_runs"));
  });
  it("startup.js schedules through it (E2b — tests/cycle8-e2b.test.js)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "teller", "startup.js"), "utf8");
    assert.match(src, /require\("\.\/services\/job-runner"\)/);
  });
});
