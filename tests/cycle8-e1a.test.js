// ============================================================================
// Cycle 8 E1a (G1) — correcting the cash-flow forecast
// ============================================================================
// recurring_transfers.forecast_treatment (auto | bill | internal | ignore) and
// detected_subscriptions.forecast_ignore: the user's treatment beats the card-
// autopay / internal-move heuristics, getCashFlowInputs splits the candidates
// into `bills` and `left_out` with a reason, projectCashFlow reports both as
// forecast_items (occurrences, projected total, next date) and bills only
// `bills`, GET /api/cash-flow carries them, and the two PATCH routes validate
// strictly, write the column and make the next cash-alert check re-evaluate.
// The database-backed half is tests/contract/forecast-e1a.contract.test.js.
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
afterEach(() => { dbModule.pool.query = originalQuery; });

const cf = require("../teller/services/cash-flow");
const cashAlerts = require("../teller/services/cash-alerts");
const { addDaysStr } = require("../teller/services/cadence");
const fq = require("../teller/services/financial-queries");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function mountApp(mod) {
  const app = express();
  app.use(express.json());
  app.use(require(mod));
  return app;
}

// Three transfer shapes: one the card-autopay rule skips, one the internal-move
// rule skips, one both bill.
const autopay = { id: 1, display_name: "Chase card autopay", amount: "800", cadence_days: 30, transfer_type: "bill_payment", direction: "outgoing", paid_linked_card: true };
const internal = { id: 2, display_name: "Transfer to savings", amount: "300", cadence_days: 30, transfer_type: "savings", direction: "outgoing", moved_between_cash_accounts: true };
const plain = { id: 3, display_name: "Zelle to landlord", amount: "1500", cadence_days: 30, transfer_type: "peer_transfer", direction: "outgoing" };

describe("transferTreatment — the user's treatment beats the heuristics", () => {
  it("auto keeps today's rules", () => {
    assert.deepEqual(cf.transferTreatment(autopay), { bill: false, reason: "card_autopay" });
    assert.deepEqual(cf.transferTreatment(internal), { bill: false, reason: "internal" });
    assert.deepEqual(cf.transferTreatment(plain), { bill: true, why: "auto" });
    assert.deepEqual(cf.transferTreatment({ ...plain, forecast_treatment: "auto" }), { bill: true, why: "auto" });
  });
  it("bill bills every shape, internal / ignore bill none", () => {
    for (const tr of [autopay, internal, plain]) {
      assert.deepEqual(cf.transferTreatment({ ...tr, forecast_treatment: "bill" }), { bill: true, why: "user" }, tr.display_name);
      assert.deepEqual(cf.transferTreatment({ ...tr, forecast_treatment: "internal" }), { bill: false, reason: "user_internal" }, tr.display_name);
      assert.deepEqual(cf.transferTreatment({ ...tr, forecast_treatment: "ignore" }), { bill: false, reason: "user_ignored" }, tr.display_name);
    }
  });
});

describe("classifyBills", () => {
  it("tags every candidate with its source, treatment and why / reason", () => {
    const subs = [
      { id: 10, display_name: "Netflix", amount: "15.49", cadence_days: 30 },
      { id: 11, display_name: "Gym", amount: "40", cadence_days: 30, forecast_ignore: true },
    ];
    const { bills, left_out } = cf.classifyBills(subs, [autopay, { ...internal, forecast_treatment: "bill" }, { ...plain, forecast_treatment: "ignore" }]);
    assert.deepEqual(bills.map((b) => [b.source, b.id, b.treatment, b.why]), [
      ["subscription", 10, "auto", "auto"],
      ["transfer", 2, "bill", "user"],
    ]);
    assert.deepEqual(left_out.map((b) => [b.source, b.id, b.treatment, b.reason]), [
      ["subscription", 11, "ignore", "user_ignored"],
      ["transfer", 1, "auto", "card_autopay"],
      ["transfer", 3, "ignore", "user_ignored"],
    ]);
  });
  it("no rows → two empty lists", () => {
    assert.deepEqual(cf.classifyBills(undefined, undefined), { bills: [], left_out: [] });
  });
});

