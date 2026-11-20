// ============================================================================
// Cycle 9 Batch 7 — bank-sync recovery (F13 F14 F15 F16 F17 F18 F19 F35 F36),
// against the real modules:
//   - F13  the enrollment a Teller re-link emptied is retired, in the link's own
//          transaction and (for one stranded earlier) at the next sync — never
//          the enrollment a link just created, and a failure never fails a sync
//   - F14  DELETE /api/accounts/manual/:id with transactions: a 409 naming the
//          count until confirmed, then one database transaction; the Accounts
//          page asks and retries
//   - F15  a generic CSV with separate Debit / Credit columns: money out minus
//          money in, whatever the column order or printed sign; no sign choice
//   - F16  a Plaid row first inserted through `modified` counts as added
//   - F17  the investments-only duplicate guard needs a registered connection;
//          an unlink that can't list its accounts deactivates them by
//          institution (unless another connection there could own them)
//   - F18  last_txn_sync_at only when the run synced something; a failed read
//          of last_sync_result writes nothing; a partial webhook sync fails
//          its event
//   - F19  the Plaid webhook dedupe key covers the signed bytes: the same
//          delivery with its signature re-encoded (s → n − s) has the same key
//   - F35  re-linking a goal keeps its derived progress
//   - F36  the budget alert takes last month's snapshot itself
// The database-backed half is tests/contract/c9-batch7.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const dbModule = require("../teller/services/database");
const tellerApi = require("../teller/services/teller-api");
const plaidClientModule = require("../teller/services/plaid-client");

const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
const originalTellerRequest = tellerApi.tellerRequest;
const originalGetPlaidClient = plaidClientModule.getPlaidClient;

// Per-test stubs; the route modules are required AFTER the exports are patched
// so their top-level destructuring binds to the stubs.
let S;
let enr, inv;
before(() => {
  tellerApi.tellerRequest = (endpoint, token, opts) => S.teller(endpoint, token, opts);
  plaidClientModule.getPlaidClient = () => S.plaid;
  delete require.cache[require.resolve("../teller/routes/enrollments")];
  delete require.cache[require.resolve("../teller/routes/investments")];
  enr = require("../teller/routes/enrollments");
  inv = require("../teller/routes/investments");
});
after(() => {
  tellerApi.tellerRequest = originalTellerRequest;
  plaidClientModule.getPlaidClient = originalGetPlaidClient;
  dbModule.pool.query = originalQuery;
  dbModule.pool.connect = originalConnect;
});
afterEach(() => {
  dbModule.pool.query = originalQuery;
  dbModule.pool.connect = originalConnect;
});
function install(db) {
  S = { log: [], teller: async () => [], plaid: null, db };
  const run = (tx) => async (sql, params) => {
    S.log.push({ sql, params: params || [], tx });
    return (await S.db(sql, params || [])) || { rows: [] };
  };
  dbModule.pool.query = run(false);
  dbModule.pool.connect = async () => ({ query: run(true), release() { S.released = (S.released || 0) + 1; } });
}
const ran = (re) => S.log.filter((q) => re.test(q.sql));
const idx = (re) => S.log.findIndex((q) => re.test(q.sql));
const app = (router) => { const a = express(); a.use(express.json()); a.use(router); return a; };

// ---------------------------------------------------------------------------
describe("F13 — a Teller re-link retires the enrollment it emptied", () => {
  it("the SQL: no accounts, another enrollment at the same institution with accounts, never the kept id", () => {
    const sql = enr.RETIRE_EMPTY_ENROLLMENTS_SQL;
    assert.match(sql, /DELETE FROM teller_enrollments te/);
    assert.match(sql, /\(\$1::int IS NULL OR te\.id <> \$1::int\)/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM linked_accounts la WHERE la\.teller_enrollment_id = te\.id\)/);
    assert.match(sql, /JOIN linked_accounts la2 ON la2\.teller_enrollment_id = other\.id/);
    assert.match(sql, /LOWER\(other\.institution_name\) = LOWER\(te\.institution_name\)/);
    assert.match(sql, /RETURNING te\.id, te\.institution_name/);
  });

  it("POST /api/enroll retires it inside the link's transaction, after the accounts moved and before COMMIT", async () => {
    install(async (sql) => {
      if (sql.includes("INSERT INTO teller_enrollments")) return { rows: [{ id: 42 }] };
      if (/^\s*DELETE FROM teller_enrollments te/.test(sql)) return { rows: [{ id: 7, institution_name: "Bank" }] };
    });
    S.teller = async (ep) => (ep === "/accounts" ? [{ id: "acc_same", name: "Checking", type: "depository", subtype: "checking" }] : []);
    const res = await supertest(app(enr)).post("/api/enroll").send({ accessToken: "tok", enrollment: { id: "enr_new", institution: { name: "Bank" } } }).expect(200);
    assert.equal(res.body.retired_enrollments, 1);
    assert.equal(res.body.accounts_linked, 1);
    const retire = ran(/DELETE FROM teller_enrollments te/);
    assert.equal(retire.length, 1);
    assert.equal(retire[0].tx, true, "on the transaction's client");
    assert.deepEqual(retire[0].params, [42], "the enrollment just created is kept");
    assert.ok(idx(/INSERT INTO linked_accounts \(teller_enrollment_id/) < idx(/DELETE FROM teller_enrollments te/));
    assert.ok(idx(/DELETE FROM teller_enrollments te/) < idx(/^COMMIT$/));
  });

  it("nothing to retire → 0, and the link is unchanged", async () => {
    install(async (sql) => (sql.includes("INSERT INTO teller_enrollments") ? { rows: [{ id: 42 }] } : undefined));
    const res = await supertest(app(enr)).post("/api/enroll").send({ accessToken: "tok", enrollment: { id: "enr_new" } }).expect(200);
    assert.equal(res.body.retired_enrollments, 0);
  });

  it("the next sync retires one stranded earlier — before it reads the enrollments, with no kept id", async () => {
    install(async (sql) => {
      if (/^\s*DELETE FROM teller_enrollments te/.test(sql)) return { rows: [{ id: 3, institution_name: "Bank" }] };
    });
    const r = await enr.syncAllEnrollments({ skipAnomaly: true });
    assert.equal(r.enrollments_synced, 0);
    assert.deepEqual(ran(/DELETE FROM teller_enrollments te/)[0].params, [null]);
    assert.ok(idx(/DELETE FROM teller_enrollments te/) < idx(/FROM teller_enrollments te\s+WHERE te\.status != 'SUSPENDED'/));
  });

  it("a failing cleanup never fails the sync", async () => {
    install(async (sql) => {
      if (/^\s*DELETE FROM teller_enrollments te/.test(sql)) throw new Error("lock timeout");
    });
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try {
      const r = await enr.syncAllEnrollments({ skipAnomaly: true });
      assert.equal(r.enrollments_synced, 0);
      assert.equal(r.errors, undefined);
    } finally { console.error = orig; }
    assert.ok(errors.some((e) => /retire empty Teller enrollments failed: lock timeout/.test(e)));
  });
});

