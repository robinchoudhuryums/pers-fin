// Real-Postgres contract test for the cycle-8 broad scan, Batch 2 — the cash
// forecast's bill list on the real schema:
//  - F7: a recurring transfer whose latest debit landed as a credit on another
//    of your spendable accounts (checking → linked savings) isn't billed; one to
//    a brokerage, or to someone else, still is
//  - F8: a utility autopay from checking is billed; a payment into a linked
//    credit card isn't, whatever its name
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb } = require("./_setup");

describe("Cash forecast bills (cycle-8 F7 / F8) on real Postgres", { skip: SKIP }, () => {
  let pool, add;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("c8_batch2");
    const today = require("../../teller/services/financial-queries").todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);

    const acct = (id, type, subtype) => q(
      "INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance) VALUES ($1,$1,$2,$3,true,1000)",
      [id, type, subtype]);
    await acct("chk", "depository", "checking");
    await acct("sav", "depository", "savings");
    await acct("card", "credit", "credit card");
    await acct("brk", "depository", "brokerage");

    const D = add(-10);
    const txn = (id, account, amount, date, merchant) => q(
      "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ($1,$2,$3,$4,$5,$5,false)",
      [account, id, amount, date, merchant]);
    // F7: checking → linked savings, the credit a day later.
    await txn("x1", "chk", 500, D, "Online Transfer to Savings");
    await txn("x1c", "sav", -500, add(-9), "Online Transfer from Checking");
    // A brokerage contribution: its credit lands on an investment account.
    await txn("x2", "chk", 200, D, "Vanguard");
    await txn("x2c", "brk", -200, D, "Vanguard contribution");
    // Rent "transfer to" someone else: no credit on any linked account.
    await txn("x3", "chk", 1500, D, "Online Transfer to J Smith");
    // F8: a utility autopay (no credit anywhere) and a payment into the linked card.
    await txn("x4", "chk", 180, D, "PGANDE WEB ONLINE AUTOPAY");
    await txn("x5", "chk", 300, D, "ONLINE PMT 4411");
    await txn("x5c", "card", -300, add(-8), "PAYMENT THANK YOU");
    // A debit with a same-amount credit 9 days later is not a mirror.
    await txn("x6", "chk", 75, D, "Transfer to Brokerage Cash");
    await txn("x6c", "sav", -75, add(-1), "Unrelated deposit");

    const xfer = (key, name, amount, type) => q(
      `INSERT INTO recurring_transfers (merchant_key, display_name, amount, cadence_days, first_seen, last_transferred, next_expected, is_active, transfer_type, direction)
       VALUES ($1,$2,$3,30,$4,$5,$6,true,$7,'outgoing')`, [key, name, amount, add(-100), D, add(20), type]);
    await xfer("Online Transfer to Savings", "Online Transfer to Savings", 500, "internal");
    await xfer("Vanguard", "Vanguard", 200, "investment");
    await xfer("Online Transfer to J Smith", "Online Transfer to J Smith", 1500, "internal");
    await xfer("PGANDE WEB ONLINE AUTOPAY", "PGANDE WEB ONLINE AUTOPAY", 180, "bill_payment");
    await xfer("ONLINE PMT 4411", "ONLINE PMT 4411", 300, "bill_payment");
    await xfer("Transfer to Brokerage Cash", "Transfer to Brokerage Cash", 75, "internal");
  });
  after(async () => { if (pool) await pool.end(); });

  it("bills exactly the transfers whose money leaves your spendable cash", async () => {
    const cf = require("../../teller/services/cash-flow");
    const inputs = await cf.getCashFlowInputs(pool);
    assert.deepEqual(inputs.bills.map((b) => b.display_name).sort(), [
      "Online Transfer to J Smith",
      "PGANDE WEB ONLINE AUTOPAY",
      "Transfer to Brokerage Cash",
      "Vanguard",
    ]);
    const moved = inputs.bills.find((b) => b.display_name === "Vanguard");
    assert.equal(moved.moved_between_cash_accounts, false, "a brokerage destination isn't spendable cash");
  });
});
