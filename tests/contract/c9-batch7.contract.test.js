// Real-Postgres contract test for cycle 9 Batch 7 — bank-sync recovery on real
// rows, the app's own migrations and the production mount order (only Teller's
// HTTP client and a Plaid client object are stubbed):
//  - F13: a Teller re-link that reuses the account ids retires the enrollment
//    it emptied (accounts re-pointed, transactions kept); an enrollment
//    stranded earlier goes at the next sync; an empty enrollment with no
//    replacement stays
//  - F14: a manual account with a transaction (and a split, a snapshot, a goal
//    funded from it) answers 409 until confirmed, then goes with its rows
//  - F15: a Debit / Credit CSV previewed and imported with the right signs
//  - F16: a Plaid row first inserted through `modified` counts as added
//  - F17: an investments-only connection whose token can't be read is unlinked
//    WITH its accounts, and the bank can be linked again
//  - F19: a Plaid webhook replayed with its signature re-encoded is a duplicate
//  - F35: re-linking a goal to another account keeps its progress
//  - F36: the budget alert takes last month's snapshot and uses the rollover
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const KID = "kid-b7c";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const P256_N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

describe("Cycle 9 Batch 7 (bank-sync recovery) on real Postgres", { skip: SKIP }, () => {
  let pool, app, enrollments, investments, plaidClient, realGet, tellerApi, realTeller, fq, today;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const enrollmentIds = async () => (await q("SELECT enrollment_id FROM teller_enrollments ORDER BY enrollment_id")).rows.map((r) => r.enrollment_id);
  const manual = async (account_id, name, balance = 100, type = "depository") => (await q(
    "INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance) VALUES ($1,$2,$3,$4,true,$5) RETURNING id",
    [account_id, name, type, type === "depository" ? "checking" : "credit card", balance])).rows[0].id;
  const txn = (id, account, amount, date, name, category) => q(
    `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, user_category)
     VALUES ($1,$2,$3,$4,$5,$5,false,$6)`, [account, id, amount, date, name, category || null]);

  before(async () => {
    pool = await perfinDb("c9_batch7");
    fq = require("../../teller/services/financial-queries");
    today = fq.todayStr();
    tellerApi = require("../../teller/services/teller-api");
    realTeller = tellerApi.tellerRequest;
    tellerApi.tellerRequest = async (endpoint) => {
      if (endpoint === "/accounts") return [{ id: "tacc1", name: "Checking", type: "depository", subtype: "checking", last_four: "1111" }];
      if (endpoint.includes("/transactions")) return [];
      if (endpoint.endsWith("/balances")) return { account_id: "tacc1", ledger: "100.00", available: "100.00" };
      throw new Error("unexpected Teller endpoint " + endpoint);
    };
    plaidClient = require("../../teller/services/plaid-client");
    realGet = plaidClient.getPlaidClient;
    plaidClient.getPlaidClient = () => ({
      webhookVerificationKeyGet: async () => ({ data: { key: { ...jwk, alg: "ES256", kid: KID, use: "sig", created_at: 1, expired_at: null } } }),
    });
    // The routes bind tellerRequest / getPlaidClient at require time — after the stubs.
    enrollments = require("../../teller/routes/enrollments");
    investments = require("../../teller/routes/investments");
    app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use(perfinApp());
  });
  after(async () => {
    if (tellerApi) tellerApi.tellerRequest = realTeller;
    if (plaidClient) plaidClient.getPlaidClient = realGet;
    if (pool) await pool.end();
  });

  // ------------------------------------------------------------------ F13
  it("F13: a re-link that reuses the account ids retires the enrollment it emptied — the transactions stay", async () => {
    const old = (await q("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status) VALUES ('enr_old','Chase', pgp_sym_encrypt('old', $1), 'DISCONNECTED') RETURNING id", [PASS()])).rows[0].id;
    await q("INSERT INTO linked_accounts (teller_enrollment_id, account_id, name, type, subtype) VALUES ($1,'tacc1','Checking','depository','checking')", [old]);
    await txn("t_keep", "tacc1", 12.5, today, "CAFE");
    await q("UPDATE transactions SET user_notes = 'mine' WHERE transaction_id = 't_keep'");

    const res = await supertest(app).post("/api/enroll").send({ accessToken: "new_tok", enrollment: { id: "enr_new", institution: { name: "Chase" } } }).expect(200);
    assert.equal(res.body.accounts_linked, 1);
    assert.equal(res.body.retired_enrollments, 1);
    assert.deepEqual(await enrollmentIds(), ["enr_new"], "the old enrollment used to stay, DISCONNECTED and unlisted");
    const acct = (await q("SELECT te.enrollment_id FROM linked_accounts la JOIN teller_enrollments te ON te.id = la.teller_enrollment_id WHERE la.account_id = 'tacc1'")).rows[0];
    assert.equal(acct.enrollment_id, "enr_new");
    const kept = (await q("SELECT user_notes FROM transactions WHERE transaction_id = 't_keep'")).rows;
    assert.deepEqual(kept, [{ user_notes: "mine" }]);
    // GET /api/items lists one Chase connection.
    const items = (await supertest(app).get("/api/items").expect(200)).body.filter((i) => i.provider === "teller");
    assert.deepEqual(items.map((i) => [i.institution_name, i.status, i.accounts.length]), [["Chase", "GOOD", 1]]);
  });

  it("F13: one stranded earlier goes at the next sync; an empty enrollment with no replacement stays", async () => {
    await q("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status) VALUES ('enr_orphan','CHASE', pgp_sym_encrypt('x', 'another-passphrase'), 'GOOD'), ('enr_solo','Lonely Bank', pgp_sym_encrypt('y', $1), 'GOOD')", [PASS()]);
    const r = await enrollments.syncAllEnrollments({ skipAnomaly: true });
    assert.deepEqual(await enrollmentIds(), ["enr_new", "enr_solo"], "the Chase orphan (case-insensitive) is gone");
    assert.equal(r.errors, undefined, "its unreadable token no longer reports decryption_failed on every run");
    assert.equal(r.enrollments_synced, 2);
    await q("DELETE FROM teller_enrollments WHERE enrollment_id = 'enr_solo'");
  });

  // ------------------------------------------------------------------ F14
  it("F14: a manual account with a transaction is a 409 until confirmed, then goes with its rows", async () => {
    const id = await manual("manual_wallet", "Wallet", 80);
    await txn("m1", "manual_wallet", 20, today, "FARMERS MARKET");
    await q("INSERT INTO transaction_splits (parent_transaction_id, amount, category) VALUES ('m1', 12, 'Groceries'), ('m1', 8, 'Dining')");
    await q("INSERT INTO account_balance_snapshots (source, source_id, snapshot_date, balance) VALUES ('linked', $1, CURRENT_DATE, 80)", [id]);
    const goal = (await supertest(app).post("/api/goals").send({ name: "Jar", target_amount: 500, current_amount: 0 }).expect(200)).body.id;
    await supertest(app).patch("/api/goals/" + goal).send({ funding_account_id: id }).expect(200);

    const refused = await supertest(app).delete("/api/accounts/manual/" + id).expect(409);
    assert.deepEqual(refused.body, { error: "Wallet has 1 transaction. Removing the account removes it too.", reason: "has_transactions", transactions: 1 });
    assert.equal((await q("SELECT count(*)::int AS n FROM linked_accounts WHERE id = $1", [id])).rows[0].n, 1, "nothing was removed (it used to answer 500)");

    const ok = await supertest(app).delete("/api/accounts/manual/" + id + "?delete_transactions=1").expect(200);
    assert.deepEqual(ok.body, { deleted: true, transactions_deleted: 1 });
    const left = (await q(`SELECT (SELECT count(*) FROM linked_accounts WHERE id = $1)::int AS acct,
                                  (SELECT count(*) FROM transactions WHERE account_id = 'manual_wallet')::int AS txns,
                                  (SELECT count(*) FROM transaction_splits WHERE parent_transaction_id = 'm1')::int AS splits,
                                  (SELECT count(*) FROM account_balance_snapshots WHERE source = 'linked' AND source_id = $1)::int AS snaps`, [id])).rows[0];
    assert.deepEqual(left, { acct: 0, txns: 0, splits: 0, snaps: 0 });
    const g = (await q("SELECT funding_account_id FROM financial_goals WHERE id = $1", [goal])).rows[0];
    assert.equal(g.funding_account_id, null, "the goal is unlinked, not blocking the delete");
    await q("DELETE FROM financial_goals WHERE id = $1", [goal]);
  });

  it("F14: an empty manual account needs no confirmation; a bank-linked account is a 404", async () => {
    const id = await manual("manual_empty", "Empty");
    assert.deepEqual((await supertest(app).delete("/api/accounts/manual/" + id).expect(200)).body, { deleted: true, transactions_deleted: 0 });
    const linked = (await q("SELECT id FROM linked_accounts WHERE account_id = 'tacc1'")).rows[0].id;
    await supertest(app).delete("/api/accounts/manual/" + linked + "?delete_transactions=1").expect(404);
    assert.equal((await q("SELECT count(*)::int AS n FROM transactions WHERE account_id = 'tacc1'")).rows[0].n, 1);
  });

  // ------------------------------------------------------------------ F15
  it("F15: a Debit / Credit CSV is previewed and imported with the right signs", async () => {
    const d1 = require("../../teller/services/cadence").addDaysStr(today, -3);
    const d2 = require("../../teller/services/cadence").addDaysStr(today, -2);
    const file = `Date,Description,Debit,Credit,Balance\n${d1},ACME PAYROLL,,"2,100.00",5000.00\n${d2},CORNER GROCER,45.10,,4954.90\n`;
    const preview = (await supertest(app).post("/api/import-csv/preview").attach("file", Buffer.from(file), "cu.csv").expect(200)).body;
    assert.deepEqual([preview.format_detected, preview.positive_means, preview.rows_new, preview.rows_skipped], ["generic", null, 2, 0]);
    const imported = (await supertest(app).post("/api/import-csv").attach("file", Buffer.from(file), "cu.csv").expect(200)).body;
    assert.equal(imported.rows_imported, 2, "the paycheck used to be skipped as $0");
    const rows = (await q("SELECT merchant_name, amount::float AS amount FROM transactions WHERE transaction_id LIKE 'csv_%' ORDER BY amount")).rows;
    assert.deepEqual(rows, [{ merchant_name: "ACME PAYROLL", amount: -2100 }, { merchant_name: "CORNER GROCER", amount: 45.1 }]);
    const again = (await supertest(app).post("/api/import-csv").attach("file", Buffer.from(file), "cu.csv").expect(200)).body;
    assert.deepEqual([again.rows_imported, again.rows_duplicate], [0, 2]);
  });

  // ------------------------------------------------------------------ F16
  it("F16: a Plaid row first inserted through `modified` is counted as added, once", async () => {
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('pitem','Card Co', pgp_sym_encrypt('ptok', $1), 'GOOD')", [PASS()]);
    const item = (await q("SELECT id FROM plaid_items WHERE item_id = 'pitem'")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'pacc','Card','credit','credit card')", [item]);
    await q("INSERT INTO sync_cursors (plaid_item_id, cursor) VALUES ($1, '')", [item]);
    const row = { transaction_id: "p_mod", account_id: "pacc", amount: 33.3, date: today, name: "POSTED LATE", pending: false };
    const client = { transactionsSync: async () => ({ data: { added: [], modified: [row], removed: [], next_cursor: "c1", has_more: false } }) };
    const first = await investments.syncPlaidItemTransactions(client, item, "ptok");
    assert.deepEqual([first.added, first.modified], [1, 0], "it was [0, 1] — so the post-sync steps were skipped for it");
    const second = await investments.syncPlaidItemTransactions(client, item, "ptok");
    assert.deepEqual([second.added, second.modified], [0, 1]);
    assert.equal((await q("SELECT count(*)::int AS n FROM transactions WHERE transaction_id = 'p_mod'")).rows[0].n, 1);
  });

  // ------------------------------------------------------------------ F17
  it("F17: an investments-only connection with an unreadable token is unlinked with its accounts, and can be linked again", async () => {
    const reg = (await q("INSERT INTO plaid_investment_items (item_id, institution_name, access_token_enc) VALUES ('pi_old','Broker', pgp_sym_encrypt('tok', 'a-passphrase-from-before')) RETURNING id")).rows[0].id;
    await q("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id, mask) VALUES ('Brokerage','Broker','brokerage',5000,'old_acc','4321')");
    await q("INSERT INTO investment_holdings (plaid_account_id, security_id, name, quantity, current_value) VALUES ('old_acc','sec1','Fund',10,5000)");
    // An account an earlier unlink left active with no connection (the pre-fix state).
    await q("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id, mask) VALUES ('Old IRA','Ghost Broker','ira',900,'ghost_acc','7777')");

    const relink = (name, mask, subtype) => investments.findDuplicateInvestmentItem({ itemId: "pi_new", institutionId: "ins_x", institutionName: name,
      accounts: [{ account_id: "new_acc", mask, type: "investment", subtype }] });
    assert.ok(await relink("Broker", "4321", "brokerage"), "while connected, a second link of the same account is refused");
    assert.equal(await relink("Ghost Broker", "7777", "ira"), null, "accounts with no connection no longer block a link");

    const res = await supertest(app).delete("/api/plaid/investment-items/" + reg).expect(200);
    assert.deepEqual(res.body, { deleted: true, plaid_item_removed: false, accounts_deactivated: 1 });
    const acct = (await q("SELECT is_active FROM investment_accounts WHERE plaid_account_id = 'old_acc'")).rows[0];
    assert.equal(acct.is_active, false, "it used to stay active with its last balance");
    assert.equal((await q("SELECT count(*)::int AS n FROM investment_holdings WHERE plaid_account_id = 'old_acc'")).rows[0].n, 0);
    assert.equal((await q("SELECT is_active FROM investment_accounts WHERE plaid_account_id = 'ghost_acc'")).rows[0].is_active, true, "another institution's account is untouched");
    assert.equal(await relink("Broker", "4321", "brokerage"), null, "and the bank can be linked again");
  });

  // ------------------------------------------------------------------ F19
  it("F19: a Plaid webhook replayed with its signature re-encoded is a duplicate — one row", async () => {
    const raw = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-unknown" });
    const h = b64u({ alg: "ES256", kid: KID, typ: "JWT" });
    const p = b64u({ iat: Math.floor(Date.now() / 1000), request_body_sha256: crypto.createHash("sha256").update(raw).digest("hex") });
    const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
    const s = BigInt("0x" + sig.subarray(32).toString("hex"));
    const twin = Buffer.concat([sig.subarray(0, 32), Buffer.from((P256_N - s).toString(16).padStart(64, "0"), "hex")]);
    const post = (signature) => supertest(app).post("/api/webhooks/plaid").set("Content-Type", "application/json")
      .set("Plaid-Verification", `${h}.${p}.${signature.toString("base64url")}`).send(raw);
    const first = await post(sig).expect(200);
    assert.notEqual(first.body.duplicate, true);
    const replay = await post(twin).expect(200);
    assert.equal(replay.body.duplicate, true, "a valid signature in its other encoding — it used to be recorded and processed again");
    const rows = (await q("SELECT dedupe_key FROM webhook_events WHERE provider = 'plaid'")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dedupe_key, "jwt:" + crypto.createHash("sha256").update(`${h}.${p}`).digest("hex"));
  });

  // ------------------------------------------------------------------ F35
  it("F35: re-linking a goal to another account keeps its progress", async () => {
    const a = await manual("sav_a", "Savings A", 5000);
    const b = await manual("sav_b", "Savings B", 10000);
    const goal = (await supertest(app).post("/api/goals").send({ name: "House", target_amount: 20000, current_amount: 500 }).expect(200)).body.id;
    const current = async () => (await supertest(app).get("/api/goals").expect(200)).body.find((g) => g.id === goal);
    await supertest(app).patch("/api/goals/" + goal).send({ funding_account_id: a }).expect(200);
    assert.equal((await current()).current_amount, 500, "the first link preserves the stored progress");
    await q("UPDATE linked_accounts SET current_balance = 7500 WHERE id = $1", [a]); // $2,500 saved since
    assert.equal((await current()).current_amount, 3000);

    await supertest(app).patch("/api/goals/" + goal).send({ funding_account_id: b }).expect(200);
    const after = await current();
    assert.equal(after.current_amount, 3000, "it reset to the pre-link $500");
    assert.equal(after.funding_source.name, "Savings B");
    // Saving the same link again changes nothing either.
    await supertest(app).patch("/api/goals/" + goal).send({ funding_account_id: b }).expect(200);
    assert.equal((await current()).current_amount, 3000);
    await q("DELETE FROM financial_goals WHERE id = $1", [goal]);
  });

  // ------------------------------------------------------------------ F36
  it("F36: with no snapshot for last month the budget alert takes it and uses the rolled-over limit", async () => {
    const month = fq.currentMonth();
    const prev = fq.previousMonthKey(month);
    await manual("cash_b", "Cash");
    await q("INSERT INTO budgets (category, monthly_limit, rollover_enabled, created_at) VALUES ('Dining', 100, true, now() - interval '100 days')");
    await txn("d_prev", "cash_b", 50, prev + "-15", "BISTRO", "Dining");
    await txn("d_now", "cash_b", 120, today, "BISTRO", "Dining");
    assert.equal((await q("SELECT count(*)::int AS n FROM budget_snapshots")).rows[0].n, 0, "the activity-gated job never ran");

    await require("../../teller/startup")._awayJobs.runBudgetAlertTick();

    const snap = (await q("SELECT month, spent::float AS spent, rollover_amount::float AS rollover FROM budget_snapshots")).rows;
    assert.deepEqual(snap, [{ month: prev, spent: 50, rollover: 50 }]);
    const sent = (await q("SELECT type, title, body FROM notification_log WHERE type LIKE 'budget-%'")).rows;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "Budget warning: Dining", "$120 of $150 — it used to push 'Budget exceeded' at the base $100");
    assert.equal(sent[0].type, "budget-warn-dining");
    assert.match(sent[0].body, /^\$120\.00 of \$150\.00 \(80%/);
    // The same limit the Budgets page shows.
    const page = (await supertest(app).get("/api/budgets").expect(200)).body;
    const dining = (Array.isArray(page) ? page : page.budgets).find((x) => x.category === "Dining");
    assert.equal(Number(dining.effective_limit), 150);
  });
});
