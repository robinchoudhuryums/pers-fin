// Real-Postgres contract tests for the cycle-7 Batch 4 bank-sync durability
// fixes: a token that won't decrypt (F17), the duplicate-Item guard (F18),
// the CSV manual-balance roll-forward (F25), user-removed investment accounts
// and investments-only unlink (F22), flow coverage (F24), liabilities values
// (F28), balance validation (F29) and the Teller text[] category (F30). Only
// Teller's HTTP client and a Plaid client object are stubbed.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("bank-sync durability on real Postgres", { skip: SKIP }, () => {
  let pool, app, enrollments, investments, perf, today;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const tellerCalls = [];
  const plaidCalls = [];
  let plaid; // per-test Plaid stub

  before(async () => {
    pool = await perfinDb("bankdur");
    today = require("../../teller/services/financial-queries").todayStr();
    const tellerApi = require("../../teller/services/teller-api");
    tellerApi.tellerRequest = async (endpoint, token) => {
      tellerCalls.push({ endpoint, token });
      if (endpoint === "/accounts") return [{ id: "tgood", name: "Checking", type: "depository", subtype: "checking", last_four: "1111" }];
      if (endpoint.endsWith("/balances")) return { account_id: "tgood", ledger: "100.00", available: "100.00" };
      if (endpoint.includes("/transactions")) {
        return endpoint.includes("from_id") ? [] : [
          { id: "tc1", amount: "-4.50", date: today, description: "CAFE", status: "posted", details: { category: "food, drink" } },
        ];
      }
      if (endpoint.startsWith("/accounts/")) return {};
      throw new Error("unexpected Teller endpoint " + endpoint);
    };
    const plaidClientModule = require("../../teller/services/plaid-client");
    plaidClientModule.getPlaidClient = () => plaid;
    // Route modules destructure their clients at require time — require AFTER the stubs.
    enrollments = require("../../teller/routes/enrollments");
    investments = require("../../teller/routes/investments");
    perf = require("../../teller/routes/investment-performance");
    app = perfinApp();

    // One good Teller enrollment, one encrypted under an OLD passphrase.
    await q("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status) VALUES ('e_good','Good Bank', pgp_sym_encrypt('tok_good', $1), 'GOOD')", [PASS()]);
    await q("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status) VALUES ('e_stale','Stale Bank', pgp_sym_encrypt('tok_stale', 'old-passphrase'), 'GOOD')");
    const good = (await q("SELECT id FROM teller_enrollments WHERE enrollment_id='e_good'")).rows[0].id;
    await q("INSERT INTO linked_accounts (teller_enrollment_id, account_id, name, type, subtype) VALUES ($1,'tgood','Checking','depository','checking')", [good]);
  });

  after(async () => { if (pool) await pool.end(); });

  // ---------------------------------------------------------------- F17
  it("F17: perfin_try_decrypt returns NULL for a wrong key (raw pgp_sym_decrypt raises)", async () => {
    const r = await q("SELECT perfin_try_decrypt(pgp_sym_encrypt('x', 'a'), 'b') AS bad, perfin_try_decrypt(pgp_sym_encrypt('x', 'a'), 'a') AS ok");
    assert.deepEqual(r.rows[0], { bad: null, ok: "x" });
    await assert.rejects(q("SELECT pgp_sym_decrypt(pgp_sym_encrypt('x', 'a'), 'b')"));
  });

  it("F17: one stale Teller token is reported, the good enrollment still syncs (txns + balances)", async () => {
    const r = await enrollments.syncAllEnrollments();
    assert.equal(r.transactions_added, 1, JSON.stringify(r));
    assert.deepEqual((r.errors || []).map((e) => [e.institution, e.error]), [["Stale Bank", "decryption_failed"]]);
    const b = await enrollments.syncAllBalances();
    assert.ok(b.accounts_updated >= 1, JSON.stringify(b));
    assert.ok((b.errors || []).some((e) => e.institution === "Stale Bank" && e.error === "decryption_failed"));
    assert.ok(!tellerCalls.some((c) => c.token == null), "no Teller call with a null token");
  });

  it("F30: the Teller category is stored as ONE text[] element even with a comma", async () => {
    const row = (await q("SELECT category FROM transactions WHERE transaction_id='tc1'")).rows[0];
    assert.deepEqual(row.category, ["food, drink"]);
  });

  it("F17: a stale Plaid token is reported by the transaction, balance, holdings and flow syncs", async () => {
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('p_stale','Stale Card', pgp_sym_encrypt('pt', 'old-passphrase'), 'GOOD')");
    await q("INSERT INTO plaid_investment_items (item_id, institution_name, access_token_enc) VALUES ('pi_stale','Stale Broker', pgp_sym_encrypt('pt', 'old-passphrase'))");
    plaid = {};
    const t = await investments.syncAllPlaidTransactions();
    assert.deepEqual(t.errors.map((e) => e.error), ["decryption_failed"]);
    const b = await investments.syncAllPlaidBalances();
    assert.ok(b.errors.some((e) => e.error === "decryption_failed"));
    const h = await investments.syncAllPlaidHoldings();
    assert.ok(h.errors.some((e) => e.error === "decryption_failed"), JSON.stringify(h));
    const f = await perf.syncAllPlaidInvestmentFlows();
    assert.ok(f.errors.some((e) => e.error === "decryption_failed"), JSON.stringify(f));
    await q("DELETE FROM plaid_items WHERE item_id='p_stale'");
    await q("DELETE FROM plaid_investment_items WHERE item_id='pi_stale'");
  });

  it("F17: the stale Teller enrollment can be unlinked (no Teller call, rows removed)", async () => {
    const id = (await q("SELECT id FROM teller_enrollments WHERE enrollment_id='e_stale'")).rows[0].id;
    tellerCalls.length = 0;
    await supertest(app).delete("/api/enrollments/" + id).expect(200);
    assert.equal(tellerCalls.length, 0);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM teller_enrollments WHERE id=$1", [id])).rows[0].n, 0);
  });

  // ---------------------------------------------------------------- F18
  it("F18: linking an already-linked bank again is refused, released at Plaid and stores nothing", async () => {
    await q("INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token_enc, status) VALUES ('p_old','ins_9','Capital Bank', pgp_sym_encrypt('old', $1), 'GOOD')", [PASS()]);
    const old = (await q("SELECT id FROM plaid_items WHERE item_id='p_old'")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, mask) VALUES ($1,'old_acc','Card','credit','credit card','4242')", [old]);
    const removed = [];
    plaid = {
      itemPublicTokenExchange: async () => ({ data: { access_token: "new_tok", item_id: "p_new" } }),
      accountsGet: async () => ({ data: { accounts: [{ account_id: "new_acc", name: "Card", type: "credit", subtype: "credit card", mask: "4242", balances: { current: 10 } }] } }),
      itemRemove: async ({ access_token }) => { removed.push(access_token); return { data: {} }; },
    };
    const res = await supertest(app).post("/api/plaid/exchange-transactions")
      .send({ public_token: "pub", institution: { institution_id: "ins_9", name: "Capital Bank" } }).expect(409);
    assert.equal(res.body.duplicate_of.id, old);
    assert.match(res.body.error, /Re-authenticate \/ Add accounts/);
    assert.deepEqual(removed, ["new_tok"]);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM plaid_items WHERE item_id='p_new'")).rows[0].n, 0);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM linked_accounts WHERE account_id='new_acc'")).rows[0].n, 0);
  });

  it("F18: a second login at the same bank with DIFFERENT accounts is not a duplicate", async () => {
    const dup = await investments.findDuplicatePlaidItem({
      itemId: "p_other", institutionId: "ins_9", institutionName: "Capital Bank",
      accounts: [{ mask: "9999", type: "credit" }],
    });
    assert.equal(dup, null);
    const byName = await investments.findDuplicatePlaidItem({
      itemId: "p_other", institutionId: null, institutionName: "capital bank",
      accounts: [{ mask: "4242", type: "credit" }],
    });
    assert.equal(byName.institution_name, "Capital Bank", "no institution_id → matched by name");
  });

  // ---------------------------------------------------------------- F25
  it("F25: a loan rolls forward as debt, stamped as of its newest row; an ambiguous match is left alone", async () => {
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, institution_name_manual, current_balance, balance_updated_at)
             VALUES ('man_loan','Car Loan','loan','auto', true, 'Loanco', 10000, '2026-09-01T12:00:00Z')`);
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, institution_name_manual, current_balance, balance_updated_at)
             VALUES ('man_a','Wallet A','depository','checking', true, 'Twinbank', 500, '2026-09-01T12:00:00Z'),
                    ('man_b','Wallet B','depository','checking', true, 'Twinbank', 700, '2026-09-01T12:00:00Z')`);
    const csv = "Transaction Date,Post Date,Description,Category,Type,Amount\n09/10/2026,09/11/2026,Interest,Fees,Fee,-25.00\n";
    await supertest(app).post("/api/import-csv").field("institution", "Loanco").field("account_label", "Car Loan")
      .attach("file", Buffer.from(csv), "loan.csv").expect(200);
    const loan = (await q("SELECT current_balance::float AS b, to_char(balance_updated_at AT TIME ZONE $1, 'YYYY-MM-DD') AS d FROM linked_accounts WHERE account_id='man_loan'",
      [require("../../teller/services/financial-queries").APP_TIMEZONE])).rows[0];
    assert.deepEqual(loan, { b: 10025, d: "2026-09-10" }, "a $25 charge raises the amount owed; balance known as of Sep 10");

    await supertest(app).post("/api/import-csv").field("institution", "Twinbank").field("account_label", "Twinbank Account")
      .attach("file", Buffer.from(csv.replace("Interest", "Cafe")), "twin.csv").expect(200);
    const twins = (await q("SELECT current_balance::float AS b FROM linked_accounts WHERE account_id IN ('man_a','man_b') ORDER BY account_id")).rows;
    assert.deepEqual(twins.map((r) => r.b), [500, 700], "two equally-good matches → neither is touched");
  });

  // ---------------------------------------------------------------- F22
  it("F22: a user-removed Plaid investment account stays removed through a holdings sync", async () => {
    await q("INSERT INTO plaid_investment_items (item_id, institution_name, access_token_enc) VALUES ('pi_live','Broker', pgp_sym_encrypt('itok', $1))", [PASS()]);
    await q("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id, is_active) VALUES ('Old IRA','Broker','ira',0,'ira_acc', false)");
    plaid = {
      investmentsHoldingsGet: async () => ({ data: {
        accounts: [
          { account_id: "ira_acc", name: "Old IRA", type: "investment", subtype: "ira", balances: { current: 5000 } },
          { account_id: "brk_acc", name: "Brokerage", type: "investment", subtype: "brokerage", balances: { current: 2000 } },
        ],
        holdings: [
          { account_id: "ira_acc", security_id: "s1", quantity: 1, institution_value: 5000, cost_basis: 4000 },
          { account_id: "brk_acc", security_id: "s1", quantity: 1, institution_value: 2000, cost_basis: 1500 },
        ],
        securities: [{ security_id: "s1", ticker_symbol: "VTI", name: "VTI", type: "etf" }],
      } }),
    };
    const r = await investments.syncAllPlaidHoldings();
    assert.ok(!r.errors || !r.errors.length, JSON.stringify(r));
    const accts = (await q("SELECT plaid_account_id, is_active FROM investment_accounts ORDER BY plaid_account_id")).rows;
    assert.deepEqual(accts.map((a) => [a.plaid_account_id, a.is_active]), [["brk_acc", true], ["ira_acc", false]]);
    const hold = (await q("SELECT plaid_account_id FROM investment_holdings ORDER BY 1")).rows.map((x) => x.plaid_account_id);
    assert.deepEqual(hold, ["brk_acc"]);
  });

  it("F22: an investments-only Item is listed and can be unlinked (released, accounts deactivated)", async () => {
    const items = (await supertest(app).get("/api/items").expect(200)).body;
    const inv = items.find((i) => i.provider === "plaid_investment" && i.item_id === "pi_live");
    assert.ok(inv, JSON.stringify(items));
    const removed = [];
    plaid = {
      accountsGet: async () => ({ data: { accounts: [{ account_id: "brk_acc" }, { account_id: "ira_acc" }] } }),
      itemRemove: async ({ access_token }) => { removed.push(access_token); return { data: {} }; },
    };
    const res = await supertest(app).delete("/api/plaid/investment-items/" + inv.id).expect(200);
    assert.deepEqual(res.body, { deleted: true, plaid_item_removed: true, accounts_deactivated: 1 });
    assert.deepEqual(removed, ["itok"]);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM plaid_investment_items WHERE item_id='pi_live'")).rows[0].n, 0);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM investment_holdings")).rows[0].n, 0);
  });

  // ---------------------------------------------------------------- F24
  it("F24: an account becomes flow-covered only after a complete flow walk; a transactions-only Item is skipped quietly", async () => {
    await q("INSERT INTO plaid_investment_items (item_id, institution_name, access_token_enc) VALUES ('pi_flow','Flowbroker', pgp_sym_encrypt('ftok', $1))", [PASS()]);
    await q("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id) VALUES ('Flow Acct','Flowbroker','brokerage',100,'flow_acc')");
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('p_txonly','Txonly', pgp_sym_encrypt('xtok', $1), 'GOOD')", [PASS()]);
    const txonly = (await q("SELECT id FROM plaid_items WHERE item_id='p_txonly'")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'tx_brk','Brokerage','investment','brokerage')", [txonly]);
    plaid = {
      investmentsTransactionsGet: async ({ access_token }) => {
        if (access_token === "xtok") { const e = new Error("not supported"); e.response = { data: { error_code: "PRODUCTS_NOT_SUPPORTED" } }; throw e; }
        return { data: { total_investment_transactions: 1, accounts: [{ account_id: "flow_acc" }],
          investment_transactions: [{ investment_transaction_id: "it1", account_id: "flow_acc", date: today, amount: -100, type: "cash", subtype: "deposit", name: "Deposit" }] } };
      },
    };
    const r = await perf.syncAllPlaidInvestmentFlows();
    assert.equal(r.ok, true);
    assert.ok(!r.errors, "the transactions-only Item raises no plaid_flows error: " + JSON.stringify(r.errors));
    const rows = (await q("SELECT plaid_account_id, flows_synced_at IS NOT NULL AS synced FROM investment_accounts WHERE plaid_account_id IN ('flow_acc','brk_acc') ORDER BY 1")).rows;
    assert.deepEqual(rows.map((x) => [x.plaid_account_id, x.synced]), [["brk_acc", false], ["flow_acc", true]]);
  });

  // ---------------------------------------------------------------- F28
  it("F28: a 0% promotional APR and a $0 minimum payment are stored, not nulled", async () => {
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('p_lib','Cardco', pgp_sym_encrypt('ltok', $1), 'GOOD')", [PASS()]);
    const item = (await q("SELECT id FROM plaid_items WHERE item_id='p_lib'")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, apr) VALUES ($1,'lib_acc','Promo Card','credit','credit card', 24.99)", [item]);
    const client = { liabilitiesGet: async () => ({ data: { accounts: [], liabilities: { credit: [
      { account_id: "lib_acc", aprs: [{ apr_type: "purchase_apr", apr_percentage: 0 }], minimum_payment_amount: 0 },
    ] } } }) };
    await investments.syncPlaidLiabilities(client, "ltok", item);
    const row = (await q("SELECT apr::float AS apr, minimum_payment::float AS mp FROM linked_accounts WHERE account_id='lib_acc'")).rows[0];
    assert.deepEqual(row, { apr: 0, mp: 0 });
  });

  // ---------------------------------------------------------------- F29
  it("F29: a non-numeric balance is a 400, never a stored NaN; '$1,250.50' is accepted", async () => {
    const id = (await q("SELECT id FROM linked_accounts WHERE account_id='man_a'")).rows[0].id;
    await supertest(app).patch(`/api/accounts/${id}/balance`).send({ current_balance: "abc" }).expect(400);
    await supertest(app).patch(`/api/accounts/${id}/balance`).send({ credit_limit: -5 }).expect(400);
    await supertest(app).patch(`/api/accounts/${id}/balance`).send({ current_balance: "$1,250.50", credit_limit: null }).expect(200);
    const nan = (await q("SELECT COUNT(*)::int AS n FROM linked_accounts WHERE current_balance = 'NaN'")).rows[0].n;
    assert.equal(nan, 0);
    assert.equal((await q("SELECT current_balance::float AS b FROM linked_accounts WHERE id=$1", [id])).rows[0].b, 1250.5);
    const inv = (await q("INSERT INTO investment_accounts (name, account_type, balance) VALUES ('Manual','brokerage',10) RETURNING id")).rows[0].id;
    await supertest(app).patch(`/api/investment-accounts/${inv}`).send({ balance: "lots" }).expect(400);
  });
});
