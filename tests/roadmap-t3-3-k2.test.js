// ============================================================================
// Roadmap T3.3 K2 — the tax documents checklist + its linked tasks
// ============================================================================
// computeSuggestions with each data source injected: a W-2 per payroll source,
// a 1099-INT per institution at ≥ $10 (bank or brokerage, the larger of the
// two — never their sum), a 1099-DIV at ≥ $10 of dividends + distributions, a
// 1099-B per brokerage with a sale, a 1099-R per retirement distribution, the
// 1098 family from the deduction rows (student loan interest is a 1098-E, not
// a 1098-T), one row per issuer case-insensitively, a failing source isolated
// with a fixed sentence. suggestTaxDocuments inserting ON CONFLICT DO NOTHING
// and counting only new rows. getIncomeForYear's aggregation. The routes'
// validation (year, form, ids, booleans, notes, dates), 409s (a duplicate, a
// suggested row deleted) and the linked-task kick. The tax_documents linked
// tasks (past expected_by only, Per-sistant's checks), the Settings source on
// by default and the migration. The real-SQL half (ON CONFLICT on the
// expression index, a dismissed row never re-suggested) is
// tests/contract/tax-documents.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const lt = require("../teller/services/linked-tasks");
const originalKick = lt.kick;
let kicks = [];
afterEach(() => { dbModule.pool.query = originalQuery; lt.kick = originalKick; kicks = []; });

const docs = require("../teller/services/tax-documents");
const fq = require("../teller/services/financial-queries");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const NO_INV = { accounts: [], investment_income: { accounts: [] }, realized_gains: { sales: [] }, retirement: { distributions: [] } };
const deps = ({ income = { by_source: [] }, inv = NO_INV, ded = [] } = {}) => ({
  getIncomeForYear: async () => (income instanceof Error ? Promise.reject(income) : income),
  getInvestmentTaxData: async () => (inv instanceof Error ? Promise.reject(inv) : inv),
  getTaxDeductionTransactions: async () => (ded instanceof Error ? Promise.reject(ded) : ded),
});
const forms = (r) => r.suggestions.map((s) => [s.form, s.issuer]).sort((a, b) => (a.join("|") < b.join("|") ? -1 : a.join("|") > b.join("|") ? 1 : 0));

describe("the year rule and deadlines", () => {
  it("parseTaxYear takes 2000..this year as a number or digit string, nothing else", () => {
    assert.equal(docs.parseTaxYear("2025", "2026-10-26"), 2025);
    assert.equal(docs.parseTaxYear(2026, "2026-10-26"), 2026);
    assert.equal(docs.parseTaxYear(" 2024 ", "2026-10-26"), 2024);
    for (const bad of ["2027", 2027, "1999", "2025.0", "25", "2025abc", "", null, undefined, true, [2025], 2025.5]) {
      assert.equal(docs.parseTaxYear(bad, "2026-10-26"), null, String(bad));
    }
  });

  it("forms usually arrive by Jan 31 of the next year, a 1099-B by Feb 15", () => {
    assert.equal(docs.expectedBy(2025, "W-2"), "2026-01-31");
    assert.equal(docs.expectedBy(2025, "1099-INT"), "2026-01-31");
    assert.equal(docs.expectedBy(2025, "1099-B"), "2026-02-15");
  });
});

