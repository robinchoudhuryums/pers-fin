// Real-Postgres contract test for cycle-8 E2d (ST3) — "Since you last looked"
// through the production mount order:
//  - a transaction and a notification that arrive between the GET and its
//    /seen are shown on the next visit (/seen used to stamp now())
//  - what the GET showed isn't shown again
//  - an older token posted after a newer one doesn't move the watermark back
//  - a token-less /seen (a page loaded before E2d) still means "seen up to now"
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe('"Since you last looked" on an id watermark (cycle-8 E2d) on real Postgres', { skip: SKIP }, () => {
  let pool, app, today;
  const q = (s, p) => pool.query(s, p);
  const tx = (id, merchant) => q(
    "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('chk',$1,12.5,$2,$3,$3,false)",
    [id, today, merchant]);
  const note = (title) => q("INSERT INTO notification_log (type, title, body) VALUES ('t', $1, '')", [title]);
  const get = async () => (await supertest(app).get("/api/whats-new").expect(200)).body;
  const seen = (body) => supertest(app).post("/api/whats-new/seen").send(body || {});
  const stored = async () => (await q("SELECT last_dashboard_view_txn_id::int AS id, last_dashboard_view_at AS at FROM user_settings WHERE id = 1")).rows[0];

  before(async () => {
    pool = await perfinDb("whats_new_e2d");
    app = perfinApp();
    today = require("../../teller/services/financial-queries").todayStr();
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('chk','Checking','depository','checking',true)");
  });
  after(async () => { if (pool) await pool.end(); });

  it("a transaction and a notification arriving between the GET and /seen show on the next visit — once", async () => {
    await tx("t1", "BAKERY");
    const first = await get();
    assert.deepEqual(first.transactions.map((t) => t.transaction_id), ["t1"], "no stored id yet: by created_at, the 24 h default");
    assert.match(first.seen_token, /^\d+\|/);

    await tx("t2", "GROCER"); // lands after the GET read its mark
    await note("Arrived in between");
    await seen({ seen_token: first.seen_token }).expect(200);
    assert.ok((await stored()).id > 0);

    const second = await get();
    assert.deepEqual(second.transactions.map((t) => t.transaction_id), ["t2"], "t2 shown, t1 not again");
    assert.deepEqual(second.notifications.map((n) => n.title), ["Arrived in between"]);
    await seen({ seen_token: second.seen_token }).expect(200);

    const third = await get();
    assert.equal(third.counts.transactions, 0);
    assert.equal(third.counts.notifications, 0);
  });

  it("an older token posted after a newer one doesn't move the watermark back", async () => {
    const older = (await get()).seen_token;
    await tx("t3", "CAFE");
    const newer = (await get()).seen_token;
    await seen({ seen_token: newer }).expect(200);
    const after = await stored();
    await seen({ seen_token: older }).expect(200);
    const now = await stored();
    assert.equal(now.id, after.id);
    assert.equal(now.at.getTime(), after.at.getTime());
  });

  it("a token past the newest id or in the future is capped; a malformed one is a 400", async () => {
    await seen({ seen_token: "999999|2999-01-01 00:00:00+00" }).expect(200);
    const s = await stored();
    const max = (await q("SELECT MAX(id)::int AS m FROM transactions")).rows[0].m;
    assert.equal(s.id, max);
    assert.ok(s.at.getTime() <= Date.now() + 1000);
    await seen({ seen_token: "x|y" }).expect(400);
  });

  it("a token-less /seen still means seen up to now", async () => {
    await tx("t4", "DELI");
    await seen().expect(200);
    const max = (await q("SELECT MAX(id)::int AS m FROM transactions")).rows[0].m;
    assert.equal((await stored()).id, max);
    assert.equal((await get()).counts.transactions, 0);
  });
});