// A fake pool for getCashFlowInputs: one subscription and the three transfers.
function inputsPool({ subIgnore = false, treatments = {} } = {}) {
  const tomorrow = addDaysStr(fq.todayStr(), 1);
  const last = addDaysStr(tomorrow, -30);
  const seen = [];
  const query = async (sql) => {
    seen.push(sql);
    if (/FROM detected_subscriptions\s+WHERE/.test(sql)) {
      return { rows: [{ id: 10, display_name: "Netflix", amount: "15.49", cadence_days: 30, next_expected: tomorrow, last_date: last, forecast_ignore: subIgnore }] };
    }
    if (/FROM recurring_transfers rt/.test(sql)) {
      return { rows: [autopay, internal, plain].map((t) => ({ ...t, next_expected: tomorrow, last_date: last, forecast_treatment: treatments[t.id] || "auto" })) };
    }
    if (/AS cash/.test(sql)) return { rows: [{ cash: "5000", debt: "0" }] };
    if (/AS avg_daily\s+FROM \(/.test(sql)) return { rows: [{ avg_daily: "0" }] };
    return { rows: [] };
  };
  return { query, seen };
}

describe("getCashFlowInputs + projectCashFlow", () => {
  it("reads the two settings with each row's id", async () => {
    const pool = inputsPool();
    await cf.getCashFlowInputs(pool);
    const subSql = pool.seen.find((s) => /FROM detected_subscriptions\s+WHERE/.test(s));
    const trSql = pool.seen.find((s) => /FROM recurring_transfers rt/.test(s));
    assert.match(subSql, /SELECT id, display_name.*forecast_ignore/s);
    assert.match(trSql, /SELECT rt\.id,.*rt\.forecast_treatment/s);
  });

  it("auto: the subscription and the plain transfer are billed; autopay and internal left out with their reasons", async () => {
    const inputs = await cf.getCashFlowInputs(inputsPool());
    const out = cf.projectCashFlow(inputs, { days: 30 });
    assert.equal(out.total_projected_bills, 1515.49);
    assert.deepEqual(out.forecast_items.bills.map((b) => [b.source, b.id, b.why, b.occurrences, b.projected_total, b.next_date]), [
      ["subscription", 10, "auto", 1, 15.49, addDaysStr(fq.todayStr(), 1)],
      ["transfer", 3, "auto", 1, 1500, addDaysStr(fq.todayStr(), 1)],
    ]);
    assert.deepEqual(out.forecast_items.left_out.map((b) => [b.id, b.reason, b.treatment]), [[1, "card_autopay", "auto"], [2, "internal", "auto"]]);
    const item = out.forecast_items.left_out[0];
    assert.deepEqual(Object.keys(item).sort(), ["amount", "cadence_days", "id", "name", "reason", "source", "transfer_type", "treatment"]);
    assert.equal(item.name, "Chase card autopay");
    assert.equal(item.amount, 800);
    assert.equal(item.transfer_type, "bill_payment");
  });

  it("the user's settings move bills in and out, and the totals with them", async () => {
    const inputs = await cf.getCashFlowInputs(inputsPool({ subIgnore: true, treatments: { 1: "bill", 2: "bill", 3: "internal" } }));
    const out = cf.projectCashFlow(inputs, { days: 30 });
    assert.equal(out.total_projected_bills, 1100);
    assert.deepEqual(out.forecast_items.bills.map((b) => [b.id, b.why, b.treatment]), [[1, "user", "bill"], [2, "user", "bill"]]);
    assert.deepEqual(out.forecast_items.left_out.map((b) => [b.source, b.id, b.reason]), [
      ["subscription", 10, "user_ignored"],
      ["transfer", 3, "user_internal"],
    ]);
    assert.ok(!("transfer_type" in out.forecast_items.left_out[0]), "a subscription carries no transfer_type");
  });

  it("canned inputs without the new fields still project (other callers' inputs)", () => {
    const out = cf.projectCashFlow({ today: "2026-01-30", bills: [{ display_name: "Rent", amount: "1500", cadence_days: 30, next_expected: "2026-02-01", last_date: "2026-01-01" }] }, { days: 30 });
    assert.equal(out.total_projected_bills, 3000);
    assert.deepEqual(out.forecast_items.bills.map((b) => [b.source, b.id, b.why, b.occurrences]), [[null, null, "auto", 2]]);
    assert.deepEqual(out.forecast_items.left_out, []);
  });

  it("GET /api/cash-flow returns forecast_items", async () => {
    dbModule.pool.query = inputsPool().query;
    const res = await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/cash-flow?days=30").expect(200);
    assert.equal(res.body.forecast_items.bills.length, 2);
    assert.deepEqual(res.body.forecast_items.left_out.map((b) => b.reason), ["card_autopay", "internal"]);
    assert.ok(!("projection" in res.body));
  });
});

describe("PATCH /api/recurring-transfers/:id/forecast and /api/subscriptions/:id/forecast", () => {
  const origInvalidate = cashAlerts.invalidate;
  afterEach(() => { cashAlerts.invalidate = origInvalidate; });
  const app = mountApp("../teller/routes/subscriptions");

  function spyPool(rows) {
    const calls = [];
    dbModule.pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows }; };
    return calls;
  }

  it("400s a malformed id or treatment before any query", async () => {
    const calls = spyPool([]);
    for (const id of ["abc", "0", "1.5", "99999999999", "-1"]) {
      await supertest(app).patch(`/api/recurring-transfers/${id}/forecast`).send({ treatment: "bill" }).expect(400);
    }
    for (const body of [{}, { treatment: "BILL" }, { treatment: 5 }, { treatment: "" }, { treatment: ["bill"] }]) {
      await supertest(app).patch("/api/recurring-transfers/3/forecast").send(body).expect(400);
    }
    assert.equal(calls.length, 0);
  });

  it("writes the treatment, answers the row and invalidates the cash alerts", async () => {
    let invalidated = 0;
    cashAlerts.invalidate = () => { invalidated++; };
    const calls = spyPool([{ id: 3, display_name: "Zelle to landlord", direction: "outgoing", forecast_treatment: "internal" }]);
    const res = await supertest(app).patch("/api/recurring-transfers/3/forecast").send({ treatment: "internal" }).expect(200);
    assert.equal(res.body.forecast_treatment, "internal");
    assert.match(calls[0].sql, /UPDATE recurring_transfers SET forecast_treatment = \$1/);
    assert.deepEqual(calls[0].params, ["internal", 3]);
    assert.equal(invalidated, 1);
  });

  it("404s an unknown transfer without invalidating", async () => {
    let invalidated = 0;
    cashAlerts.invalidate = () => { invalidated++; };
    spyPool([]);
    await supertest(app).patch("/api/recurring-transfers/77/forecast").send({ treatment: "auto" }).expect(404);
    assert.equal(invalidated, 0);
  });

  it("every value of the CHECK is accepted", async () => {
    for (const t of dbModule.CHECK_LISTS.recurring_transfers.forecast_treatment) {
      spyPool([{ id: 3, forecast_treatment: t }]);
      await supertest(app).patch("/api/recurring-transfers/3/forecast").send({ treatment: t }).expect(200);
    }
  });

  it("subscriptions take a strict boolean", async () => {
    const calls = spyPool([]);
    for (const body of [{}, { ignore: "true" }, { ignore: 1 }, { ignore: null }]) {
      await supertest(app).patch("/api/subscriptions/10/forecast").send(body).expect(400);
    }
    await supertest(app).patch("/api/subscriptions/x/forecast").send({ ignore: true }).expect(400);
    assert.equal(calls.length, 0);
    let invalidated = 0;
    cashAlerts.invalidate = () => { invalidated++; };
    const calls2 = spyPool([{ id: 10, display_name: "Netflix", forecast_ignore: true }]);
    const res = await supertest(app).patch("/api/subscriptions/10/forecast").send({ ignore: true }).expect(200);
    assert.equal(res.body.forecast_ignore, true);
    assert.match(calls2[0].sql, /UPDATE detected_subscriptions SET forecast_ignore = \$1/);
    assert.deepEqual(calls2[0].params, [true, 10]);
    assert.equal(invalidated, 1);
    spyPool([]);
    await supertest(app).patch("/api/subscriptions/11/forecast").send({ ignore: false }).expect(404);
  });

  it("a failing invalidate doesn't fail the save", async () => {
    cashAlerts.invalidate = () => { throw new Error("boom"); };
    spyPool([{ id: 3, forecast_treatment: "bill" }]);
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    try {
      await supertest(app).patch("/api/recurring-transfers/3/forecast").send({ treatment: "bill" }).expect(200);
    } finally { console.error = origErr; }
    assert.ok(errs.some((e) => /cash-alerts invalidate failed/.test(e)));
  });
});

describe("schema and the detectors", () => {
  it("the CHECK's values live in CHECK_LISTS and the columns are migrated", () => {
    assert.deepEqual(dbModule.CHECK_LISTS.recurring_transfers.forecast_treatment, ["auto", "bill", "internal", "ignore"]);
    const src = read("teller/services/database.js");
    assert.match(src, /ALTER TABLE recurring_transfers ADD COLUMN IF NOT EXISTS forecast_treatment TEXT NOT NULL DEFAULT 'auto' CHECK/);
    assert.match(src, /ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS forecast_ignore BOOLEAN NOT NULL DEFAULT false/);
    // Added before the CHECK sync runs.
    assert.ok(src.indexOf("forecast_treatment TEXT NOT NULL") < src.indexOf("const checksChanged = await syncInListChecks(client);"));
  });
  it("neither detector writes the user's forecast setting", () => {
    for (const f of ["scripts/detect-transfers.js", "scripts/detect-subscriptions.js", "teller/routes/merchant-rename.js"]) {
      assert.doesNotMatch(read(f), /forecast_treatment|forecast_ignore/, f);
    }
  });
});