describe("computeSuggestions", () => {
  it("a W-2 per payroll source (one per issuer, any case), none for other income kinds", async () => {
    const r = await docs.computeSuggestions(null, 2025, deps({ income: { by_source: [
      { source: "Acme Corp", kind: "wages", institution: "Chase", total: 52000 },
      { source: "ACME CORP", kind: "wages", institution: "Ally Bank", total: 1000 },
      { source: "Side Gig LLC", kind: "other", institution: "Chase", total: 900 },
      { source: "Old Job", kind: "wages", institution: "Chase", total: 0 },
    ] } }));
    assert.deepEqual(forms(r), [["W-2", "Acme Corp"]]);
    assert.equal(r.suggestions[0].expected_by, "2026-01-31");
    assert.match(r.suggestions[0].reason, /\$53,000\.00 of pay from Acme Corp in 2025/);
    assert.deepEqual(r.errors, []);
  });

  it("a 1099-INT per institution at $10 or more — the larger of bank and brokerage interest, not their sum", async () => {
    const r = await docs.computeSuggestions(null, 2025, deps({
      income: { by_source: [
        { source: "INTEREST PAYMENT", kind: "interest", institution: "Ally Bank", total: 12.4 },
        { source: "INTEREST", kind: "interest", institution: "Tiny CU", total: 6 },
        { source: "INTEREST", kind: "interest", institution: "Broker Co", total: 6 },
      ] },
      inv: { ...NO_INV, accounts: [{ id: 1, name: "Brokerage", institution: "Broker Co" }, { id: 2, name: "Other", institution: "Second Broker" }],
        investment_income: { accounts: [
          { investment_account_id: 1, account_name: "Brokerage", institution: "Broker Co", interest: 6, dividends: 0 },
          { investment_account_id: 2, account_name: "Other", institution: "Second Broker", interest: 15, dividends: 0 },
        ] } },
    }));
    assert.deepEqual(forms(r), [["1099-INT", "Ally Bank"], ["1099-INT", "Second Broker"]]);
  });

  it("a 1099-DIV at $10 of dividends + capital-gain distributions; a 1099-B per brokerage with sales; a 1099-R per distribution", async () => {
    const r = await docs.computeSuggestions(null, 2025, deps({ inv: {
      accounts: [{ id: 1, name: "Brokerage", institution: "Fidelity" }, { id: 2, name: "Joint", institution: "Vanguard" }, { id: 3, name: "Work 401k", institution: "Fidelity" }],
      investment_income: { accounts: [
        { investment_account_id: 1, account_name: "Brokerage", institution: "Fidelity", dividends: 8, capital_gain_distributions_long: 3, capital_gain_distributions_short: 0, interest: 0 },
        { investment_account_id: 2, account_name: "Joint", institution: "Vanguard", dividends: 9.99, capital_gain_distributions_long: 0, capital_gain_distributions_short: 0, interest: 0 },
      ] },
      realized_gains: { sales: [
        { investment_account_id: 1, account_name: "Brokerage", proceeds: 2400 },
        { investment_account_id: 1, account_name: "Brokerage", proceeds: 600 },
      ] },
      retirement: { distributions: [{ investment_account_id: 3, account_name: "Work 401k", institution: "Fidelity", amount: 600 }] },
    } }));
    assert.deepEqual(forms(r), [["1099-B", "Fidelity"], ["1099-DIV", "Fidelity"], ["1099-R", "Fidelity"]]);
    const b = r.suggestions.find((s) => s.form === "1099-B");
    assert.equal(b.expected_by, "2026-02-15");
    assert.match(b.reason, /2 sales in 2025 \(\$3,000\.00 of proceeds\)/);
  });

  it("the 1098 family from the deduction rows; other deductions add nothing", async () => {
    const r = await docs.computeSuggestions(null, 2025, deps({ ded: [
      { merchant: "Bank Mortgage Interest", amount: 900 },
      { merchant: "Navient Student Loan Interest", amount: 120 },
      { merchant: "State University Tuition", amount: 4000 },
      { merchant: "City Pharmacy", amount: 30 },
    ] }));
    assert.deepEqual(forms(r), [["1098-E", "Navient Student Loan Interest"], ["1098-T", "State University Tuition"], ["1098", "Bank Mortgage Interest"]]);
  });

  it("a failing source is reported with a fixed sentence and the others still suggest", async () => {
    const r = await docs.computeSuggestions(null, 2025, deps({
      income: new Error("db down: password=hunter2"),
      ded: [{ merchant: "State University Tuition", amount: 4000 }],
    }));
    assert.deepEqual(forms(r), [["1098-T", "State University Tuition"]]);
    assert.deepEqual(r.errors, [{ source: "income", error: "Could not read the year's income." }]);
    const r2 = await docs.computeSuggestions(null, 2025, deps({ inv: new Error("x"), ded: new Error("y") }));
    assert.deepEqual(r2.errors.map((e) => e.source), ["investments", "deductions"]);
    assert.ok(!JSON.stringify(r).includes("hunter2"));
  });
});

