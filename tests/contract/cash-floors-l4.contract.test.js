// Real-Postgres contract test for roadmap T2.2 L4 — per-account low-balance
// floors through the real accounts route, the cash alert job and the
// notification log:
//  - PATCH /api/accounts/:id stores a floor on a checking account (cents), 400s
//    on a credit card / brokerage and a bad value, 404s a missing account; GET
//    /api/accounts returns it
//  - a balance below its floor → one "Low balance: <name>" (tag
//    balance-floor-<id>) and last_check.floors_below; a later evaluation within
//    24 h adds nothing; a floor account whose balance is 40 h old is skipped
//  - null clears the floor (and then nothing is checked)
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Account low-balance floors (T2.2 L4) on real Postgres", { skip: SKIP }, () => {
  let pool, app, ca, chk, sav, card, brk;
  const q = (s, p) => pool.query(s, p);
  const floorAlerts = async () => (await q("SELECT type, title, body, data FROM notification_log WHERE type LIKE 'balance-floor-%' ORDER BY id")).rows;
  const ins = async (account_id, name, type, subtype, bal, updated) => (await q(
    "INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance, balance_updated_at) VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id",
    [account_id, name, type, subtype, bal, updated])).rows[0].id;

  before(async () => {
    pool = await perfinDb("cash_floors_l4");
    app = perfinApp();
    ca = require("../../teller/services/cash-alerts");
    chk = await ins("chk", "Everyday Checking", "depository", "checking", 180.25, new Date());
    sav = await ins("sav", "Old Savings", "depository", "savings", 50, new Date(Date.now() - 40 * 3600e3));
    card = await ins("card", "Visa", "credit", "credit_card", 900, new Date());
    brk = await ins("brk", "Brokerage", "depository", "brokerage", 5000, new Date());
    await q("UPDATE user_settings SET cash_alert_enabled = true, cash_alert_threshold = 0 WHERE id = 1");
  });
  after(async () => { if (pool) await pool.end(); });

  it("PATCH stores a floor only on a spendable account; GET /api/accounts returns it", async () => {
    await supertest(app).patch(`/api/accounts/${chk}`).send({ low_balance_floor: "abc" }).expect(400);
    await supertest(app).patch(`/api/accounts/${chk}`).send({ low_balance_floor: -5 }).expect(400);
    assert.match((await supertest(app).patch(`/api/accounts/${card}`).send({ low_balance_floor: 100 }).expect(400)).body.error, /checking or savings/);
    await supertest(app).patch(`/api/accounts/${brk}`).send({ low_balance_floor: 100 }).expect(400);
    await supertest(app).patch("/api/accounts/999999").send({ low_balance_floor: 100 }).expect(404);
    const r = (await supertest(app).patch(`/api/accounts/${chk}`).send({ low_balance_floor: "250.004" }).expect(200)).body;
    assert.equal(parseFloat(r.low_balance_floor), 250);
    await supertest(app).patch(`/api/accounts/${sav}`).send({ low_balance_floor: 100 }).expect(200);
    const list = (await supertest(app).get("/api/accounts").expect(200)).body;
    assert.equal(parseFloat(list.find((a) => a.id === chk).low_balance_floor), 250);
    assert.equal(list.find((a) => a.id === card).low_balance_floor, null);
  });

  it("a balance below its floor alerts once; a 40 h old balance is skipped; again within 24 h adds nothing", async () => {
    ca._reset();
    const r = await ca.runCashAlerts(pool);
    assert.deepEqual(r.floors, { checked: 2, below: 1, notified: 1, unlogged: 0, stale: 1 });
    const rows = await floorAlerts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, `balance-floor-${chk}`);
    assert.equal(rows[0].title, "Low balance: Everyday Checking");
    assert.equal(rows[0].body, "Everyday Checking is at $180.25, below your $250.00 floor.");
    assert.deepEqual(rows[0].data, { url: "/dashboard" });
    const st = (await q("SELECT cash_alert_state FROM user_settings WHERE id = 1")).rows[0].cash_alert_state;
    assert.equal(st.last_check.floors_below, 1);

    await q("UPDATE linked_accounts SET balance_updated_at = now() + interval '1 second' WHERE id = $1", [chk]);
    const again = await ca.runCashAlerts(pool);
    assert.equal(again.ran, true);
    assert.equal(again.floors.below, 1);
    assert.equal((await floorAlerts()).length, 1, "deduped for 24 h through notification_log");
  });

  it("null clears a floor", async () => {
    await supertest(app).patch(`/api/accounts/${chk}`).send({ low_balance_floor: null }).expect(200);
    await supertest(app).patch(`/api/accounts/${sav}`).send({ low_balance_floor: null }).expect(200);
    await q("UPDATE linked_accounts SET balance_updated_at = now() + interval '2 seconds' WHERE id = $1", [chk]);
    ca._reset();
    const r = await ca.runCashAlerts(pool);
    assert.equal(r.floors.checked, 0);
  });
});
