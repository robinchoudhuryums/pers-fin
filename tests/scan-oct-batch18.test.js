// ============================================================================
// Cycle-7 (Oct 2026) Batch 18 — asynchronous sync for the backstops (ST1)
// ============================================================================
// POST /api/sync, /api/sync-balances and /api/sync/reconcile accept
// `background: true`: 202 + a job id at once, the work detached, the outcome at
// GET /api/sync/status?kind=. A manual POST during a run shares it. The daily
// and weekly workflows start background runs and poll (run_background), and
// every workflow that curls reports a timeout through check_status (the Batch 3
// follow-on). The run_background helper is executed in bash below against a
// fake server. The database-backed half is tests/contract/async-sync.contract.
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const plaidClientModule = require("../teller/services/plaid-client");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const originalQuery = dbModule.pool.query;
const originalGetPlaidClient = plaidClientModule.getPlaidClient;

let enr;
const calls = [];
let gate = null;          // a promise the Teller enrollment read waits on
let tellerThrows = false;
function openGate() {
  let release;
  gate = new Promise((r) => { release = r; });
  return () => { gate = null; release(); };
}
const ran = (re) => calls.filter((c) => re.test(c.sql));
// The manual POST has reached the route once the second request has been
// received by the app (counted by a tiny middleware in app()).
let hits = 0;
const routeHit = () => hits >= 2;
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("timed out waiting");
}

before(() => {
  plaidClientModule.getPlaidClient = () => null; // Plaid not configured
  delete require.cache[require.resolve("../teller/routes/enrollments")];
  delete require.cache[require.resolve("../teller/routes/investments")];
  enr = require("../teller/routes/enrollments");
});
after(() => {
  plaidClientModule.getPlaidClient = originalGetPlaidClient;
  dbModule.pool.query = originalQuery;
});
beforeEach(() => {
  calls.length = 0;
  hits = 0;
  gate = null;
  tellerThrows = false;
  dbModule.pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM teller_enrollments/.test(sql)) {
      if (gate) await gate;
      if (tellerThrows) throw new Error("Teller API error 500: {\"secret\":\"body\"}");
      return { rows: [] };
    }
    if (/SELECT last_sync_result FROM user_settings/.test(sql)) return { rows: [{ last_sync_result: null }] };
    return { rows: [], rowCount: 0 };
  };
});
const app = () => {
  const a = express();
  a.use((req, _res, next) => { if (req.method === "POST" && req.path === "/api/sync") hits++; next(); });
  a.use(express.json());
  a.use(enr);
  return a;
};