describe("suggestTaxDocuments + listTaxDocuments", () => {
  it("inserts each suggestion ON CONFLICT DO NOTHING and counts only the rows actually added", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: params[1] === "W-2" ? [{ id: 1 }] : [] }; } };
    const out = await docs.suggestTaxDocuments(pool, 2025, deps({
      income: { by_source: [{ source: "Acme", kind: "wages", total: 100 }] },
      ded: [{ merchant: "U Tuition", amount: 10 }],
    }));
    assert.equal(out.added, 1, "the 1098-T already on the list isn't counted");
    assert.equal(out.suggestions.length, 2);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.match(c.sql, /ON CONFLICT \(tax_year, form, \(LOWER\(issuer\)\)\) DO NOTHING/);
      assert.doesNotMatch(c.sql, /DO UPDATE/, "a received / dismissed / hand-added row is never changed");
      assert.match(c.sql, /'suggested'/);
    }
    assert.deepEqual(calls[0].params, [2025, "W-2", "Acme", "2026-01-31"]);
  });

  it("lists in form order, then issuer, with each row's state", async () => {
    const pool = { query: async (sql, params) => {
      assert.match(sql, /FROM tax_documents WHERE tax_year = \$1/);
      assert.deepEqual(params, [2025]);
      return { rows: [
        { id: 1, form: "1099-INT", issuer: "zeta", expected_by: "2026-01-31", received_at: null, dismissed_at: null },
        { id: 2, form: "W-2", issuer: "Acme", expected_by: "2026-01-31", received_at: "2026-01-20", dismissed_at: null },
        { id: 3, form: "1099-INT", issuer: "Ally", expected_by: "2026-02-28", received_at: null, dismissed_at: null },
        { id: 4, form: "other", issuer: "", expected_by: null, received_at: null, dismissed_at: "2026-01-02T00:00:00Z" },
        { id: 5, form: "1099-B", issuer: "Fidelity", expected_by: "2026-02-10", received_at: null, dismissed_at: null },
      ] };
    } };
    const list = await docs.listTaxDocuments(pool, 2025, "2026-02-10");
    assert.deepEqual(list.map((d) => [d.id, d.state]), [[2, "received"], [3, "waiting"], [1, "overdue"], [5, "waiting"], [4, "dismissed"]],
      "a form due today is still waiting");
  });
});

describe("getIncomeForYear", () => {
  it("one query over the calendar year on the income predicate at the user's share, aggregated by source, kind and month", async () => {
    let seen;
    const pool = { query: async (sql, params) => { seen = { sql, params }; return { rows: [
      { source: "Acme", month: "2025-01", kind: "wages", institution: "Chase", total: "2000.00", count: 2, first_date: "2025-01-03", last_date: "2025-01-17" },
      { source: "Acme", month: "2025-02", kind: "wages", institution: "Chase", total: "2000.10", count: 2, first_date: "2025-02-01", last_date: "2025-02-14" },
      { source: "Ally Interest", month: "2025-02", kind: "interest", institution: "Ally Bank", total: "1.25", count: 1, first_date: "2025-02-28", last_date: "2025-02-28" },
    ] }; } };
    const r = await fq.getIncomeForYear(pool, 2025);
    assert.deepEqual(seen.params, [2025]);
    assert.match(seen.sql, /t\.date >= make_date\(\$1, 1, 1\) AND t\.date < make_date\(\$1 \+ 1, 1, 1\)/);
    assert.ok(seen.sql.includes(fq.INCOME_AMOUNT), "INCOME_AMOUNT — a shared account at the user's share");
    assert.ok(seen.sql.includes(fq.incomePredicate("t").trim()), "the canonical income predicate");
    assert.match(seen.sql, /INCOME_WAGES/);
    assert.match(seen.sql, /la\.institution_name_manual/);
    assert.equal(r.total, 4001.35);
    assert.deepEqual(r.by_kind, { wages: 4000.1, interest: 1.25, dividends: 0, other: 0 });
    assert.deepEqual(r.by_month, [{ month: "2025-01", total: 2000 }, { month: "2025-02", total: 2001.35 }]);
    assert.deepEqual(r.by_source[0], { source: "Acme", kind: "wages", institution: "Chase", total: 4000.1, count: 4, first_date: "2025-01-03", last_date: "2025-02-14" });
  });
});

