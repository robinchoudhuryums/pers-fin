// Real-Postgres contract tests: the Teller and Plaid SYNC ENGINES and the AI
// paths (insights generation + audit, categorize), with only the outside world
// stubbed — Teller's HTTP client, a Plaid client object and the Anthropic SDK.
// Everything else (upserts, watermarks, cursors, snapshots, the insight
// prompt's ~40 queries, the audit, the usage rows) runs against a real schema.
// Closes the "no contract coverage for the sync engines / insights" gap left
// by Batch 15.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

// --- Anthropic stub: a queue of canned responses -------------------------
const anthropicQueue = [];
class FakeAnthropic {
  constructor() {
    this.messages = { create: async () => {
      const r = anthropicQueue.shift();
      if (!r) throw new Error("FakeAnthropic: response queue empty");
      return r;
    } };
  }
}
const toolReply = (name, input) => ({
  content: [{ type: "tool_use", id: "tu_1", name, input }],
  stop_reason: "tool_use",
  usage: { input_tokens: 1200, output_tokens: 300 },
});

// --- Teller stub ------------------------------------------------------------
const TELLER_TXNS = [
  { id: "tt1", amount: "-12.34", date: "", description: "CAFE LUNA", status: "posted", details: { counterparty: { name: "Cafe Luna" }, category: "dining" } },
  { id: "tt2", amount: "-50.00", date: "", description: "SAFEWAY #12", status: "posted", details: { category: "groceries" } },
  { id: "tt3", amount: "2500.00", date: "", description: "ACME PAYROLL DIRECT DEP", status: "posted", details: {} },
  { id: "tt4", amount: "-8.00", date: "", description: "PENDING THING", status: "pending" },
];