// ---------------------------------------------------------------------------
describe("F14 — deleting a manual account that has transactions", () => {
  const db = ({ account = { id: 5, account_id: "manual_cash", name: "Cash" }, txns = 3, fail = null } = {}) => async (sql) => {
    if (fail && fail.test(sql)) throw new Error("boom");
    if (/FROM linked_accounts WHERE id = \$1 AND is_manual = true FOR UPDATE/.test(sql)) return { rows: account ? [account] : [] };
    if (/SELECT count\(\*\)::int AS n FROM transactions WHERE account_id = \$1/.test(sql)) return { rows: [{ n: txns }] };
  };

  it("unconfirmed: 409 with the count, nothing deleted, rolled back", async () => {
    install(db());
    const res = await supertest(app(enr)).delete("/api/accounts/manual/5").expect(409);
    assert.deepEqual(res.body, { error: "Cash has 3 transactions. Removing the account removes them too.", reason: "has_transactions", transactions: 3 });
    assert.equal(ran(/^DELETE /).length, 0);
    assert.equal(ran(/^ROLLBACK$/).length, 1);
    assert.equal(S.released, 1);
  });

  it("one transaction reads in the singular", async () => {
    install(db({ txns: 1 }));
    const res = await supertest(app(enr)).delete("/api/accounts/manual/5").expect(409);
    assert.equal(res.body.error, "Cash has 1 transaction. Removing the account removes it too.");
  });

  it("confirmed: the transactions, the snapshots and the account go in one transaction", async () => {
    install(db());
    const res = await supertest(app(enr)).delete("/api/accounts/manual/5?delete_transactions=1").expect(200);
    assert.deepEqual(res.body, { deleted: true, transactions_deleted: 3 });
    const order = S.log.map((q) => q.sql).filter((s) => /^(BEGIN|COMMIT|ROLLBACK|DELETE)/.test(s)).map((s) => s.split(" WHERE")[0]);
    assert.deepEqual(order, ["BEGIN", "DELETE FROM transactions", "DELETE FROM account_balance_snapshots", "DELETE FROM linked_accounts", "COMMIT"]);
    assert.deepEqual(ran(/^DELETE FROM transactions/)[0].params, ["manual_cash"], "by the account's own account_id");
    assert.deepEqual(ran(/^DELETE FROM account_balance_snapshots WHERE source = 'linked' AND source_id = \$1/)[0].params, [5]);
    assert.ok(S.log.every((q) => q.tx), "every statement on the transaction's client");
  });

  it("the JSON body confirms too; an account with no transactions needs no confirmation", async () => {
    install(db());
    await supertest(app(enr)).delete("/api/accounts/manual/5").send({ delete_transactions: true }).expect(200);
    install(db({ txns: 0 }));
    const res = await supertest(app(enr)).delete("/api/accounts/manual/5").expect(200);
    assert.deepEqual(res.body, { deleted: true, transactions_deleted: 0 });
    assert.equal(ran(/^DELETE FROM transactions/).length, 0);
  });

  it("not a manual account, or not an id → 404 and nothing deleted", async () => {
    install(db({ account: null }));
    await supertest(app(enr)).delete("/api/accounts/manual/5?delete_transactions=1").expect(404);
    assert.equal(ran(/^DELETE /).length, 0);
    install(db());
    await supertest(app(enr)).delete("/api/accounts/manual/abc").expect(404);
    await supertest(app(enr)).delete("/api/accounts/manual/5;DROP").expect(404);
    assert.equal(S.log.length, 0, "no query for a malformed id");
  });

  it("a failure part-way rolls back and answers a fixed 500", async () => {
    install(db({ fail: /^DELETE FROM linked_accounts/ }));
    const orig = console.error; console.error = () => {};
    let res;
    try { res = await supertest(app(enr)).delete("/api/accounts/manual/5?delete_transactions=1").expect(500); }
    finally { console.error = orig; }
    assert.deepEqual(res.body, { error: "Failed to delete account" });
    assert.equal(ran(/^ROLLBACK$/).length, 1);
    assert.equal(ran(/^COMMIT$/).length, 0);
  });

  describe("the Accounts page", () => {
    const src = read("teller/views/accounts.ejs");
    const from = src.indexOf("    async function deleteManualAccount(id, name) {");
    const to = src.indexOf("    // Investment accounts", from);
    function page({ first, second, confirms = [] }) {
      const calls = { fetch: [], confirm: [], status: [], reloads: 0 };
      const answers = confirms.slice();
      const ctx = {
        confirm: (m) => { calls.confirm.push(m); return answers.shift(); },
        apiFetch: async (url, opts) => { calls.fetch.push([url, opts.method]); return calls.fetch.length === 1 ? first : second; },
        writeOk: async (res, what) => { if (res.ok) return true; calls.status.push(what); return false; },
        showStatus: (m, ok) => calls.status.push([m, ok]),
        loadManualAccounts: () => { calls.reloads++; },
      };
      vm.runInNewContext(src.slice(from, to) + "\nthis.run = deleteManualAccount;", ctx);
      return { ctx, calls };
    }
    const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, clone() { return this; } });

    it("is found in the view", () => { assert.ok(from > 0 && to > from); });

    it("an account with transactions: asks again with the count, then retries with the confirmation", async () => {
      const { ctx, calls } = page({ first: resp(409, { reason: "has_transactions", transactions: 3 }), second: resp(200, { deleted: true }), confirms: [true, true] });
      await ctx.run(5, "Cash");
      assert.deepEqual(calls.fetch, [["/api/accounts/manual/5", "DELETE"], ["/api/accounts/manual/5?delete_transactions=1", "DELETE"]]);
      assert.equal(calls.confirm[1], "Cash has 3 transactions. Remove the account and those transactions? This can't be undone.");
      assert.deepEqual(calls.status, [["Removed Cash.", true]]);
      assert.equal(calls.reloads, 1);
    });

    it("declining the second question sends nothing more and removes nothing", async () => {
      const { ctx, calls } = page({ first: resp(409, { reason: "has_transactions", transactions: 1 }), confirms: [true, false] });
      await ctx.run(5, "Cash");
      assert.equal(calls.fetch.length, 1);
      assert.match(calls.confirm[1], /has 1 transaction\. Remove the account and that transaction\?/);
      assert.equal(calls.reloads, 0);
      assert.deepEqual(calls.status, []);
    });

    it("an empty account is removed in one request; another 409 is reported, not retried", async () => {
      const ok = page({ first: resp(200, { deleted: true }), confirms: [true] });
      await ok.ctx.run(5, "Cash");
      assert.equal(ok.calls.fetch.length, 1);
      assert.equal(ok.calls.reloads, 1);
      const other = page({ first: resp(409, { error: "busy" }), confirms: [true] });
      await other.ctx.run(5, "Cash");
      assert.equal(other.calls.fetch.length, 1);
      assert.deepEqual(other.calls.status, ["Could not remove Cash"]);
    });
  });
});

