// Real-Postgres contract tests (TQ-2): the Rent & Utilities ledger and the
// Settle Up legs. Regression class: FAN-1 — PATCH /api/housing/obligations/:id
// returned 500 on EVERY amount save ("could not determine data type of
// parameter $n" for an untyped `$n IS NULL`), which no mock pool can see.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Rent & Utilities ledger + Settle Up on real Postgres", { skip: SKIP }, () => {
  let pool, app, housing, cm;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("housing");
    housing = require("../../teller/routes/housing");
    cm = require("../../teller/services/financial-queries").currentMonth();
    app = perfinApp();
  });
  after(async () => { if (pool) await pool.end(); });

  it("config PATCH + generation: trailing 24 months, idempotent", async () => {
    const start = housing.addMonths(cm, -30);
    await q("UPDATE user_settings SET housing_config = $1 WHERE id = 1", [JSON.stringify({ start_month: start })]);
    const r = await supertest(app).patch("/api/housing/config").send({
      enabled: true, payee_name: "Sam", rent_amount: 1000, rent_due_day: 1,
      utilities: [{ label: "Electric", cadence_months: 1, due_day: 15, merchant_patterns: "PG&E, Pacific Gas" }],
      split: { enabled: true, car_fixed_amount: 400 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const g1 = (await supertest(app).post("/api/housing/generate").expect(200)).body;
    assert.ok(g1.generated >= 1);
    const g2 = (await supertest(app).post("/api/housing/generate").expect(200)).body;
    assert.equal(g2.generated, 0, "second run adds nothing");
    const rent = (await q("SELECT period FROM payee_obligations WHERE category='rent' ORDER BY period")).rows.map((x) => x.period);
    assert.ok(rent.length <= 24 && rent[rent.length - 1] === cm);
  });

  it("FAN-1: setting a utility's amount flips it to unpaid; clearing it reverts (no 500)", async () => {
    const util = (await q("SELECT id FROM payee_obligations WHERE category='utility' AND period=$1", [cm])).rows[0];
    assert.ok(util, "this month's utility placeholder exists");
    const set = await supertest(app).patch("/api/housing/obligations/" + util.id).send({ amount: 84.5 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.status, "unpaid");
    assert.equal(parseFloat(set.body.amount), 84.5);
    const clear = await supertest(app).patch("/api/housing/obligations/" + util.id).send({ amount: null });
    assert.equal(clear.status, 200);
    assert.equal(clear.body.status, "pending_amount");
    await supertest(app).patch("/api/housing/obligations/" + util.id).send({ amount: 84.5 }).expect(200);
    await supertest(app).patch("/api/housing/obligations/" + util.id).send({ amount: -1 }).expect(400);
  });

  it("payments settle a batch with a derived memo; undo reverts; the ledger balance follows", async () => {
    const before = (await supertest(app).get("/api/housing/ledger").expect(200)).body;
    const ids = (await q("SELECT id FROM payee_obligations WHERE period=$1 AND status='unpaid' ORDER BY id", [cm])).rows.map((x) => x.id);
    assert.equal(ids.length, 2, "this month's rent + electric");
    const pay = (await supertest(app).post("/api/housing/payments").send({ obligation_ids: ids }).expect(200)).body;
    assert.equal(parseFloat(pay.payment.amount), 1084.5);
    assert.match(pay.payment.memo, /Rent/);
    const after1 = (await supertest(app).get("/api/housing/ledger").expect(200)).body;
    assert.equal(after1.balance, Math.round((before.balance - 1084.5) * 100) / 100);
    assert.ok(after1.payments[0].covers.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(after1.payments[0].paid_date));
    const exp = (await supertest(app).get("/api/housing/export?format=json&year=" + pay.payment.paid_date.slice(0, 4)).expect(200)).body;
    assert.equal(exp.payments.length, 1);
    const csv = await supertest(app).get("/api/housing/export?format=csv&year=" + pay.payment.paid_date.slice(0, 4)).expect(200);
    assert.ok(!/GMT/.test(csv.text), "ISO dates in the landlord CSV");
    await supertest(app).delete("/api/housing/payments/" + pay.payment.id).expect(200);
    const after2 = (await supertest(app).get("/api/housing/ledger").expect(200)).body;
    assert.equal(after2.balance, before.balance);
    await supertest(app).post("/api/housing/payments").send({ obligation_ids: [999999] }).expect(400);
  });

  it("split + shared-card settlement + settle/undo for the same month", async () => {
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('g','B','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, is_shared, spending_split_pct) VALUES ($1,'card','Joint','credit','credit card',true,50)", [item]);
    const d = cm + "-01";
    const ins = (id, amt, m, extra = {}) => q(
      "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, personal_for) VALUES ('card',$1,$2,$3,$4,$4,$5,$6)",
      [id, amt, d, m, !!extra.pending, extra.pf || null]);
    await ins("t1", 85, "PG&E WEB ONLINE");
    await ins("t2", 40, "SHELL GAS 1234");
    await ins("t3", 200, "BEST BUY"); await ins("t4", -200, "BEST BUY");
    await ins("t5", -500, "PAYMENT THANK YOU");
    await ins("t6", 60, "PENDING HOLD", { pending: true });
    await ins("t7", 30, "MY THING", { pf: "self" });

    const sp = (await supertest(app).get("/api/housing/split?month=" + cm).expect(200)).body;
    assert.equal(sp.enabled, true);
    assert.deepEqual(sp.double_count_warning.sample.map((s) => s.merchant), ["PG&E WEB ONLINE"], "merchant_patterns match, SHELL GAS doesn't");

    const ss = (await supertest(app).get("/api/shared-settlement?month=" + cm).expect(200)).body.accounts[0];
    assert.equal(ss.refunds_total, 200);
    assert.equal(ss.account_key, "card");
    assert.equal(ss.partner_share, (85 + 40 + 200 - 200) / 2, "refund netted, payment + pending excluded, personal_for=self not shared");
    const list = (await supertest(app).get(`/api/shared-settlement/${ss.account_id}/transactions?month=${cm}`).expect(200)).body.transactions
      .map((t) => t.transaction_id).sort();
    assert.deepEqual(list, ["t1", "t2", "t3", "t4", "t7"]);

    await supertest(app).patch("/api/transactions/t2").send({ personal_for: "partner" }).expect(200);
    const ss2 = (await supertest(app).get("/api/shared-settlement?month=" + cm).expect(200)).body.accounts[0];
    assert.equal(ss2.partner_share, 85 / 2 + 40);

    assert.equal((await supertest(app).get("/api/settlement?month=" + cm).expect(200)).body.settled, false);
    await supertest(app).post("/api/settlement/settle").send({ month: cm, net_amount: 12.5, direction: "partner_sends_you" }).expect(200);
    const st = (await supertest(app).get("/api/settlement?month=" + cm).expect(200)).body;
    assert.equal(st.settled, true); assert.equal(st.net_amount, 12.5);
    await supertest(app).delete("/api/settlement/" + cm).expect(200);
    assert.equal((await supertest(app).get("/api/settlement?month=" + cm).expect(200)).body.settled, false);
  });
});