describe("sync engines + AI on real Postgres", { skip: SKIP }, () => {
  let pool, app, enrollments, investments, insights, tellerApi, originalLoad, today;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;

  before(async () => {
    process.env.ANTHROPIC_API_KEY = "contract-test-key";
    originalLoad = Module._load;
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    pool = await perfinDb("syncai");
    today = require("../../teller/services/financial-queries").todayStr();
    for (const t of TELLER_TXNS) t.date = today;

    tellerApi = require("../../teller/services/teller-api");
    tellerApi.tellerRequest = async (endpoint) => {
      if (endpoint === "/accounts") return [{ id: "tacc", name: "Checking", type: "depository", subtype: "checking", last_four: "1234" }];
      if (endpoint.endsWith("/balances")) return { account_id: "tacc", ledger: "1500.25", available: "1450.00" };
      if (endpoint.includes("/transactions")) return endpoint.includes("from_id") ? [] : TELLER_TXNS.slice();
      throw new Error("unexpected Teller endpoint " + endpoint);
    };
    // Modules destructure tellerRequest at require time — require them AFTER the stub.
    enrollments = require("../../teller/routes/enrollments");
    investments = require("../../teller/routes/investments");
    insights = require("../../teller/routes/insights");
    app = perfinApp();

    await q("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc) VALUES ('enr_1','Bank', pgp_sym_encrypt('tok', $1))", [PASS()]);
    const enr = (await q("SELECT id FROM teller_enrollments")).rows[0].id;
    await q("INSERT INTO linked_accounts (teller_enrollment_id, account_id, name, type, subtype) VALUES ($1,'tacc','Checking','depository','checking')", [enr]);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('pitem','Card Co', pgp_sym_encrypt('ptok', $1), 'GOOD')", [PASS()]);
    const item = (await q("SELECT id FROM plaid_items WHERE item_id='pitem'")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype) VALUES ($1,'pacc','Card','credit','credit card')", [item]);
    await q("INSERT INTO sync_cursors (plaid_item_id, cursor) VALUES ($1, '')", [item]); // as the exchange does
  });

  after(async () => {
    if (originalLoad) Module._load = originalLoad;
    if (pool) await pool.end();
  });

  // ------------------------------------------------------------------ Teller
  it("Teller: first sync inserts posted rows with Plaid-convention signs; a re-sync adds 0", async () => {
    const r1 = await enrollments.syncAllEnrollments();
    assert.equal(r1.transactions_added, 3, JSON.stringify(r1));
    const rows = (await q("SELECT transaction_id, amount::float AS amount, merchant_name, category FROM transactions WHERE account_id='tacc' ORDER BY 1")).rows;
    assert.deepEqual(rows.map((x) => [x.transaction_id, x.amount]), [["tt1", 12.34], ["tt2", 50], ["tt3", -2500]]);
    assert.equal(rows[0].merchant_name, "Cafe Luna");
    assert.deepEqual(rows[0].category, ["dining"]);
    const wm = (await q("SELECT last_synced_txn_date::text AS d FROM teller_enrollments")).rows[0].d;
    assert.equal(wm, today);

    const r2 = await enrollments.syncAllEnrollments();
    assert.equal(r2.transactions_added, 0, "INV-01/INV-54: a re-sync counts no inserts");
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM transactions WHERE account_id='tacc'")).rows[0].n, 3);
  });

  it("Teller: reconcile re-reads the window without adding rows or moving the watermark", async () => {
    const before = (await q("SELECT last_synced_txn_date::text AS d FROM teller_enrollments")).rows[0].d;
    const r = await enrollments.reconcileTeller(90);
    assert.equal(r.transactions_added || 0, 0, JSON.stringify(r));
    assert.equal((await q("SELECT last_synced_txn_date::text AS d FROM teller_enrollments")).rows[0].d, before);
  });

  it("Teller: balance sync writes the balance, a daily snapshot and a net-worth snapshot", async () => {
    const r = await enrollments.syncAllBalances();
    assert.ok(r.accounts_updated >= 1, JSON.stringify(r));
    const la = (await q("SELECT current_balance::float AS c, available_balance::float AS a FROM linked_accounts WHERE account_id='tacc'")).rows[0];
    assert.deepEqual(la, { c: 1500.25, a: 1450 });
    const snap = (await q("SELECT COUNT(*)::int AS n FROM account_balance_snapshots WHERE source='linked'")).rows[0].n;
    assert.ok(snap >= 1);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM net_worth_snapshots")).rows[0].n, 1);
    // A second run with the same balance changes nothing (INV-78's accounts_changed).
    const r2 = await enrollments.syncAllBalances();
    assert.equal(r2.accounts_changed, 0, JSON.stringify(r2));
  });

  it("syncAllTransactions runs Teller (Plaid unconfigured here) and the combined anomaly check", async () => {
    const r = await enrollments.syncAllTransactions();
    assert.equal(r.transactions_added, 0, JSON.stringify(r));
    assert.ok(!(r.errors || []).some((e) => e.provider === "teller"), JSON.stringify(r.errors));
  });

  // ------------------------------------------------------------------- Plaid
  it("Plaid: cursor sync inserts, re-delivers idempotently, upserts modified and deletes removed", async () => {
    const item = (await q("SELECT id FROM plaid_items WHERE item_id='pitem'")).rows[0].id;
    const pages = [
      { added: [
        { account_id: "pacc", transaction_id: "p1", amount: 42.5, date: today, name: "AMAZON MKTP", merchant_name: "Amazon", pending: false, category: ["Shops", "Digital Purchase"], personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES" } },
        { account_id: "pacc", transaction_id: "p2", amount: 9.99, date: today, name: "SPOTIFY", merchant_name: "Spotify", pending: false },
        { account_id: "pacc", transaction_id: "p3", amount: 5, date: today, name: "PENDING", pending: true },
      ], modified: [], removed: [], next_cursor: "c1", has_more: false },
    ];
    let call = 0;
    const client = { transactionsSync: async ({ cursor }) => {
      call++;
      if (cursor === "") return { data: pages[0] };
      if (cursor === "c1" && call === 2) return { data: { added: pages[0].added, modified: [], removed: [], next_cursor: "c1", has_more: false } };
      return { data: {
        added: [],
        modified: [{ account_id: "pacc", transaction_id: "p4", amount: 20, date: today, name: "LATE POSTED", pending: false }],
        removed: [{ transaction_id: "p2" }],
        next_cursor: "c2", has_more: false,
      } };
    } };
    const r1 = await investments.syncPlaidItemTransactions(client, item, "ptok");
    assert.equal(r1.added, 2, JSON.stringify(r1));
    assert.equal((await q("SELECT cursor FROM sync_cursors WHERE plaid_item_id=$1", [item])).rows[0].cursor, "c1");
    const p1 = (await q("SELECT category, personal_finance_category->>'primary' AS pfc FROM transactions WHERE transaction_id='p1'")).rows[0];
    assert.deepEqual(p1, { category: ["Shops", "Digital Purchase"], pfc: "GENERAL_MERCHANDISE" });

    const r2 = await investments.syncPlaidItemTransactions(client, item, "ptok");
    assert.equal(r2.added, 0, "re-delivered rows are not counted (INV-01)");

    await investments.syncPlaidItemTransactions(client, item, "ptok");
    const ids = (await q("SELECT transaction_id FROM transactions WHERE account_id='pacc' ORDER BY 1")).rows.map((x) => x.transaction_id);
    assert.deepEqual(ids, ["p1", "p4"], "p2 removed, p4 inserted from `modified` (F5)");
    assert.equal((await q("SELECT cursor FROM sync_cursors WHERE plaid_item_id=$1", [item])).rows[0].cursor, "c2");
  });

  // ---------------------------------------------------------------------- AI
  it("categorize: free Teller-map pass, then the AI batch, all into user_category with a usage row", async () => {
    await q("INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('pacc','u1',14,$1,'Mystery Merchant','MYSTERY',false)", [today]);
    // Every row the free passes can't map goes to the AI batch (u1 and the Plaid
    // row p4 here); answer for each index the prompt could hold.
    anthropicQueue.push(toolReply("categorize_transactions", { categories: [1, 2, 3, 4, 5].map((index) => ({ index, category: "Shopping" })) }));
    const r = await supertest(app).post("/api/categorize").send({});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = (await q("SELECT transaction_id, user_category, user_category_source, category FROM transactions WHERE transaction_id IN ('tt1','u1') ORDER BY 1")).rows;
    const byId = Object.fromEntries(rows.map((x) => [x.transaction_id, x]));
    assert.equal(byId.tt1.user_category_source, "teller_map");
    assert.ok(byId.tt1.user_category);
    assert.deepEqual(byId.tt1.category, ["dining"], "the provider column is untouched (INV-12)");
    assert.equal(byId.u1.user_category, "Shopping");
    assert.equal(byId.u1.user_category_source, "ai");
    const usage = (await q("SELECT COUNT(*)::int AS n FROM financial_insights WHERE entry_type='categorize'")).rows[0].n;
    assert.equal(usage, 1, "the AI batch charged the shared cap (INV-14)");
  });

  it("generateInsights: every enabled module's queries run on the real schema; the insight is stored, audited and the summary saved", async () => {
    anthropicQueue.push(toolReply("generate_financial_insight", {
      insights_text: "## Overview\nYou spent $50.00 on Groceries this month. Your income looks steady.",
      summary: { trends: [{ category: "Groceries", direction: "stable", magnitude: "flat", since_when: today.slice(0, 7) }], completed_goals: [], pending_actions: [], alerts: [] },
    }));
    const r = await insights.generateInsights();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Array.isArray(r.modules_failed), "generateInsights reports modules_failed");
    assert.deepEqual(r.modules_failed, [], "a module's data query failed on the real schema");
    assert.ok(r.modules_used.length >= 8, `modules ran: ${r.modules_used}`);
    assert.equal(r.summary_status, "updated");
    const ins = (await q("SELECT id, audited_at IS NOT NULL AS audited, audit_incomplete FROM financial_insights WHERE entry_type='insight'")).rows;
    assert.equal(ins.length, 1);
    assert.deepEqual({ audited: ins[0].audited, incomplete: ins[0].audit_incomplete }, { audited: true, incomplete: false }, "all four audit tiers ran");
    const summary = (await q("SELECT insights_running_summary_json AS s FROM user_settings")).rows[0].s;
    assert.equal(summary.trends.length, 1);
    // The read side of the same data.
    const st = (await supertest(app).get("/api/insights/status").expect(200)).body;
    assert.equal(st.running_summary_counts.trends, 1);
    const list = (await supertest(app).get("/api/insights").expect(200)).body;
    assert.ok(JSON.stringify(list).includes("Groceries"));
  });
});