// ---------------------------------------------------------------------------
describe("ST1 — background runs", () => {
  it("POST /api/sync {background:true}: 202 + id, status running → done; a second start is a 409 on the same id", async () => {
    const release = openGate();
    const a = app();
    const start = await supertest(a).post("/api/sync").send({ background: true }).expect(202);
    assert.equal(start.body.kind, "sync");
    assert.ok(Number.isInteger(start.body.id));
    const running = await supertest(a).get("/api/sync/status?kind=sync").expect(200);
    assert.deepEqual([running.body.running, running.body.id], [true, start.body.id]);
    const again = await supertest(a).post("/api/sync").send({ background: true }).expect(409);
    assert.equal(again.body.id, start.body.id, "a poller follows the run already in progress");
    release();
    await waitFor(async () => !(await supertest(a).get("/api/sync/status?kind=sync")).body.running);
    const done = (await supertest(a).get("/api/sync/status?kind=sync")).body;
    assert.equal(done.error, null);
    assert.equal(done.result.transactions_added, 0);
    assert.ok(done.finished_at);
    assert.equal(ran(/SET last_txn_sync_at = now\(\)/).length, 1);
    assert.equal(ran(/UPDATE user_settings SET last_sync_result/).length, 1, "recorded exactly as the synchronous path does");
  });

  it("a manual POST during a background run shares it — one sync, one record", async () => {
    const release = openGate();
    const a = app();
    await supertest(a).post("/api/sync").send({ background: true }).expect(202);
    const manual = supertest(a).post("/api/sync").send({});
    const p = manual.then((r) => r);
    // Let the manual request reach the route while the background run is held.
    await waitFor(async () => calls.length > 0 && routeHit());
    release();
    const res = await p;
    assert.equal(res.status, 200);
    assert.equal(res.body.transactions_added, 0);
    await waitFor(async () => !enr._bgJobs.sync.running);
    assert.equal(ran(/SET last_txn_sync_at = now\(\)/).length, 1, "one run, not two");
    assert.equal(ran(/UPDATE user_settings SET last_sync_result/).length, 1);
  });

  it("nothing synced → the status carries a fixed error, never the exception text", async () => {
    tellerThrows = true;
    const a = app();
    await supertest(a).post("/api/sync").send({ background: true }).expect(202);
    await waitFor(async () => !enr._bgJobs.sync.running);
    const st = (await supertest(a).get("/api/sync/status?kind=sync")).body;
    assert.equal(st.error, "Nothing synced: the Teller sync failed and Plaid did not succeed.");
    assert.ok(!st.error.includes("secret"), "no Teller response body in the status's error (the workflows may print it some day)");
  });

  it("the synchronous path is unchanged (result inline; 500 when nothing synced)", async () => {
    const ok = await supertest(app()).post("/api/sync").expect(200);
    assert.equal(ok.body.enrollments_synced, 0);
    assert.equal(ok.body.kind, undefined, "no job wrapper on the synchronous answer");
    tellerThrows = true;
    await supertest(app()).post("/api/sync").expect(500);
  });

  it("sync-balances runs in the background too; a Teller throw is the status's error", async () => {
    const a = app();
    const release = openGate();
    const start = await supertest(a).post("/api/sync-balances").send({ background: true }).expect(202);
    assert.equal(start.body.kind, "sync-balances");
    release();
    await waitFor(async () => !enr._bgJobs["sync-balances"].running);
    let st = (await supertest(a).get("/api/sync/status?kind=sync-balances")).body;
    assert.equal(st.error, null);
    assert.equal(st.result.holdings_updated, 0);

    tellerThrows = true;
    await supertest(a).post("/api/sync-balances").send({ background: true }).expect(202);
    await waitFor(async () => !enr._bgJobs["sync-balances"].running);
    st = (await supertest(a).get("/api/sync/status?kind=sync-balances")).body;
    assert.equal(st.error, "The Teller balance sync failed.");
    await supertest(a).post("/api/sync-balances").expect(500); // the synchronous answer is still a 500
  });

  it("the background reconcile shares the tracker: id + kind on the 202, the same slot at both status URLs", async () => {
    const a = app();
    const start = await supertest(a).post("/api/sync/reconcile").send({ provider: "teller", days: 7, background: true }).expect(202);
    assert.equal(start.body.kind, "reconcile");
    await waitFor(async () => !enr._bgJobs.reconcile.running);
    const a1 = (await supertest(a).get("/api/sync/status?kind=reconcile")).body;
    const a2 = (await supertest(a).get("/api/sync/reconcile/status")).body;
    assert.deepEqual(a1, a2);
    assert.equal(a1.id, start.body.id);
    assert.deepEqual([a1.provider, a1.days], ["teller", 7]);
  });

  it("an unknown kind is a 400", async () => {
    await supertest(app()).get("/api/sync/status?kind=insights").expect(400);
  });
});

// ---------------------------------------------------------------------------
// The workflows' bash helpers, run for real against a fake server.
function blockOf(yaml, key) {
  const lines = yaml.split("\n");
  const i = lines.findIndex((l) => l.trim() === key + ": |");
  assert.ok(i >= 0, key + " not found");
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() === "" || l.startsWith("        ")) out.push(l.slice(8));
    else break;
  }
  return out.join("\n");
}
function bash(script, env) {
  return new Promise((resolve) => {
    execFile("bash", ["-e", "-c", script], { env: { ...process.env, ...env }, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr });
    });
  });
}

