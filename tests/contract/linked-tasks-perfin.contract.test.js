// Real-Postgres contract test for roadmap T2.4 X2a — Perfin's linked-task
// computation (services/linked-tasks.js computeLinkedTasks) over real rows,
// with the ledger's own routes where they write the state that matters:
//  - rent & utilities: one task per unpaid period of the configured payee with
//    a known amount (a paid period, another payee's row and a pending amount
//    left out), overdue as urgent; next month's rent inside its window until
//    the user removes it (DELETE /api/housing/obligations → the skip) …
//  - utility amounts: a pending_amount row whose bill should have arrived, and
//    not once its amount is entered (PATCH /api/housing/obligations/:id)
//  - manual bills (POST /api/manual-bills): a 31st bill on the 30th, then gone
//    once marked paid (POST /api/bill-payments); the settings PATCH's merge of
//    linked_tasks_sources and its 400
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Linked tasks — Perfin's computation (T2.4 X2a) on real Postgres", { skip: SKIP }, () => {
  let pool, app, lt;
  const q = (s, p) => pool.query(s, p);
  // The tax_documents source (T3.3 K2) is judged in tests/contract/tax-documents.
  const ALL = { sources: { housing: true, utility_amount: true, bills: true, tax_documents: false }, bill_lead_days: 3 };
  const keys = (r) => r.desired.map((d) => d.key).sort();
  const ob = async (payee, period, category, label, amount, status, due_day = 1, auto = false) => (await q(
    `INSERT INTO payee_obligations (payee, period, category, label, amount, status, due_day, auto_generated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [payee, period, category, label, amount, status, due_day, auto])).rows[0].id;

  before(async () => {
    pool = await perfinDb("linked_tasks_perfin");
    app = perfinApp();
    lt = require("../../teller/services/linked-tasks");
    await q("UPDATE user_settings SET housing_config = $1 WHERE id = 1", [JSON.stringify({
      enabled: true, payee_name: "Sam Lee", rent_amount: 1800, rent_due_day: 1, reminder_lead_days: 5, start_month: "2026-09",
      utilities: [{ label: "Electricity", cadence_months: 1, due_day: 20, anchor: "2026-09" }],
    })]);
  });
  after(async () => { if (pool) await pool.end(); });

  it("settings: the defaults, a sources merge, a 400 that writes nothing", async () => {
    let s = (await q("SELECT linked_tasks_enabled, linked_tasks_sources, linked_tasks_bill_lead_days FROM user_settings WHERE id = 1")).rows[0];
    assert.deepEqual(s, { linked_tasks_enabled: false, linked_tasks_sources: { still_charging: true, housing: true, utility_amount: true, bills: false }, linked_tasks_bill_lead_days: 3 });
    await supertest(app).patch("/api/settings").send({ linked_tasks_sources: { bills: true }, linked_tasks_bill_lead_days: 5 }).expect(200);
    await supertest(app).patch("/api/settings").send({ linked_tasks_sources: { rent: true } }).expect(400);
    s = (await q("SELECT linked_tasks_sources, linked_tasks_bill_lead_days FROM user_settings WHERE id = 1")).rows[0];
    assert.deepEqual(s.linked_tasks_sources, { still_charging: true, housing: true, utility_amount: true, bills: true });
    assert.equal(s.linked_tasks_bill_lead_days, 5);
  });

  it("rent & utilities: the payee's unpaid periods with known amounts, next month's rent until it is removed", async () => {
    await ob("Sam Lee", "2026-09", "rent", "Rent", 1800, "paid");
    await ob("Sam Lee", "2026-10", "rent", "Rent", 1800, "unpaid");
    await ob("Old Landlord", "2026-10", "rent", "Rent", 1500, "unpaid");
    await ob("Sam Lee", "2026-11", "rent", "Rent", 1800, "unpaid", 1, true);
    await ob("Sam Lee", "2026-11", "utility", "Gas", 40, "unpaid", 15);
    const elec = await ob("Sam Lee", "2026-11", "utility", "Electricity", null, "pending_amount", 20, true);
    await ob("Sam Lee", "2026-11", "utility", "Water", null, "pending_amount", 29);
    let r = await lt.computeLinkedTasks(pool, ALL, "2026-11-28");
    assert.deepEqual(r.errors, []);
    assert.deepEqual(keys(r).filter((k) => !k.includes(":bill:")),
      ["perfin:housing:2026-10", "perfin:housing:2026-11", "perfin:housing:2026-12", `perfin:utility-amount:${elec}`]);
    const t = Object.fromEntries(r.desired.map((d) => [d.key, d]));
    assert.match(t["perfin:housing:2026-10"].description, /^\$1,800\.00 owed: Rent \$1,800\.00\./, "another payee's row isn't counted");
    assert.equal(t["perfin:housing:2026-10"].priority, "urgent");
    assert.equal(t["perfin:housing:2026-11"].description, "$1,840.00 owed: Rent $1,800.00, Gas $40.00. Record the payment on Perfin's Rent page.");
    assert.equal(t[`perfin:utility-amount:${elec}`].due_date, "2026-11-20");

    // the amount entered → no utility-amount task; it joins the period's total
    await supertest(app).patch(`/api/housing/obligations/${elec}`).send({ amount: 95.5 }).expect(200);
    // next month's rent removed by hand (an auto-generated row → skip)
    const dec = await ob("Sam Lee", "2026-12", "rent", "Rent", 1800, "unpaid", 1, true);
    await supertest(app).delete(`/api/housing/obligations/${dec}`).expect(200);
    r = await lt.computeLinkedTasks(pool, ALL, "2026-11-28");
    assert.deepEqual(keys(r).filter((k) => !k.includes(":bill:")), ["perfin:housing:2026-10", "perfin:housing:2026-11"]);
    assert.match(r.desired.find((d) => d.key === "perfin:housing:2026-11").description, /^\$1,935\.50 owed:/);
  });

  it("manual bills: a 31st bill on the 30th until it is marked paid", async () => {
    const bill = (await supertest(app).post("/api/manual-bills").send({ name: "Insurance", amount: 120, due_day: 31, cadence: "monthly", category: "insurance" }).expect(200)).body;
    const id = bill.id || (bill.bill && bill.bill.id);
    await q("UPDATE manual_bills SET created_at = '2026-08-15' WHERE id = $1", [id]);
    // a SUBSCRIPTION payment with the same id and date isn't this bill's payment
    await q("INSERT INTO bill_payments (bill_source, bill_id, paid_date) VALUES ('subscription', $1, '2026-09-30')", [id]);
    let r = await lt.computeLinkedTasks(pool, { ...ALL, bill_lead_days: 3 }, "2026-10-02");
    assert.ok(keys(r).includes(`perfin:bill:${id}:2026-09-30`));
    await supertest(app).post("/api/bill-payments").send({ bill_source: "manual", bill_id: id, paid_date: "2026-09-30" }).expect(200);
    r = await lt.computeLinkedTasks(pool, { ...ALL, bill_lead_days: 3 }, "2026-10-02");
    assert.ok(!keys(r).some((k) => k.startsWith(`perfin:bill:${id}:`)), "paid → no task");
    assert.deepEqual(r.ok_kinds.sort(), ["bill", "housing", "utility-amount"]);
  });
});