// ---------------------------------------------------------------------------
describe("F15 — a generic CSV with separate Debit / Credit columns", () => {
  const csv = require("../teller/data/csv-formats");
  const parse = (row, opts) => csv.CSV_FORMATS.generic.parse(row, null, opts).amount;

  it("money out is positive, money in negative — a credit row is no longer $0", () => {
    assert.equal(parse({ Date: "2026-11-01", Description: "PAYROLL", Debit: "", Credit: "2,100.00", Balance: "5000" }), -2100);
    assert.equal(parse({ Date: "2026-11-02", Description: "GROCER", Debit: "45.10", Credit: "", Balance: "4954.90" }), 45.1);
  });

  it("Credit before Debit: a paycheck is not imported as spending", () => {
    assert.equal(parse({ Date: "2026-11-01", Description: "PAYROLL", Credit: "2100.00", Debit: "" }), -2100);
    assert.equal(parse({ Date: "2026-11-02", Description: "GROCER", Credit: "", Debit: "45.10" }), 45.1);
  });

  it("a debit column printed negative, parentheses, both cells filled, both blank", () => {
    assert.equal(parse({ Date: "d", Description: "x", Debit: "-45.10", Credit: "" }), 45.1);
    assert.equal(parse({ Date: "d", Description: "x", Debit: "($12.00)", Credit: "" }), 12);
    assert.equal(parse({ Date: "d", Description: "x", Debit: "10.00", Credit: "2.50" }), 7.5);
    assert.ok(Number.isNaN(parse({ Date: "d", Description: "x", Debit: "", Credit: "" })), "unparseable, as a blank amount always was");
  });

  it("the columns say the direction, so positive_means changes nothing", () => {
    const row = { Date: "d", Description: "PAYROLL", Debit: "", Credit: "2100" };
    assert.equal(parse(row, { positiveMeans: "deposits" }), -2100);
    assert.equal(parse(row, { positiveMeans: "charges" }), -2100);
  });

  it("other spellings: Withdrawals / Deposits, Money Out / Money In, any case", () => {
    assert.equal(parse({ Date: "d", Description: "x", Withdrawals: "30", Deposits: "" }), 30);
    assert.equal(parse({ Date: "d", Description: "x", "MONEY OUT": "", "money in": "75" }), -75);
    assert.equal(parse({ Date: "d", Description: "x", "Debit Amount": "9.99", "Credit Amount": "" }), 9.99);
  });

  it("isTwoColumnGeneric: both columns and no Amount column", () => {
    assert.equal(csv.isTwoColumnGeneric(["Date", "Description", "Debit", "Credit", "Balance"]), true);
    assert.equal(csv.isTwoColumnGeneric(["Date", "Description", "Amount", "Debit", "Credit"]), false);
    assert.equal(csv.isTwoColumnGeneric(["Date", "Description", "Debit"]), false);
    assert.equal(csv.isTwoColumnGeneric(["Date", "Description", "Credit Card", "Debit Memo"]), false, "whole column names only");
    assert.deepEqual(csv.twoColumnKeys(["Date", " credit ", "DEBIT"]), { debit: "DEBIT", credit: " credit " });
  });

  it("one-column files are read as before: Amount wins, a lone Debit column, positive_means applies", () => {
    assert.equal(parse({ Date: "d", Description: "x", Amount: "12.50", Debit: "", Credit: "3" }), 12.5);
    assert.equal(parse({ Date: "d", Description: "x", Debit: "12.50" }), 12.5);
    assert.equal(parse({ Date: "d", Description: "x", Amount: "12.50" }, { positiveMeans: "deposits" }), -12.5);
  });

  it("a two-column file is still the generic format, and its sign guess is 'charges'", () => {
    const headers = ["Date", "Description", "Debit", "Credit", "Balance"];
    assert.equal(csv.detectCsvFormat(headers), "generic");
    assert.equal(csv.guessGenericSign([
      { Date: "d", Description: "PAYROLL", Debit: "", Credit: "2100" },
      { Date: "d", Description: "GROCER", Debit: "45", Credit: "" },
    ]), "charges");
  });

  it("the route and the CLI give such a file no sign choice; the forms hide it", () => {
    const route = read("teller/routes/subscriptions.js");
    assert.match(route, /const generic = formatName === "generic" && !isTwoColumnGeneric\(headers\);/);
    const cli = read("scripts/import-csv-cli.js");
    assert.match(cli, /const signUnknown = format === "generic" && !isTwoColumnGeneric\(Object\.keys\(records\[0\] \|\| \{\}\)\);/);
    assert.match(cli, /positiveMeans: signUnknown \? \(opts\.positiveMeans \|\| "charges"\) : null/);
    for (const f of ["teller/views/accounts.ejs", "teller/views/dashboard.ejs"]) {
      assert.match(read(f), /var signUnknown = (d|data)\.format_detected === 'generic' && (d|data)\.positive_means != null;/, f);
    }
  });

  it("POST /api/import-csv/preview: a Debit / Credit file reports both rows with their signs and positive_means null", async () => {
    install(async () => undefined);
    const subs = require("../teller/routes/subscriptions");
    const file = "Date,Description,Debit,Credit,Balance\n2026-11-01,ACME PAYROLL,,2100.00,5000.00\n2026-11-02,GROCER,45.10,,4954.90\n";
    const res = await supertest(app(subs)).post("/api/import-csv/preview").attach("file", Buffer.from(file), "bank.csv").expect(200);
    assert.equal(res.body.format_detected, "generic");
    assert.equal(res.body.positive_means, null);
    assert.equal(res.body.sign_guess, null);
    assert.equal(res.body.rows_parseable, 2, "the credit row used to be skipped as $0");
    assert.equal(res.body.rows_skipped, 0);
    assert.deepEqual(res.body.sample.map((r) => Number(r.amount)), [-2100, 45.1]);
  });
});