describe("ST1 — run_background (daily-sync.yml / weekly-reconcile.yml)", () => {
  const yaml = read(".github", "workflows", "daily-sync.yml");
  const helpers = blockOf(yaml, "CHECK_STATUS") + "\n" + blockOf(yaml, "RUN_BACKGROUND");
  let server, base, mode, polls, posted;

  before(async () => {
    const a = express();
    a.use(express.json());
    a.post("/perfin/api/sync", (req, res) => {
      posted.push({ body: req.body, key: req.get("x-api-key") });
      if (mode === "busy") return res.status(409).json({ running: true, id: 7 });
      if (mode === "down") return res.status(503).json({});
      res.status(202).json({ started: true, id: 7 });
    });
    a.get("/perfin/api/sync/status", (req, res) => {
      polls++;
      if (mode === "lost") return res.json({ id: null, running: false, error: null });
      if (mode === "slow") return res.json({ id: 7, running: true });
      if (polls < 3) return res.json({ id: 7, running: true });
      if (mode === "error") return res.json({ id: 7, running: false, error: "Nothing synced: Chase secret detail", result: null });
      return res.json({ id: 7, running: false, error: null, result: { transactions_added: 3, errors: [{ institution: "Chase" }] } });
    });
    await new Promise((r) => { server = a.listen(0, "127.0.0.1", r); });
    base = "http://127.0.0.1:" + server.address().port;
  });
  after(() => server.close());
  beforeEach(() => { polls = 0; posted = []; });

  const run = (extra = {}) => bash(
    helpers + '\nRC=0\nrun_background "Transaction sync" /perfin/api/sync sync /tmp/b18-$$.json \'{"background": true}\' || RC=$?\necho "RC=$RC"\n',
    { SERVER_URL: base, API_KEY: "k1", BG_POLL_SECONDS: "0", BG_DEADLINE_SECONDS: "3", ...extra });

  it("starts with background:true + the api key, polls until done and succeeds", async () => {
    mode = "ok";
    const r = await run();
    assert.match(r.out, /Transaction sync: finished/);
    assert.match(r.out, /RC=0/);
    assert.deepEqual(posted, [{ body: { background: true }, key: "k1" }]);
    assert.ok(polls >= 3);
  });

  it("a server-side error, a lost run, a down server and the deadline each fail the step without printing the body", async () => {
    mode = "error";
    let r = await run();
    assert.match(r.out, /::error::Transaction sync failed on the server/);
    assert.match(r.out, /RC=1/);
    assert.ok(!r.out.includes("Chase"), "the job's error text is not printed");
    mode = "lost";
    r = await run();
    assert.match(r.out, /::error::Transaction sync: the server lost the run/);
    mode = "down";
    r = await run();
    assert.match(r.out, /::error::Transaction sync \(start\) failed with HTTP 503/);
    mode = "slow";
    r = await run({ BG_DEADLINE_SECONDS: "1" });
    assert.match(r.out, /::error::Transaction sync: still running after 0 minutes/);
    assert.match(r.out, /RC=1/);
  });

  it("a 409 follows the run already in progress", async () => {
    mode = "busy";
    const r = await run();
    assert.match(r.out, /already in progress on the server; following it/);
    assert.match(r.out, /RC=0/);
  });

  it("an unreachable server is reported, not a silent exit", async () => {
    const r = await bash(helpers + '\nRC=0\nrun_background "Transaction sync" /perfin/api/sync sync /tmp/b18-x.json \'{}\' || RC=$?\necho "RC=$RC"\n',
      { SERVER_URL: "http://127.0.0.1:9", API_KEY: "k", BG_POLL_SECONDS: "0", BG_DEADLINE_SECONDS: "1" });
    assert.match(r.out, /::error::Transaction sync \(start\): no response/);
    assert.match(r.out, /RC=1/);
  });
});

// ---------------------------------------------------------------------------
describe("ST1 — workflow wiring", () => {
  const wf = (f) => read(".github", "workflows", f);

  it("daily-sync runs both syncs in the background and prints only allowlisted result keys", () => {
    const y = wf("daily-sync.yml");
    assert.match(y, /run_background "Transaction sync" \/perfin\/api\/sync sync \/tmp\/sync\.json '\{"background": true\}' \|\| RC=\$\?/);
    assert.match(y, /run_background "Balance sync" \/perfin\/api\/sync-balances sync-balances \/tmp\/balances\.json '\{"background": true\}' \|\| RC=\$\?/);
    assert.match(y, /node -e "\$SUMMARY_JS" \/tmp\/sync\.json result\.enrollments_synced result\.transactions_added result\.errors/);
    assert.doesNotMatch(y, /--max-time 420/);
    assert.match(y, /SERVER_URL: \$\{\{ secrets\.SERVER_URL \}\}\n\s+API_KEY: \$\{\{ secrets\.API_KEY \}\}/);
  });

  it("weekly-reconcile uses the background reconcile", () => {
    const y = wf("weekly-reconcile.yml");
    assert.match(y, /run_background "Reconcile" \/perfin\/api\/sync\/reconcile reconcile \/tmp\/reconcile\.json '\{"days": 90, "provider": "teller", "background": true\}'/);
    assert.doesNotMatch(y, /--max-time 540/);
  });

  it("every workflow that calls the app reports a curl timeout through check_status (Batch 3 follow-on)", () => {
    for (const f of ["daily-sync.yml", "weekly-reconcile.yml", "knowledge-reindex.yml", "job-radar.yml"]) {
      const y = wf(f);
      assert.match(y, /check_status\(\) \{/, f);
      assert.match(y, /eval "\$CHECK_STATUS"/, f);
      assert.match(y, /::error::\$1?\w*:? ?no response \(timed out or server unreachable\)|::error::\$label: no response \(timed out or server unreachable\)/, f);
    }
    assert.match(wf("knowledge-reindex.yml"), /--max-time 90[\s\S]*?\|\| true\n[\s\S]*?check_status "Reindex trigger" "\$STATUS" 202/);
    assert.match(wf("job-radar.yml"), /--max-time 600[\s\S]*?\|\| true\n[\s\S]*?check_status "Job Radar refresh" "\$STATUS"/);
  });

  it("the shared check_status accepts an expected status list", async () => {
    const helpers = blockOf(wf("job-radar.yml"), "CHECK_STATUS");
    const r = await bash(helpers + '\ncheck_status A 202 202 && check_status B 200 && echo OK1\ncheck_status C 200 202 || echo FAIL1\ncheck_status D 000 || echo FAIL2\n', {});
    assert.match(r.out, /A: HTTP 202\nB: HTTP 200\nOK1/);
    assert.match(r.out, /::error::C failed with HTTP 200\nFAIL1/);
    assert.match(r.out, /::error::D: no response[\s\S]*FAIL2/);
  });
});
