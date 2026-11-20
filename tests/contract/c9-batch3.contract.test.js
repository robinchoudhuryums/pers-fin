// Real-Postgres contract test for the cycle-9 broad scan, Batch 3 — forecast
// and detection accuracy:
//  - F20: a brokerage contribution detected as BOTH a subscription and a
//    recurring transfer is billed once by the forecast (the legacy subscription
//    row is retired, its notes kept); dismissing the transfer makes it a
//    subscription again — still billed once
//  - F21: a merchant key that carries two plans never raises a "went up" alert,
//    through either rule; a real rise still alerts
//  - F22: Utility → Subscription survives the next detection run
//  - F23: a manual subscription whose next date passed is moved on when the
//    list is read
//  - F24: an exact rename rule and an exact categorization rule match a bank
//    name with a trailing space
//  - F28: a paycheck expected today is carried to tomorrow until it lands
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("cycle-9 Batch 3 on real Postgres", { skip: SKIP }, () => {
  let pool, app, subs, detect, transfers, rename, cf, add, today;
  const q = (s, p) => pool.query(s, p);
  const tx = (id, amt, merchant, date, name = merchant) => q(
    "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('chk',$1,$2,$3,$4,$5,false)",
    [id, amt, date, merchant, name]);
  const monthly = async (prefix, amt, merchant, agos) => { for (const n of agos) await tx(prefix + n, amt, merchant, add(-n)); };
  const quiet = async (fn) => {
    const e = console.error, l = console.log;
    console.error = () => {}; console.log = () => {};
    try { return await fn(); } finally { console.error = e; console.log = l; }
  };
  const detectAll = () => quiet(async () => { await subs.runSubscriptionDetection(); await transfers.detectRecurringTransfers(pool); });
  const wentUp = async (name) => (await q("SELECT title FROM notification_log WHERE title LIKE $1", [name + " went up%"])).rows.map((r) => r.title);

  before(async () => {
    pool = await perfinDb("c9_batch3");
    const fq = require("../../teller/services/financial-queries");
    today = fq.todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
    subs = require("../../teller/routes/subscriptions");
    detect = require("../../scripts/detect-subscriptions");
    transfers = require("../../scripts/detect-transfers");
    rename = require("../../teller/routes/merchant-rename");
    cf = require("../../teller/services/cash-flow");
    app = perfinApp();
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance, available_balance, balance_updated_at) VALUES ('chk','Checking','depository','checking',true,5000,5000,now())");
  });
  after(async () => { if (pool) await pool.end(); });

  // ---------------------------------------------------------------- F20
  it("F20: a brokerage contribution is billed once — as a transfer; its legacy subscription row is retired", async () => {
    await monthly("vg", 500, "VANGUARD", [95, 65, 35, 5]);
    await monthly("nf", 15.49, "NETFLIX.COM", [93, 63, 33, 3]);
    // What both detectors left behind before they shared one classifier.
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, notes)
             VALUES ('VANGUARD','VANGUARD',500,30,$1,$2,$3,true,'ira')`, [add(-95), add(-5), add(25)]);
    await detectAll();

    const sub = (await q("SELECT is_active, notes FROM detected_subscriptions WHERE merchant_key = 'VANGUARD'")).rows;
    assert.deepEqual(sub, [{ is_active: false, notes: "ira" }], "retired, user state kept");
    const tr = (await q("SELECT is_active, transfer_type, direction FROM recurring_transfers WHERE merchant_key = 'VANGUARD'")).rows;
    assert.deepEqual(tr, [{ is_active: true, transfer_type: "investment", direction: "outgoing" }]);
    assert.equal((await q("SELECT count(*)::int AS n FROM detected_subscriptions WHERE merchant_key = 'NETFLIX.COM' AND is_active")).rows[0].n, 1);

    const inputs = await cf.getCashFlowInputs(pool, { today });
    const vanguard = inputs.bills.filter((b) => b.display_name === "VANGUARD");
    assert.deepEqual(vanguard.map((b) => b.source), ["transfer"], "billed once");
    assert.deepEqual(inputs.bills.filter((b) => b.display_name === "NETFLIX.COM").map((b) => b.source), ["subscription"]);
  });

  it("F20: dismissing the transfer makes the series a subscription again — still billed once", async () => {
    const id = (await q("SELECT id FROM recurring_transfers WHERE merchant_key = 'VANGUARD'")).rows[0].id;
    await supertest(app).patch(`/api/recurring-transfers/${id}/dismiss`).set("X-Requested-With", "XMLHttpRequest").expect(200);
    await detectAll();
    assert.equal((await q("SELECT is_active FROM detected_subscriptions WHERE merchant_key = 'VANGUARD'")).rows[0].is_active, true);
    const inputs = await cf.getCashFlowInputs(pool, { today });
    assert.deepEqual(inputs.bills.filter((b) => b.display_name === "VANGUARD").map((b) => b.source), ["subscription"]);
  });

  // ---------------------------------------------------------------- F21
  it("F21: two plans under one merchant key never read as a price rise", async () => {
    // iCloud 0.99 around the 20th-ago mark, Music 10.99 around the 5th-ago mark.
    await monthly("ap_a", 0.99, "APPLE.COM/BILL", [110, 80, 50, 20]);
    await monthly("ap_b", 10.99, "APPLE.COM/BILL", [95, 65, 35]);
    await detectAll(); // anchors on 0.99 (the latest charge)
    assert.equal(Number((await q("SELECT amount FROM detected_subscriptions WHERE merchant_key = 'APPLE.COM/BILL'")).rows[0].amount), 0.99);
    await tx("ap_b5", 10.99, "APPLE.COM/BILL", add(-5));
    await detectAll(); // re-anchors on 10.99 — a flip, not a rise
    const row = (await q("SELECT amount, amount_changed FROM detected_subscriptions WHERE merchant_key = 'APPLE.COM/BILL'")).rows[0];
    assert.equal(Number(row.amount), 10.99);
    assert.equal(row.amount_changed, false);
    assert.deepEqual(await wentUp("APPLE.COM/BILL"), []);
  });

  it("F21: the early rule ignores an amount that was already being charged; a new higher amount still alerts once", async () => {
    // GOOGLE: a 9.99 plan (the stored series) and an 11.99 plan billed alongside for months.
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active)
             VALUES ('GOOGLE STORAGE','GOOGLE STORAGE',9.99,30,$1,$2,$3,true)`, [add(-130), add(-10), add(20)]);
    await monthly("go_a", 9.99, "GOOGLE STORAGE", [100, 70, 40, 10]);
    await monthly("go_b", 11.99, "GOOGLE STORAGE", [95, 65, 35, 5]);
    // PARAMOUNT: 5.99, then one charge at 7.99 — never seen before.
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active)
             VALUES ('PARAMOUNT','PARAMOUNT',5.99,30,$1,$2,$3,true)`, [add(-122), add(-32), add(-2)]);
    await monthly("pm", 5.99, "PARAMOUNT", [92, 62, 32]);
    await tx("pm_new", 7.99, "PARAMOUNT", add(-2));
    await quiet(() => subs.runSubscriptionWatchdog(pool));
    assert.deepEqual(await wentUp("GOOGLE STORAGE"), []);
    assert.deepEqual(await wentUp("PARAMOUNT"), ["PARAMOUNT went up from $5.99 to $7.99"]);
    const mem = (await q("SELECT price_alerted_amount, early_price_alerted_amount FROM detected_subscriptions WHERE merchant_key = 'PARAMOUNT'")).rows[0];
    assert.equal(mem.price_alerted_amount, null);
    assert.equal(Number(mem.early_price_alerted_amount), 7.99);
    await quiet(() => subs.runSubscriptionWatchdog(pool));
    assert.equal((await wentUp("PARAMOUNT")).length, 1, "once per price");
  });

  it("F21: when detection re-anchors on a price the early rule announced, the rise rule stays quiet", async () => {
    // What detection writes once the new price forms its own cluster.
    await q("UPDATE detected_subscriptions SET amount = 7.99, prior_amount = 5.99, amount_changed = true, last_charged = $1 WHERE merchant_key = 'PARAMOUNT'", [add(-2)]);
    await quiet(() => subs.runSubscriptionWatchdog(pool));
    assert.equal((await wentUp("PARAMOUNT")).length, 1);
  });

  // ---------------------------------------------------------------- F22
  it("F22: Utility → Subscription is kept by the next detection run", async () => {
    await monthly("pge", 120, "Pacific Gas and Electric", [94, 64, 34, 4]);
    await detectAll();
    const before = (await q("SELECT id, category, category_user_set FROM detected_subscriptions WHERE merchant_key = 'Pacific Gas and Electric'")).rows[0];
    assert.equal(before.category, "utility");
    assert.equal(before.category_user_set, false);
    const res = await supertest(app).patch(`/api/subscriptions/${before.id}/category`).set("X-Requested-With", "XMLHttpRequest").send({ category: "subscription" }).expect(200);
    assert.equal(res.body.category_user_set, true);
    await detectAll();
    const after = (await q("SELECT category FROM detected_subscriptions WHERE id = $1", [before.id])).rows[0];
    assert.equal(after.category, "subscription", "it used to flip back to utility");
  });

  // ---------------------------------------------------------------- F23
  it("F23: a manual subscription's passed next date moves on when the list is read", async () => {
    const made = await supertest(app).post("/api/subscriptions").set("X-Requested-With", "XMLHttpRequest")
      .send({ name: "Gym Membership", amount: 40, cadence_days: 30 }).expect(200);
    // Added 100 days ago; its stored next date is the first one ever computed.
    await q("UPDATE detected_subscriptions SET first_seen = $2, last_charged = $2, next_expected = $3 WHERE id = $1", [made.body.id, add(-100), add(-70)]);
    const list = await supertest(app).get("/api/subscriptions").expect(200);
    const gym = list.body.subscriptions.find((s) => s.id === made.body.id);
    const next = String(gym.next_expected).slice(0, 10);
    const stored = (await q("SELECT next_expected::text AS d, last_charged::text AS a FROM detected_subscriptions WHERE id = $1", [made.body.id])).rows[0];
    assert.ok(stored.d >= today, `next date ${stored.d} is not in the past`);
    assert.ok(stored.d <= add(31), "and is the next one, not a later one");
    const addedDay = add(-100).slice(8);
    if (addedDay <= "28") assert.equal(stored.d.slice(8), addedDay, "on the day of the month it was added");
    assert.equal(stored.a, add(-100), "the anchor is untouched");
    assert.ok(next, "the list carries the new date");
  });

  // ---------------------------------------------------------------- F24
  it("F24: exact rules match a bank name that ends in a space", async () => {
    await tx("hu1", 17.99, "HULU ", add(-40));
    await tx("hu2", 17.99, "HULU ", add(-10));
    const out = await quiet(() => rename.createRenameRule({ pattern: "HULU ", matchType: "exact", renameTo: "Hulu" }));
    assert.ok(!out.error, out.error);
    assert.equal(out.rule.merchant_pattern, "HULU", "stored trimmed");
    const renamed = (await q("SELECT user_merchant_name FROM transactions WHERE transaction_id IN ('hu1','hu2')")).rows.map((r) => r.user_merchant_name);
    assert.deepEqual(renamed, ["Hulu", "Hulu"], "the rule used to match nothing");

    await tx("pz1", 22.5, "TONYS PIZZA ", add(-6));
    await supertest(app).post("/api/categorization-rules").set("X-Requested-With", "XMLHttpRequest")
      .send({ merchant_pattern: "TONYS PIZZA ", category: "Food & Drink", match_type: "exact" }).expect(200);
    const applied = await supertest(app).post("/api/categorization-rules/apply").set("X-Requested-With", "XMLHttpRequest").send({}).expect(200);
    assert.ok(applied.body.applied >= 1);
    assert.equal((await q("SELECT user_category FROM transactions WHERE transaction_id = 'pz1'")).rows[0].user_category, "Food & Drink");
  });

  // ---------------------------------------------------------------- F28
  it("F28: a paycheck expected today is carried to tomorrow until it lands", async () => {
    for (const n of [56, 42, 28, 14]) await tx("pay" + n, -2000, "ACME PAYROLL", add(-n));
    const before = await cf.getCashFlowForecast(pool, { days: 30, today });
    assert.deepEqual(before.carried_income.map((c) => [c.source, c.amount, c.expected_date, c.projected_date]), [["ACME PAYROLL", 2000, today, add(1)]]);
    assert.equal(before.projection[0].income, 2000);

    await tx("pay0", -2000, "ACME PAYROLL", today);
    const landed = await cf.getCashFlowForecast(pool, { days: 30, today });
    assert.deepEqual(landed.carried_income, []);
    assert.equal(landed.projection[0].income, 0);
    assert.equal(landed.total_projected_income, before.total_projected_income - 2000, "today's paycheck is in the balance now, not the projection");

    const res = await supertest(app).get("/api/cash-flow?days=30").expect(200);
    assert.deepEqual(res.body.carried_income, []);
  });
});
