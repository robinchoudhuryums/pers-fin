// Real-Postgres contract tests for the cycle-7 Batch 6 delete-integrity and
// feed fixes: a deleted transaction stays deleted through a Teller reconcile
// and a Plaid re-delivery (F20), CSV-overlap pairs one-to-one on similar
// merchants (F21), the ICS feed's real month clamp + RFC 5545 folding
// (F45/F59), Undismiss re-activates (F56) and the F57 validation / literal
// search. Only Teller's HTTP client and a Plaid client object are stubbed.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("delete integrity + feeds on real Postgres", { skip: SKIP }, () => {
  let pool, app, enrollments, investments, subs, fq, today, cm;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  let tellerTxns = [];

  before(async () => {
    pool = await perfinDb("delfeeds");
    fq = require("../../teller/services/financial-queries");
    today = fq.todayStr(); cm = fq.currentMonth();
    const tellerApi = require("../../teller/services/teller-api");
    tellerApi.tellerRequest = async (endpoint) => {
      if (endpoint === "/accounts") return [{ id: "tchk", name: "Checking", type: "depository", subtype: "checking", last_four: "1111" }];
      if (endpoint.endsWith("/balances")) return { account_id: "tchk", ledger: "100.00", available: "100.00" };
      if (endpoint.includes("/transactions")) return endpoint.includes("from_id") ? [] : tellerTxns;
      return {};
    };
    enrollments = require("../../teller/routes/enrollments");
    investments = require("../../teller/routes/investments");
    subs = require("../../teller/routes/subscriptions");
    app = perfinApp();
    await q("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status) VALUES ('e1','Bank', pgp_sym_encrypt('tok', $1), 'GOOD')", [PASS()]);
    const enr = (await q("SELECT id FROM teller_enrollments")).rows[0].id;
    await q("INSERT INTO linked_accounts (teller_enrollment_id, account_id, name, type, subtype) VALUES ($1,'tchk','Checking','depository','checking')", [enr]);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('pi1','Card', pgp_sym_encrypt('ptok', $1), 'GOOD')", [PASS()]);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('csv1','Chase', 'x', 'CSV')");
    const pItem = (await q("SELECT id FROM plaid_items WHERE item_id='pi1'")).rows[0].id;
    const cItem = (await q("SELECT id FROM plaid_items WHERE item_id='csv1'")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'pcard','Card','credit','credit card')", [pItem]);
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'csvcard','Chase Account','credit','credit card')", [cItem]);
  });
  after(async () => { if (pool) await pool.end(); });

  const tx = (id, acct, amt, merchant, date) => q(
    "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ($1,$2,$3,$4,$5,$5,false)",
    [acct, id, amt, date, merchant]);

  // ---------------------------------------------------------------- F20
  it("F20: a deleted Teller transaction stays deleted through the reconcile", async () => {
    tellerTxns = [
      { id: "t_dup", amount: "-12.00", date: daysAgo(3), description: "CAFE", status: "posted", details: { counterparty: { name: "Cafe" } } },
      { id: "t_keep", amount: "-30.00", date: daysAgo(3), description: "GROCER", status: "posted", details: { counterparty: { name: "Grocer" } } },
    ];
    await enrollments.syncAllEnrollments();
    await q("INSERT INTO transaction_splits (parent_transaction_id, amount, category) VALUES ('t_dup', 12, 'Dining')");
    await supertest(app).delete("/api/transactions/t_dup").expect(200);
    const r = await enrollments.reconcileTeller(90);
    void r;
    const ids = (await q("SELECT transaction_id FROM transactions WHERE account_id='tchk' ORDER BY 1")).rows.map((x) => x.transaction_id);
    assert.deepEqual(ids, ["t_keep"]);
  });

  it("F20: a deleted Plaid transaction is not re-inserted by a re-delivery (and isn't counted)", async () => {
    const item = (await q("SELECT id FROM plaid_items WHERE item_id='pi1'")).rows[0].id;
    const page = { added: [
      { account_id: "pcard", transaction_id: "p_dup", amount: 9.99, date: today, name: "SPOTIFY", merchant_name: "Spotify", pending: false, category: ["Service", "Music"] },
      { account_id: "pcard", transaction_id: "p_keep", amount: 20, date: today, name: "AMAZON", merchant_name: "Amazon", pending: false },
    ], modified: [], removed: [], next_cursor: "c1", has_more: false };
    const client = { transactionsSync: async () => ({ data: page }) };
    const r1 = await investments.syncPlaidItemTransactions(client, item, "ptok");
    assert.equal(r1.added, 2);
    await supertest(app).delete("/api/transactions/p_dup").expect(200);
    await q("UPDATE sync_cursors SET cursor = '' WHERE plaid_item_id = $1", [item]);
    const r2 = await investments.syncPlaidItemTransactions(client, item, "ptok");
    assert.equal(r2.added, 0, JSON.stringify(r2));
    assert.equal(r2.incomplete, false, "a skipped tombstoned row is not a failed page");
    assert.equal((await q("SELECT 1 FROM transactions WHERE transaction_id='p_dup'")).rows.length, 0);
  });

  // ---------------------------------------------------------------- F21
  it("F21: CSV overlap pairs one-to-one on a similar merchant; Resolve keeps the genuine CSV rows", async () => {
    const d = daysAgo(10);
    await tx("c_sb1", "csvcard", 4.5, "STARBUCKS STORE 123", d);
    await tx("c_sb2", "csvcard", 4.5, "STARBUCKS STORE 123", d);
    await tx("c_bb", "csvcard", 4.5, "BLUE BOTTLE COFFEE", daysAgo(9));
    await tx("c_sw", "csvcard", 61.2, "SAFEWAY #1234", d);
    await tx("c_sh", "csvcard", 40.0, "SHELL OIL 5744", d);
    await tx("c_tg", "csvcard", 25.0, "TARGET T-0123", d);
    await tx("s_sb", "pcard", 4.5, "Starbucks", d);
    await tx("s_sw", "pcard", 61.2, "Safeway", daysAgo(11));
    await tx("s_sh", "pcard", 40.0, "Shell", d);
    await tx("s_tg", "pcard", 25.0, "Target", daysAgo(8));
    const res = await supertest(app).get("/api/transactions/csv-overlap").expect(200);
    assert.equal(res.body.overlaps.length, 1, JSON.stringify(res.body));
    assert.equal(res.body.overlaps[0].overlap_count, 4, "one Starbucks pair, not two; Blue Bottle isn't Starbucks");
    assert.equal(res.body.overlaps[0].overlap_amount, 130.7);
    const ids = res.body.overlaps[0];
    const dry = await supertest(app).post("/api/transactions/csv-overlap/resolve")
      .send({ csv_account_id: ids.csv_account_id, synced_account_id: ids.synced_account_id, dry_run: true }).expect(200);
    assert.equal(dry.body.would_delete, 4);
    await supertest(app).post("/api/transactions/csv-overlap/resolve")
      .send({ csv_account_id: ids.csv_account_id, synced_account_id: ids.synced_account_id }).expect(200);
    const left = (await q("SELECT transaction_id FROM transactions WHERE account_id='csvcard' ORDER BY 1")).rows.map((x) => x.transaction_id);
    assert.equal(left.length, 2);
    assert.ok(left.includes("c_bb"));
    assert.ok(left.includes("c_sb1") || left.includes("c_sb2"));
  });

  // ---------------------------------------------------------------- F45 / F59
  it("F45: a rent due on the 30th is placed on the 30th, not the 28th, and isn't overdue early", async () => {
    // The next month (after this one) with 31 days.
    let ym = cm;
    for (let i = 0; i < 12; i++) {
      const [y, m] = ym.split("-").map(Number);
      ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      const [y2, m2] = ym.split("-").map(Number);
      if (new Date(Date.UTC(y2, m2, 0)).getUTCDate() === 31) break;
    }
    await q("INSERT INTO payee_obligations (payee, category, label, period, amount, due_day, status) VALUES ('L','rent','Rent',$1,1000,30,'unpaid')", [ym]);
    const ics = await subs.buildBillCalendarIcs(365);
    assert.match(ics, new RegExp("DTSTART;VALUE=DATE:" + ym.replace("-", "") + "30"));
    assert.doesNotMatch(ics, /Rent — \$1000\.00 \(rent\/utilities, OVERDUE\)/);
  });

  it("F59: long SUMMARY lines are folded at 75 octets (UTF-8 safe) and unfold to the original", async () => {
    const name = "Très long abonnement — " + "x".repeat(60) + " ☕ service mensuel";
    await q("INSERT INTO manual_bills (name, amount, due_day, cadence, category) VALUES ($1, 15, 1, 'monthly', 'bill')", [name]);
    const ics = await subs.buildBillCalendarIcs(60);
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, line);
    const unfolded = ics.replace(/\r\n /g, "");
    assert.ok(unfolded.includes("SUMMARY:" + name + " — $15.00 (bill)"), "unfolds to the original line");
  });

  // ---------------------------------------------------------------- F56
  it("F56: Undismiss puts a subscription back in the active list", async () => {
    const r = await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, is_dismissed)
                       VALUES ('gym','Gym',40,30,$1,$1,$1,false,true) RETURNING id`, [today]);
    await supertest(app).patch(`/api/subscriptions/${r.rows[0].id}/undismiss`).expect(200);
    const active = (await supertest(app).get("/api/subscriptions").expect(200)).body.subscriptions;
    assert.ok(active.some((s) => s.merchant_key === "gym"));
    const t = await q(`INSERT INTO recurring_transfers (merchant_key, display_name, amount, cadence_days, first_seen, last_transferred, next_expected, is_active, is_dismissed, transfer_type, direction)
                       VALUES ('rent_x','Rent X',1500,30,$1,$1,$1,false,true,'peer_transfer','outgoing') RETURNING id`, [today]);
    await supertest(app).patch(`/api/recurring-transfers/${t.rows[0].id}/undismiss`).expect(200);
    const xfers = (await supertest(app).get("/api/recurring-transfers").expect(200)).body;
    const list = Array.isArray(xfers) ? xfers : (xfers.transfers || xfers.recurring_transfers || []);
    assert.ok(list.some((x) => x.merchant_key === "rent_x"), JSON.stringify(xfers).slice(0, 300));
  });

  // ---------------------------------------------------------------- F57
  it("F57: impossible months / days / dates are 400s; search treats % literally", async () => {
    await supertest(app).get("/api/bill-calendar?month=13").expect(400);
    await supertest(app).get("/api/bill-payments?year=2026&month=0").expect(400);
    await supertest(app).get("/api/bill-calendar").expect(200);
    await supertest(app).post("/api/manual-bills").send({ name: "X", amount: 5, due_day: "abc" }).expect(400);
    await supertest(app).post("/api/transactions/manual").send({ account_id: "tchk", amount: 5, date: "2026-13-45" }).expect(400);
    await supertest(app).get("/api/transactions/search?start_date=2026-02-30").expect(400);
    await tx("srch_pct", "pcard", 3, "50% Off Store", today);
    await tx("srch_other", "pcard", 3, "5000 Off Outlet", today);
    const res = await supertest(app).get("/api/transactions/search?q=" + encodeURIComponent("50% off")).expect(200);
    const ids = (res.body.transactions || res.body.results || []).map((t) => t.transaction_id);
    assert.deepEqual(ids, ["srch_pct"], JSON.stringify(res.body).slice(0, 300));
  });
});