// ---------------------------------------------------------------------------
describe("F16 — a Plaid row first inserted through `modified`", () => {
  const txn = (id) => ({ transaction_id: id, account_id: "pacc_1", amount: 21.5, date: "2026-06-10", name: "Store " + id, category: ["Shops"] });
  function run(delivery, existing = []) {
    const have = new Set(existing);
    install(async (sql, params) => {
      if (sql.includes("SELECT cursor FROM sync_cursors")) return { rows: [{ cursor: "c0" }] };
      if (sql.includes("INSERT INTO transactions") && sql.includes("RETURNING (xmax = 0)")) {
        const fresh = !have.has(params[1]);
        have.add(params[1]);
        return { rows: [{ inserted: fresh }], rowCount: 1 };
      }
    });
    const client = { transactionsSync: async () => ({ data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false, ...delivery } }) };
    return inv.syncPlaidItemTransactions(client, 1, "tok");
  }

  it("counts as added (so the rename rules, the anomaly check and Paycheck landed run), not as modified", async () => {
    const r = await run({ modified: [txn("m1")] });
    assert.equal(r.added, 1, "it was 0 — runPostSyncSteps(0) does nothing");
    assert.equal(r.modified, 0);
  });

  it("a modified row that was already here is still only modified; a mix counts each once", async () => {
    const r = await run({ added: [txn("a1")], modified: [txn("m1"), txn("m2")] }, ["m2"]);
    assert.equal(r.added, 2, "a1 and the new m1");
    assert.equal(r.modified, 1, "m2");
  });

  it("a second delivery of the same modified row adds nothing (INV-01)", async () => {
    const have = ["m1"];
    const r = await run({ modified: [txn("m1")] }, have);
    assert.equal(r.added, 0);
    assert.equal(r.modified, 1);
  });

  it("a tombstoned row (nothing written) is neither", async () => {
    install(async (sql) => {
      if (sql.includes("SELECT cursor FROM sync_cursors")) return { rows: [{ cursor: "c0" }] };
      if (sql.includes("INSERT INTO transactions")) return { rows: [], rowCount: 0 };
    });
    const client = { transactionsSync: async () => ({ data: { added: [], modified: [txn("gone")], removed: [], next_cursor: "c1", has_more: false } }) };
    const r = await inv.syncPlaidItemTransactions(client, 1, "tok");
    assert.equal(r.added, 0);
    assert.equal(ran(/UPDATE deleted_transactions SET bank_changed_at/).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("F17 — unlinking an investments-only connection whose token can't be read", () => {
  it("the duplicate guard needs a registered connection at that institution", async () => {
    install(async () => undefined);
    const r = await inv.findDuplicateInvestmentItem({ itemId: "new_item", institutionId: "ins_1", institutionName: "Broker",
      accounts: [{ account_id: "new_acc", mask: "1234", type: "investment", subtype: "brokerage" }] });
    assert.equal(r, null);
    const q = ran(/FROM investment_accounts ia/)[0];
    assert.match(q.sql, /\n\s+JOIN plaid_investment_items pii\s+ON LOWER\(pii\.institution_name\) = LOWER\(ia\.institution\) AND pii\.item_id <> \$1/);
    assert.doesNotMatch(q.sql, /LEFT JOIN plaid_investment_items/, "accounts with no connection left used to match");
  });

  const unlinkDb = ({ token = null, others = [], byName = [{ plaid_account_id: "old_a" }, { plaid_account_id: "old_b" }] } = {}) => async (sql) => {
    if (/FROM plaid_investment_items WHERE id = \$1/.test(sql) && /perfin_try_decrypt/.test(sql)) return { rows: [{ id: 9, item_id: "it_9", institution_name: "Broker", access_token: token }] };
    if (/SELECT 1 FROM plaid_investment_items WHERE id <> \$1/.test(sql)) return { rows: others };
    if (/SELECT plaid_account_id FROM investment_accounts WHERE is_active/.test(sql)) return { rows: byName };
    if (/^UPDATE investment_accounts SET is_active = false/.test(sql)) return { rows: [], rowCount: 2 };
  };

  it("deactivates the institution's Plaid investment accounts and drops their holdings", async () => {
    install(unlinkDb());
    const res = await supertest(app(inv)).delete("/api/plaid/investment-items/9").expect(200);
    assert.deepEqual(res.body, { deleted: true, plaid_item_removed: false, accounts_deactivated: 2 });
    assert.deepEqual(ran(/SELECT plaid_account_id FROM investment_accounts/)[0].params, ["Broker"]);
    assert.deepEqual(ran(/^DELETE FROM investment_holdings/)[0].params, [["old_a", "old_b"]]);
    assert.deepEqual(ran(/^UPDATE investment_accounts SET is_active = false/)[0].params, [["old_a", "old_b"]]);
    assert.equal(ran(/^DELETE FROM plaid_investment_items WHERE id = \$1/).length, 1);
    assert.ok(idx(/^BEGIN$/) < idx(/SELECT 1 FROM plaid_investment_items WHERE id <> \$1/) && idx(/^UPDATE investment_accounts/) < idx(/^COMMIT$/), "inside the unlink's transaction");
  });

  it("another connection at the same institution → nothing is guessed", async () => {
    install(unlinkDb({ others: [{ "?column?": 1 }] }));
    const res = await supertest(app(inv)).delete("/api/plaid/investment-items/9").expect(200);
    assert.equal(res.body.accounts_deactivated, 0);
    assert.equal(ran(/SELECT plaid_account_id FROM investment_accounts/).length, 0);
    assert.equal(ran(/^UPDATE investment_accounts/).length, 0);
    assert.equal(ran(/^DELETE FROM plaid_investment_items WHERE id = \$1/).length, 1, "the connection is still removed");
    const q = ran(/SELECT 1 FROM plaid_investment_items WHERE id <> \$1/)[0];
    assert.match(q.sql, /SELECT 1 FROM plaid_items WHERE status = 'GOOD' AND item_id <> \$3 AND LOWER\(institution_name\) = LOWER\(\$2::text\)/);
    assert.deepEqual(q.params, [9, "Broker", "it_9"]);
  });

  it("with a readable token the account list still comes from Plaid, not from the name", async () => {
    install(unlinkDb({ token: "tok" }));
    S.plaid = {
      accountsGet: async () => ({ data: { accounts: [{ account_id: "real_a" }] } }),
      itemRemove: async () => ({}),
    };
    const res = await supertest(app(inv)).delete("/api/plaid/investment-items/9").expect(200);
    assert.equal(res.body.plaid_item_removed, true);
    assert.equal(ran(/SELECT plaid_account_id FROM investment_accounts/).length, 0);
    assert.deepEqual(ran(/^UPDATE investment_accounts SET is_active = false/)[0].params, [["real_a"]]);
  });
});

// ---------------------------------------------------------------------------
describe("F18 — sync bookkeeping", () => {
  it("transactionRunSynced: a connection synced, or a clean run with nothing to do — not a run of failures", () => {
    assert.equal(enr.transactionRunSynced({ enrollments_synced: 2, errors: [{ error: "x" }] }), true, "partly synced still moved data");
    assert.equal(enr.transactionRunSynced({ enrollments_synced: 0 }), true, "nothing connected, nothing failed");
    assert.equal(enr.transactionRunSynced({ enrollments_synced: 0, errors: [] }), true);
    assert.equal(enr.transactionRunSynced({ enrollments_synced: 0, errors: [{ provider: "teller", error: "decryption_failed" }] }), false);
    assert.equal(enr.transactionRunSynced(null), false);
  });

  const stampSql = /UPDATE user_settings SET last_txn_sync_at = now\(\)/;
  it("a run in which the only connection failed doesn't stamp last_txn_sync_at (and still records its error)", async () => {
    install(async (sql) => {
      if (sql.includes("FROM teller_enrollments te") && sql.includes("status != 'SUSPENDED'")) {
        return { rows: [{ id: 7, enrollment_id: "enr_7", institution_name: "TestBank", access_token: null, last_synced_txn_date: null, status: "GOOD" }] };
      }
    });
    const orig = console.error; console.error = () => {};
    let r;
    try { r = await enr.runTransactionSync(); } finally { console.error = orig; }
    assert.equal(r.status, 200, "Plaid isn't configured, Teller reported its error — not the nothing-ran 500");
    assert.deepEqual(r.body.errors, [{ provider: "teller", institution: "TestBank", error: "decryption_failed" }]);
    assert.equal(ran(stampSql).length, 0, "it used to stamp the badge's basis fresh");
    const written = JSON.parse(ran(/^UPDATE user_settings SET last_sync_result/)[0].params[0]);
    assert.equal(written.errors[0].error, "decryption_failed");
  });

  it("a clean run with no connections still stamps it", async () => {
    install(async () => undefined);
    const r = await enr.runTransactionSync();
    assert.equal(r.status, 200);
    assert.equal(ran(stampSql).length, 1);
  });

  it("recordSyncResult: a failed read of the stored map writes nothing and returns this run's own outcome", async () => {
    install(async (sql) => {
      if (/^SELECT last_sync_result FROM user_settings/.test(sql)) throw new Error("connection terminated");
    });
    const orig = console.error; const logged = []; console.error = (...a) => logged.push(a.join(" "));
    let out;
    try {
      out = await enr.recordSyncResult([
        { provider: "plaid_txn", result: { errors: [{ institution: "Capital", error: "ITEM_LOGIN_REQUIRED" }] } },
        { provider: "teller_txn", result: { enrollments_synced: 1 } },
        { provider: "plaid_holdings", result: null },
      ]);
    } finally { console.error = orig; }
    assert.equal(ran(/^UPDATE user_settings SET last_sync_result/).length, 0, "it used to write a map holding only this call's providers");
    assert.equal(out.recorded, false);
    assert.deepEqual(out.errors, [{ provider: "plaid_txn", institution: "Capital", error: "ITEM_LOGIN_REQUIRED" }]);
    assert.deepEqual(Object.keys(out.providers).sort(), ["plaid_txn", "teller_txn"]);
    assert.ok(logged.some((l) => /this run's outcome was not recorded/.test(l)));
  });

  it("recordSyncResult: with the map read, the other providers' errors are kept", async () => {
    const stored = { at: "x", errors: [], providers: { teller_balance: { at: "x", errors: [{ provider: "teller_balance", institution: "Chase", error: "decryption_failed" }] } } };
    install(async (sql) => (/^SELECT last_sync_result FROM user_settings/.test(sql) ? { rows: [{ last_sync_result: stored }] } : undefined));
    const out = await enr.recordSyncResult([{ provider: "plaid_txn", result: { errors: [] } }]);
    const written = JSON.parse(ran(/^UPDATE user_settings SET last_sync_result/)[0].params[0]);
    assert.deepEqual(Object.keys(written.providers).sort(), ["plaid_txn", "teller_balance"]);
    assert.equal(written.errors.length, 1);
    assert.equal(out.recorded, undefined);
  });

  it("a Teller webhook sync that came back partial fails its event — after the post-sync steps", async () => {
    const { createTellerEventHandler } = require("../teller/routes/teller-webhook-events");
    const calls = [];
    const h = createTellerEventHandler({
      db: { query: async () => ({ rows: [{ id: 7, institution_name: "Chase", status: "GOOD" }] }) },
      syncEnrollment: async () => ({ ok: true, added: 2, failed: false, errors: [{ institution: "Chase", error: "partial_sync_incomplete" }] }),
      postSync: async (n) => { calls.push(n); },
      notify: async () => {},
    });
    await assert.rejects(() => h({ type: "transactions.processed", subject: "enr_7", account_ids: [] }), /Teller enrollment sync failed/);
    assert.deepEqual(calls, [2], "the rows it did add are still named and checked");
  });

  it("a clean Teller webhook sync (errors: []) is still done", async () => {
    const { createTellerEventHandler } = require("../teller/routes/teller-webhook-events");
    const h = createTellerEventHandler({
      db: { query: async () => ({ rows: [{ id: 7, institution_name: "Chase", status: "GOOD" }] }) },
      syncEnrollment: async () => ({ ok: true, added: 0, failed: false, errors: [] }),
      postSync: async () => {}, notify: async () => {},
    });
    assert.deepEqual(await h({ type: "transactions.processed", subject: "enr_7", account_ids: [] }), { status: "done" });
  });

  it("a Plaid webhook sync that came back partial fails its event; a clean one is done", async () => {
    const { createPlaidEventHandler } = require("../teller/routes/plaid-webhook-events");
    const make = (result, calls = []) => createPlaidEventHandler({
      db: { query: async () => ({ rows: [{ kind: "txn", id: 7, institution_name: "Capital Bank" }] }) },
      syncItem: async () => result,
      postSync: async (n) => { calls.push(n); },
    });
    const ev = { type: "TRANSACTIONS", code: "SYNC_UPDATES_AVAILABLE", subject: "it_7" };
    const calls = [];
    await assert.rejects(() => make({ ok: true, added: 1, failed: false, errors: [{ institution: "Capital Bank", error: "partial_sync_incomplete" }] }, calls)(ev, { id: 1, provider: "plaid" }), /Plaid item sync failed/);
    assert.deepEqual(calls, [1]);
    assert.deepEqual(await make({ ok: true, added: 1, failed: false, errors: [] })(ev, { id: 1, provider: "plaid" }), { status: "done" });
  });
});

// ---------------------------------------------------------------------------
describe("F19 — the Plaid webhook dedupe key", () => {
  const verify = require("../teller/services/webhook-verify");
  const KID = "kid-b7";
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const client = { async webhookVerificationKeyGet() { return { data: { key: { ...jwk, alg: "ES256", kid: KID, use: "sig", created_at: 1, expired_at: null } } }; } };
  const req = (token) => ({ headers: { "plaid-verification": token }, rawBody: Buffer.from(BODY), body: JSON.parse(BODY) });
  function signed(iat = Math.floor(Date.now() / 1000)) {
    const h = b64u({ alg: "ES256", kid: KID, typ: "JWT" });
    const p = b64u({ iat, request_body_sha256: crypto.createHash("sha256").update(BODY).digest("hex") });
    const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return { h, p, sig };
  }
  // The other valid encoding of the same ECDSA signature: (r, n − s).
  const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
  function flipped(sig) {
    const r = sig.subarray(0, 32);
    const s = BigInt("0x" + sig.subarray(32).toString("hex"));
    return Buffer.concat([r, Buffer.from((N - s).toString(16).padStart(64, "0"), "hex")]);
  }

  it("the same delivery with its signature re-encoded verifies — and has the same key, so it is a duplicate", async () => {
    const v = verify.createPlaidVerifier({ getClient: () => client });
    const { h, p, sig } = signed();
    const a = await v.verify(req(`${h}.${p}.${sig.toString("base64url")}`));
    const b = await v.verify(req(`${h}.${p}.${flipped(sig).toString("base64url")}`));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true, "the re-encoded signature is a valid one — which is why the key can't include it");
    assert.equal(a.dedupeKey, b.dedupeKey, "under the whole-token hash these differed, and the replay was processed again");
    assert.equal(a.dedupeKey, "jwt:" + crypto.createHash("sha256").update(`${h}.${p}`).digest("hex"));
  });

  it("two different deliveries (another second) still have different keys", async () => {
    const v = verify.createPlaidVerifier({ getClient: () => client });
    const now = Math.floor(Date.now() / 1000);
    const one = signed(now), two = signed(now - 1);
    const a = await v.verify(req(`${one.h}.${one.p}.${one.sig.toString("base64url")}`));
    const b = await v.verify(req(`${two.h}.${two.p}.${two.sig.toString("base64url")}`));
    assert.equal(a.ok && b.ok, true);
    assert.notEqual(a.dedupeKey, b.dedupeKey);
  });
});

// ---------------------------------------------------------------------------
describe("F35 — re-linking a goal keeps its progress", () => {
  const goals = () => require("../teller/routes/goals");
  // A goal that had $500 by hand, later linked to account 1 ($5,000, baseline
  // $2,000 → $3,000 of progress).
  const LINKED = { current_amount: "500", funding_account_id: 1, funding_investment_id: null, goal_baseline_amount: "2000",
    funding_account_name: "Savings", funding_account_balance: "5000", funding_investment_name: null, funding_investment_balance: null };
  function db(goalRow, balances = { 1: "5000", 2: "10000" }, invBalances = { 4: "20000" }) {
    return async (sql, params) => {
      if (/FROM linked_accounts WHERE id = \$1/.test(sql)) return { rows: balances[params[0]] ? [{ balance: balances[params[0]] }] : [] };
      if (/^SELECT balance FROM investment_accounts WHERE id = \$1/.test(sql)) return { rows: invBalances[params[0]] ? [{ balance: invBalances[params[0]] }] : [] };
      if (/FROM financial_goals g/.test(sql)) return { rows: goalRow ? [goalRow] : [] };
      if (/^UPDATE financial_goals SET/.test(sql)) return { rows: [{ id: 3 }] };
    };
  }
  const update = () => ran(/^UPDATE financial_goals SET/)[0];
  const baselineOf = () => { const u = update(); const m = /"goal_baseline_amount" = \$(\d+)/.exec(u.sql); return m ? u.params[Number(m[1]) - 1] : undefined; };

  it("to another account: the baseline keeps the $3,000 of derived progress (it reset to the pre-link $500)", async () => {
    install(db(LINKED));
    await supertest(app(goals())).patch("/api/goals/3").send({ funding_account_id: 2 }).expect(200);
    assert.equal(baselineOf(), 7000, "$10,000 − $3,000; it was $9,500 ($10,000 − the stored $500)");
    const read = ran(/FROM financial_goals g/)[0];
    assert.match(read.sql, /COALESCE\(la\.available_balance, la\.current_balance\) AS funding_account_balance/);
    assert.match(read.sql, /LEFT JOIN investment_accounts ia ON ia\.id = g\.funding_investment_id/);
  });

  it("saving the same link again changes nothing", async () => {
    install(db(LINKED));
    await supertest(app(goals())).patch("/api/goals/3").send({ funding_account_id: 1 }).expect(200);
    assert.equal(baselineOf(), 2000);
  });

  it("from an account to an investment account", async () => {
    install(db(LINKED));
    await supertest(app(goals())).patch("/api/goals/3").send({ funding_account_id: null, funding_investment_id: 4 }).expect(200);
    assert.equal(baselineOf(), 17000, "$20,000 − $3,000");
  });

  it("a first link still starts from the stored amount; an orphaned link falls back to it too", async () => {
    install(db({ ...LINKED, funding_account_id: null, goal_baseline_amount: null, funding_account_balance: null }));
    await supertest(app(goals())).patch("/api/goals/3").send({ funding_account_id: 2 }).expect(200);
    assert.equal(baselineOf(), 9500);
    install(db({ ...LINKED, funding_account_balance: null }));
    await supertest(app(goals())).patch("/api/goals/3").send({ funding_account_id: 2 }).expect(200);
    assert.equal(baselineOf(), 9500, "the old account is gone, so the stored amount is all there is");
  });

  it("a supplied baseline is used as given; a missing account still drops the link", async () => {
    install(db(LINKED));
    await supertest(app(goals())).patch("/api/goals/3").send({ funding_account_id: 2, goal_baseline_amount: 1234 }).expect(200);
    assert.equal(baselineOf(), 1234);
    assert.equal(ran(/FROM financial_goals g/).length, 0);
    install(db(LINKED));
    const orig = console.error; console.error = () => {};
    try { await supertest(app(goals())).patch("/api/goals/3").send({ funding_account_id: 99 }).expect(400); }
    finally { console.error = orig; }
    assert.equal(ran(/^UPDATE financial_goals SET/).length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("F36 — the budget alert takes last month's snapshot itself", () => {
  const fq = require("../teller/services/financial-queries");
  const notifications = require("../teller/routes/notifications");
  const startup = require("../teller/startup");
  const month = fq.currentMonth();
  const prev = fq.previousMonthKey(month);

  // One rollover budget of $100: $50 spent last month, $120 this month.
  async function runWith({ rollover = true, snapshotExists = false, failSnapshot = false } = {}) {
    const sent = [];
    let snap = snapshotExists ? [{ budget_id: 1, rollover_amount: "50" }] : [];
    const origSend = notifications.sendToAll, origRecent = notifications.sentRecently;
    notifications.sendToAll = async (p) => { sent.push(p); return { logged: true }; };
    notifications.sentRecently = async () => false;
    install(async (sql, params) => {
      if (/SELECT \* FROM budgets/.test(sql)) return { rows: [{ id: 1, category: "Dining", monthly_limit: "100", rollover_enabled: rollover, budget_type: "recurring", effective_month: null, created_at: new Date("2025-01-05T12:00:00Z") }] };
      if (/net_category_months/.test(sql)) return { rows: [{ category: "Dining", spent: String(params[0]).slice(0, 7) === prev ? "50" : "120" }] };
      if (/^INSERT INTO budget_snapshots/.test(sql)) {
        if (failSnapshot) throw new Error("deadlock");
        snap = [{ budget_id: params[0], rollover_amount: String(params[4]) }];
        return { rows: [], rowCount: 1 };
      }
      if (/FROM budget_snapshots WHERE month = \$1/.test(sql)) return { rows: params[0] === prev ? snap : [] };
    });
    const orig = console.error; const logged = []; console.error = (...a) => logged.push(a.join(" "));
    try { await startup._awayJobs.runBudgetAlertTick(); }
    finally { notifications.sendToAll = origSend; notifications.sentRecently = origRecent; console.error = orig; }
    return { sent, logged };
  }

  it("no snapshot yet (the user was away over the month end): it is taken, and the alert uses the rolled-over limit", async () => {
    const { sent } = await runWith();
    const insert = ran(/^INSERT INTO budget_snapshots/);
    assert.equal(insert.length, 1);
    assert.deepEqual(insert[0].params.slice(0, 5), [1, prev, 100, 50, 50], "last month: $100 limit, $50 spent, $50 carried");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "Budget warning: Dining", "$120 of $150 — it used to push 'Budget exceeded' at $100");
    assert.match(sent[0].body, /\$120\.00 of \$150\.00 \(80%/);
  });

  it("a budget without rollover takes no snapshot here", async () => {
    const { sent } = await runWith({ rollover: false });
    assert.equal(ran(/budget_snapshots WHERE month = \$1 LIMIT 1|^INSERT INTO budget_snapshots/).length, 0);
    assert.equal(sent[0].title, "Budget exceeded: Dining");
  });

  it("when the snapshot can't be written the alert still goes out on what it has, and says why in the log", async () => {
    const { sent, logged } = await runWith({ failSnapshot: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "Budget exceeded: Dining");
    assert.ok(logged.some((l) => /Budget alert: last month's snapshot couldn't be taken: deadlock/.test(l)));
  });

  it("the tick calls the one snapshot writer — it adds no budget_snapshots SQL of its own", () => {
    const src = read("teller/startup.js");
    assert.match(src, /require\("\.\/routes\/budgets"\)\.runBudgetSnapshot\(pool\)/);
    assert.doesNotMatch(src, /INSERT INTO budget_snapshots/);
  });
});