describe("routes", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/tax")); return a; };
  const thisYear = Number(fq.todayStr().slice(0, 4));
  const stubKick = () => { lt.kick = (reason) => { kicks.push(reason); }; };

  it("every route refuses a bad year with a 400 before reading", async () => {
    let reads = 0;
    dbModule.pool.query = async () => { reads++; return { rows: [] }; };
    for (const y of ["", "1999", String(thisYear + 1), "2025x"]) {
      await supertest(app()).get("/api/tax/documents?year=" + y).expect(400);
      await supertest(app()).post("/api/tax/documents/suggest?year=" + y).expect(400);
      await supertest(app()).post("/api/tax/documents").send({ year: y, form: "W-2" }).expect(400);
    }
    assert.equal(reads, 0);
  });

  it("GET lists the year's documents with the form list", async () => {
    dbModule.pool.query = async () => ({ rows: [{ id: 1, form: "W-2", issuer: "Acme", expected_by: "2026-01-31", received_at: null, dismissed_at: null }] });
    const b = (await supertest(app()).get("/api/tax/documents?year=" + (thisYear - 1)).expect(200)).body;
    assert.equal(b.year, thisYear - 1);
    assert.deepEqual(b.forms, docs.FORMS);
    assert.equal(b.documents.length, 1);
  });

  it("POST validates form / issuer / expected_by / notes; adds a manual row with the usual deadline; 409 on a duplicate", async () => {
    stubKick();
    let insert = null, rows = [{ id: 9, form: "1099-NEC" }];
    dbModule.pool.query = async (sql, params) => { insert = { sql, params }; return { rows }; };
    const y = thisYear - 1;
    for (const body of [
      { year: y }, { year: y, form: "W2" }, { year: y, form: "W-2", issuer: 5 },
      { year: y, form: "W-2", issuer: "x".repeat(201) },
      { year: y, form: "W-2", expected_by: "2026-02-30" }, { year: y, form: "W-2", expected_by: 3 },
      { year: y, form: "W-2", notes: 7 }, { year: y, form: "W-2", notes: "n".repeat(1001) },
    ]) {
      insert = null;
      await supertest(app()).post("/api/tax/documents").send(body).expect(400);
      assert.equal(insert, null, JSON.stringify(body));
    }
    const r = await supertest(app()).post("/api/tax/documents").send({ year: String(y), form: "1099-NEC", issuer: "  Client   Co ", notes: " invoice " }).expect(201);
    assert.equal(r.body.document.id, 9);
    assert.match(insert.sql, /'manual'/);
    assert.deepEqual(insert.params, [y, "1099-NEC", "Client Co", `${y + 1}-01-31`, "invoice"]);
    assert.deepEqual(kicks, ["tax-document-add"]);
    rows = [];
    const dup = await supertest(app()).post("/api/tax/documents").send({ year: y, form: "1099-NEC", issuer: "client co" }).expect(409);
    assert.match(dup.body.error, /already on the list/);
    assert.equal(kicks.length, 1, "nothing changed → no refresh");
  });

  it("PATCH: strict booleans, notes and dates; received stamps today's date; 404; nothing to update is a 400", async () => {
    stubKick();
    let sql = null, params = null, rows = [{ id: 4 }];
    dbModule.pool.query = async (s, p) => { sql = s; params = p; return { rows }; };
    for (const [id, body] of [["x", { received: true }], ["0", { received: true }], ["4", {}], ["4", { received: "yes" }],
      ["4", { dismissed: 1 }], ["4", { notes: 3 }], ["4", { expected_by: "soon" }]]) {
      sql = null;
      await supertest(app()).patch("/api/tax/documents/" + id).send(body).expect(400);
      assert.equal(sql, null);
    }
    await supertest(app()).patch("/api/tax/documents/4").send({ received: true, notes: "in the drawer" }).expect(200);
    assert.match(sql, /received_at = \$1::date, notes = \$2, updated_at = now\(\) WHERE id = \$3/);
    assert.deepEqual(params, [fq.todayStr(), "in the drawer", 4]);
    await supertest(app()).patch("/api/tax/documents/4").send({ dismissed: true }).expect(200);
    assert.match(sql, /dismissed_at = COALESCE\(dismissed_at, now\(\)\)/);
    await supertest(app()).patch("/api/tax/documents/4").send({ dismissed: false, received: false, expected_by: null }).expect(200);
    assert.match(sql, /received_at = \$1::date, dismissed_at = NULL, expected_by = \$2::date/);
    assert.deepEqual(params, [null, null, 4]);
    assert.equal(kicks.length, 3);
    rows = [];
    await supertest(app()).patch("/api/tax/documents/99").send({ received: true }).expect(404);
    assert.equal(kicks.length, 3);
  });

  it("DELETE removes a manual row; a suggested one is a 409 (dismiss it instead) and nothing is deleted", async () => {
    stubKick();
    const seen = [];
    let origin = "manual";
    dbModule.pool.query = async (sql) => { seen.push(sql); if (/^SELECT origin/.test(sql)) return { rows: origin ? [{ origin }] : [] }; return { rows: [], rowCount: 1 }; };
    await supertest(app()).delete("/api/tax/documents/5").expect(200);
    assert.ok(seen.some((s) => /DELETE FROM tax_documents WHERE id = \$1 AND origin = 'manual'/.test(s)));
    assert.deepEqual(kicks, ["tax-document-delete"]);
    seen.length = 0; origin = "suggested";
    const r = await supertest(app()).delete("/api/tax/documents/5").expect(409);
    assert.equal(r.body.reason, "suggested");
    assert.ok(!seen.some((s) => /^DELETE/.test(s)));
    origin = null;
    await supertest(app()).delete("/api/tax/documents/5").expect(404);
    await supertest(app()).delete("/api/tax/documents/abc").expect(400);
    assert.equal(kicks.length, 1);
  });

  it("suggest returns what it added and the list; a failure is a fixed 500", async () => {
    stubKick();
    const realSuggest = docs.suggestTaxDocuments;
    docs.suggestTaxDocuments = async () => ({ added: 2, suggestions: [{}, {}], errors: [] });
    dbModule.pool.query = async () => ({ rows: [] });
    try {
      const b = (await supertest(app()).post("/api/tax/documents/suggest").send({ year: thisYear - 1 }).expect(200)).body;
      assert.equal(b.added, 2);
      assert.deepEqual(b.documents, []);
      assert.deepEqual(kicks, ["tax-document-suggest"]);
      docs.suggestTaxDocuments = async () => { throw new Error("secret detail"); };
      const e = await supertest(app()).post("/api/tax/documents/suggest?year=" + (thisYear - 1)).expect(500);
      assert.equal(e.body.error, "Could not suggest tax documents.");
    } finally { docs.suggestTaxDocuments = realSuggest; }
  });

  it("server.js mounts the tax routes", () => {
    assert.match(read("teller/server.js"), /app\.use\(require\("\.\/routes\/tax"\)\)/);
  });
});

