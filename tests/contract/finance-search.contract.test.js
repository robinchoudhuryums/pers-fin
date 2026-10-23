// Real-Postgres contract test for roadmap T2.4 X3a — Per-sistant's search
// finding Perfin's records, with both apps' real databases wired the way the
// shell wires them (Per-sistant's app.set("perfinPool")):
//  - a seeded transaction on a 50% shared card found by merchant, by its note
//    and by category, at the user's share, linking to Activity with its month
//  - an active subscription, a manual bill, a goal and an account found; a
//    cancelled subscription and the Plaid brokerage phantom not
//  - a "%" query matched literally ("100%" finds "100% Juice", not "1000 Juice")
//  - without perfinPool (standalone) no finance results
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, persistentApp } = require("./_setup");

describe("Unified search — finance results (T2.4 X3a) on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, app, standalone;
  const pf = (s, p) => pfPool.query(s, p);
  const search = async (q, a = app) => (await supertest(a).get("/api/search").query({ q }).expect(200)).body;
  const finance = (r) => r.filter((x) => x.group === "finance");

  before(async () => {
    psPool = await persistentDb("finance_search");
    pfPool = await perfinDb("finance_search");
    standalone = persistentApp(psPool);
    app = persistentApp(psPool);
    app.set("perfinPool", pfPool);
    await pf(`INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, is_shared, spending_split_pct)
      VALUES ('joint', 'Joint Card', 'credit', 'credit card', true, true, 50)`);
    await pf(`INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, user_notes, user_category)
      VALUES ('joint', 'bb1', 12.00, '2026-10-12', 'Blue Bottle', 'BLUE BOTTLE #12', false, 'latte with Sam', 'Dining'),
             ('joint', 'pj1', 5.00, '2026-10-01', '100% Juice', '100% JUICE', false, NULL, NULL),
             ('joint', 'pj2', 6.00, '2026-10-02', '1000 Juice', '1000 JUICE', false, NULL, NULL)`);
    await pf(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, cancelled_at)
      VALUES ('Spotify', 'Spotify', 11.99, 30, '2026-01-01', '2026-10-05', '2026-11-05', true, NULL),
             ('Spotty Gym', 'Spotty Gym', 40, 30, '2026-01-01', '2026-09-05', '2026-10-05', false, now())`);
    await pf("INSERT INTO manual_bills (name, amount, due_day, cadence, category) VALUES ('Spotless Cleaners', 80, 15, 'monthly', 'home')");
    await pf("INSERT INTO financial_goals (name, target_amount, target_date) VALUES ('Spotted Owl Trip', 3000, '2027-05-01')");
    await pf("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id, is_active) VALUES ('Spot Brokerage', 'Schwab', 'brokerage', 5000, 'brk', true)");
    await pf("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('brk', 'Spot Brokerage', 'investment', 'brokerage', true)");
  });
  after(async () => {
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  it("a transaction is found by merchant, note and category, at the user's share", async () => {
    for (const q of ["blue bot", "latte", "dining"]) {
      const hits = finance(await search(q)).filter((x) => x.type === "transaction");
      assert.equal(hits.length, 1, q);
      assert.deepEqual([hits[0].id, hits[0].title, hits[0].url], ["bb1", "Blue Bottle", "/transactions?q=Blue%20Bottle&month=2026-10"]);
      assert.equal(hits[0].description, "$6.00 · your share of $12.00 · 2026-10-12 · Dining");
    }
  });

  it("an active subscription, a bill, a goal and accounts are found; a cancelled one and the phantom aren't", async () => {
    const hits = finance(await search("spot"));
    assert.deepEqual(hits.map((x) => [x.type, x.title]), [
      ["subscription", "Spotify"],
      ["bill", "Spotless Cleaners"],
      ["goal", "Spotted Owl Trip"],
      ["account", "Spot Brokerage"],
    ]);
    assert.equal(hits[3].url, `/accounts/${(await pf("SELECT id FROM investment_accounts")).rows[0].id}/history?source=investment`);
  });

  it("a % in the query is matched literally", async () => {
    assert.deepEqual(finance(await search("100%")).map((x) => x.id), ["pj1"]);
    assert.deepEqual(finance(await search("juice")).map((x) => x.id).sort(), ["pj1", "pj2"]);
  });

  it("standalone (no perfinPool): no finance results", async () => {
    assert.deepEqual(finance(await search("blue bot", standalone)), []);
  });
});
