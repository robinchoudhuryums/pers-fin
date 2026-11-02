// Real-Postgres contract test for seams audit #4 batch S4-3 — the parts whose
// meaning is the SQL itself:
//  S1 — the forecast's merchant key is TRIMmed like the detectors', so a
//       subscription whose bank name ends in a space is billed and kept out of
//       the spending average (it used to be both);
//  S6 — the low cash alert skips while ANY bank-synced spendable account's
//       balance is over 36 h old (it read the newest one only);
//  S5 — GET /api/deleted-transactions' per-row `restorable` follows the restore
//       route's refusals (bank-removed, account gone), with the reason.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Seams audit #4 S4-3 on real Postgres", { skip: SKIP }, () => {
  let pool, app, add;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("s4_3");
    app = perfinApp();
    const today = require("../../teller/services/financial-queries").todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
  });
  after(async () => { if (pool) await pool.end(); });

  it("S1: a subscription whose merchant name ends in a space is billed and left out of the average", async () => {
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance) VALUES ('s1chk','S1 Checking','depository','checking',true,3000)");
    const txn = (id, amount, date, merchant) => q(
      "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('s1chk',$1,$2,$3,$4,$4,false)",
      [id, amount, date, merchant]);
    for (const [i, d] of [95, 65, 35, 5].entries()) await txn("hulu" + i, 17.99, add(-d), "HULU ");
    await txn("grocer", 60, add(-10), "Corner Grocer");
    await require("../../scripts/detect-subscriptions").detectSubscriptions(pool);
    const sub = (await q("SELECT id, merchant_key FROM detected_subscriptions WHERE is_active AND merchant_key ILIKE 'hulu%'")).rows;
    assert.equal(sub.length, 1);
    assert.equal(sub[0].merchant_key, "HULU", "the detector trims the key");

    const inputs = await require("../../teller/services/cash-flow").getCashFlowInputs(pool);
    assert.equal(inputs.avgDailySpend, 60, "only the grocer day is discretionary spending");
    const flow = (await supertest(app).get("/api/cash-flow?days=60").expect(200)).body;
    assert.ok(flow.forecast_items.bills.some((b) => b.source === "subscription" && b.id === sub[0].id), JSON.stringify(flow.forecast_items));
  });

  it("S6: one bank-synced account's 3-day-old balance skips the alert though another is fresh", async () => {
    const ca = require("../../teller/services/cash-alerts");
    ca._reset();
    await q("UPDATE linked_accounts SET current_balance = NULL WHERE account_id = 's1chk'"); // not part of this case
    await q("UPDATE linked_accounts SET type = 'other' WHERE account_id = 's1chk'");
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('s6_item','S6 Bank', pgp_sym_encrypt('tok','x'), 'GOOD')");
    const item = (await q("SELECT id FROM plaid_items WHERE item_id = 's6_item'")).rows[0].id;
    const acct = (id, hours) => q(
      `INSERT INTO linked_accounts (account_id, name, type, subtype, plaid_item_id, current_balance, balance_updated_at)
       VALUES ($1,$1,'depository','checking',$2,2000, now() - ($3 || ' hours')::interval)`, [id, item, String(hours)]);
    await acct("s6_fresh", 1);
    await acct("s6_old", 72);
    // A manual cash account nobody syncs doesn't count, however old.
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance, balance_updated_at) VALUES ('s6_cash','Cash','depository','checking',true,50, now() - interval '30 days')");
    await q("UPDATE user_settings SET cash_alert_enabled = true, cash_alerts_checked_at = NULL, cash_alert_state = NULL WHERE id = 1");

    const sent = [];
    let forecasts = 0;
    const deps = {
      forecast: async () => { forecasts++; return { projection: [{ date: add(1), balance: 100 }], lowest: { date: add(1), balance: 100 } }; },
      sendToAll: async (p) => { sent.push(p); return { sent: 1, failed: 0, logged: true }; },
      sendEmail: async () => ({ sent: false }),
      sentRecently: async () => false,
    };
    const r = await ca.runCashAlerts(pool, { deps });
    assert.deepEqual([r.status, r.reason], ["skipped", "stale_balances"]);
    assert.equal(forecasts, 0);
    assert.equal(sent.length, 0);

    // The old one syncs → evaluated (and the $100 projection notifies).
    await q("UPDATE linked_accounts SET balance_updated_at = now() WHERE account_id = 's6_old'");
    ca._reset();
    await q("UPDATE user_settings SET cash_alerts_checked_at = NULL WHERE id = 1");
    const r2 = await ca.runCashAlerts(pool, { deps });
    assert.equal(r2.status, "notified");
    assert.equal(forecasts, 1);

    // A synced account whose balance was never stamped is unknown → skipped.
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, plaid_item_id, current_balance)
             VALUES ('s6_unknown','Unknown','depository','savings',$1,10)`, [item]);
    ca._reset();
    await q("UPDATE user_settings SET cash_alerts_checked_at = NULL WHERE id = 1");
    assert.equal((await ca.runCashAlerts(pool, { deps })).status, "skipped");
    await q("UPDATE user_settings SET cash_alert_enabled = false WHERE id = 1");
  });

  it("S5: each row's restorable matches what restore would do, with the reason", async () => {
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('s5chk','S5 Checking','depository','checking',true)");
    const snap = (id, account) => JSON.stringify({ row: { account_id: account, transaction_id: id, amount: 5, date: "2026-10-01", merchant_name: "Cafe", name: "CAFE", pending: false }, splits: [] });
    await q("INSERT INTO deleted_transactions (transaction_id, snapshot, source) VALUES ('s5_ok',$1::jsonb,'plaid')", [snap("s5_ok", "s5chk")]);
    await q("INSERT INTO deleted_transactions (transaction_id, snapshot, source, bank_removed_at) VALUES ('s5_removed',$1::jsonb,'plaid', now())", [snap("s5_removed", "s5chk")]);
    await q("INSERT INTO deleted_transactions (transaction_id, snapshot, source) VALUES ('s5_gone',$1::jsonb,'teller')", [snap("s5_gone", "nowhere")]);

    const items = Object.fromEntries((await supertest(app).get("/api/deleted-transactions?limit=200").expect(200)).body.items
      .map((i) => [i.transaction_id, i]));
    assert.deepEqual([items.s5_ok.restorable, items.s5_ok.unrestorable_reason], [true, null]);
    assert.deepEqual([items.s5_removed.restorable, items.s5_removed.unrestorable_reason], [false, "removed_by_bank"]);
    assert.deepEqual([items.s5_gone.restorable, items.s5_gone.unrestorable_reason], [false, "account_gone"]);

    // The route agrees: the two refused, the other restored.
    await supertest(app).post("/api/deleted-transactions/s5_removed/restore").expect(409);
    await supertest(app).post("/api/deleted-transactions/s5_gone/restore").expect(409);
    await supertest(app).post("/api/deleted-transactions/s5_ok/restore").expect(200);
  });
});