describe("the tax_documents linked-task source", () => {
  it("one task per open form past its expected_by, shaped for Per-sistant's checks", async () => {
    let seen;
    const pool = { query: async (sql, params) => { seen = { sql, params }; return { rows: [
      { id: 3, tax_year: 2025, form: "W-2", issuer: "Acme Corp", expected_by: "2026-01-31" },
      { id: 4, tax_year: 2025, form: "other", issuer: "", expected_by: "2026-02-01" },
    ] }; } };
    const tasks = await lt.taxDocumentTasks(pool, "2026-02-10");
    assert.match(seen.sql, /received_at IS NULL AND dismissed_at IS NULL/);
    assert.match(seen.sql, /expected_by IS NOT NULL AND expected_by < \$1::date/);
    assert.deepEqual(seen.params, ["2026-02-10"]);
    assert.deepEqual(tasks[0], {
      key: "perfin:tax-doc:3", title: "Find your 2025 W-2 from Acme Corp",
      description: "It usually arrives by 2026-01-31. Mark it received (or dismiss it) on Perfin's Tax page.",
      url: "/tax#documents", due_date: "2026-01-31", priority: "medium",
    });
    assert.equal(tasks[1].title, "Find your 2025 tax form");
    const ps = require("../apps/per-sistant/services/linked-tasks");
    for (const t of tasks) assert.equal(ps.checkTask("perfin", ["tax-doc"], t).error, undefined, t.key);
  });

  it("is on by default, read by computeLinkedTasks, isolated on failure, never read when off", async () => {
    assert.equal(lt.DEFAULT_SOURCES.tax_documents, true);
    assert.equal(lt.SOURCES.tax_documents, "tax-doc");
    const only = { housing: false, utility_amount: false, bills: false };
    let reads = 0;
    const ok = { query: async () => { reads++; return { rows: [{ id: 1, tax_year: 2025, form: "W-2", issuer: "A", expected_by: "2026-01-31" }] }; } };
    const r = await lt.computeLinkedTasks(ok, { sources: only }, "2026-02-10");
    assert.deepEqual(r.ok_kinds, ["tax-doc"]);
    assert.deepEqual(r.desired.map((d) => d.key), ["perfin:tax-doc:1"]);
    const bad = { query: async () => { throw new Error("relation does not exist"); } };
    const r2 = await lt.computeLinkedTasks(bad, { sources: only }, "2026-02-10");
    assert.deepEqual(r2.ok_kinds, []);
    assert.deepEqual(r2.errors, [{ kind: "tax-doc", error: "Could not read this source." }]);
    reads = 0;
    await lt.computeLinkedTasks(ok, { sources: { ...only, tax_documents: false } }, "2026-02-10");
    assert.equal(reads, 0);
  });

  it("GET /api/settings shows the stored sources over the defaults, so the new source reads as on until switched off", async () => {
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/settings"));
    dbModule.pool.query = async () => ({ rows: [{ linked_tasks_sources: { still_charging: true, housing: true, utility_amount: true, bills: false } }] });
    let s = (await supertest(app).get("/api/settings").expect(200)).body;
    assert.equal(s.linked_tasks_sources.tax_documents, true);
    dbModule.pool.query = async () => ({ rows: [{ linked_tasks_sources: { tax_documents: false, bills: true } }] });
    s = (await supertest(app).get("/api/settings").expect(200)).body;
    assert.deepEqual(s.linked_tasks_sources, { still_charging: true, housing: true, utility_amount: true, bills: true, tax_documents: false });
  });

  it("PATCH /api/settings accepts the tax_documents source", async () => {
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/settings"));
    let values = null;
    dbModule.pool.query = async (s, v) => { if (/^UPDATE user_settings SET/.test(s)) values = v; return { rows: [{}] }; };
    await supertest(app).patch("/api/settings").send({ linked_tasks_sources: { tax_documents: false } }).expect(200);
    assert.deepEqual(values.slice(0, 1), [JSON.stringify({ tax_documents: false })]);
  });

  it("Settings → Per-sistant Tasks has a labelled, wired tax-forms box and names the source in errors", () => {
    const v = read("teller/views/settings.ejs");
    assert.match(v, /<input type="checkbox" id="linked-src-tax_documents" data-source="tax_documents"> <label for="linked-src-tax_documents">/);
    assert.match(v, /var LINKED_SOURCES = \['housing', 'utility_amount', 'still_charging', 'bills', 'tax_documents'\];/);
    assert.match(v, /'tax-doc': 'Tax forms'/);
    assert.match(v, /\['linked-src-tax_documents', 'change', function\(\) \{ onLinkedToggle\(this, \{ linked_tasks_sources: \{ tax_documents: this\.checked \} \}\); \}\]/);
  });
});

describe("migration + reset-fresh", () => {
  it("creates tax_documents with the form list the service uses and the case-insensitive unique key", () => {
    const db = read("teller/services/database.js");
    const m = /CREATE TABLE IF NOT EXISTS tax_documents \(([\s\S]*?)\)`\);/.exec(db);
    assert.ok(m, "the CREATE TABLE");
    // Cycle-8 F31: the lists live in database.CHECK_LISTS (interpolated here and
    // kept in step on an existing table by syncInListChecks).
    const { CHECK_LISTS } = require("../teller/services/database");
    assert.deepEqual(CHECK_LISTS.tax_documents.form, docs.FORMS);
    assert.deepEqual(CHECK_LISTS.tax_documents.origin, ["suggested", "manual"]);
    assert.match(m[1], /form TEXT NOT NULL CHECK \(form IN \(\$\{inList\(CHECK_LISTS\.tax_documents\.form\)\}\)\)/);
    assert.match(m[1], /origin TEXT NOT NULL DEFAULT 'manual' CHECK \(origin IN \(\$\{inList\(CHECK_LISTS\.tax_documents\.origin\)\}\)\)/);
    assert.match(db, /CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_documents_year_form_issuer\s+ON tax_documents \(tax_year, form, \(LOWER\(issuer\)\)\)/);
  });

  it("reset-fresh wipes it", () => {
    const { WIPE_TABLES } = require("../scripts/reset-fresh");
    assert.ok(WIPE_TABLES.includes("tax_documents"));
  });
});
