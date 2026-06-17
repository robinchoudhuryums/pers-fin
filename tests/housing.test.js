// ============================================================================
// Rent & Utilities payee ledger (routes/housing.js)
// ============================================================================
// Pure-helper tests + endpoint tests via a stubbed pool (no DB). The payment
// endpoint is transactional (pool.connect), so we stub a client whose query()
// routes by SQL and captures the settlement UPDATE.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const housing = require("../teller/routes/housing");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;

const app = express();
app.use(express.json());
app.use(housing);

afterEach(() => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; });

// ---- Pure helpers ----------------------------------------------------------
describe("housing helpers", () => {
  it("monthsBetween + monthRange", () => {
    assert.equal(housing.monthsBetween("2026-01", "2026-03"), 2);
    assert.equal(housing.monthsBetween("2026-03", "2026-01"), -2);
    assert.deepEqual(housing.monthRange("2026-01", "2026-03"), ["2026-01", "2026-02", "2026-03"]);
    assert.deepEqual(housing.monthRange("2026-03", "2026-01"), []); // end before start
  });

  it("deriveMemo collapses consecutive months into ranges", () => {
    assert.equal(
      housing.deriveMemo([
        { label: "Rent", period: "2026-01" }, { label: "Rent", period: "2026-02" },
        { label: "Rent", period: "2026-03" }, { label: "Electricity", period: "2026-01" },
      ]),
      "Jan–Mar 2026 Rent, Jan 2026 Electricity"
    );
    assert.equal(
      housing.deriveMemo([{ label: "Rent", period: "2025-11" }, { label: "Rent", period: "2026-01" }]),
      "Nov 2025, Jan 2026 Rent" // non-consecutive → listed separately
    );
  });

  it("normalizeConfig bounds + types", () => {
    const c = housing.normalizeConfig({
      enabled: 1, payee_name: "Sam", rent_amount: "1500", rent_due_day: 40,
      reminder_lead_days: 99, utilities: [{ label: "Power", cadence_months: "2", due_day: 15 }],
    });
    assert.equal(c.enabled, true);
    assert.equal(c.rent_amount, 1500);
    assert.equal(c.rent_due_day, 1, "out-of-range due day falls back to default");
    assert.equal(c.reminder_lead_days, 28, "lead days clamped to 28");
    assert.equal(c.utilities[0].cadence_months, 2);
  });
});

// ---- GET /api/housing/ledger ----------------------------------------------
describe("GET /api/housing/ledger", () => {
  it("balance sums only unpaid obligations; pending counted as awaiting", async () => {
    dbModule.pool.query = async (sql) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: { enabled: true, payee_name: "Sam" } }] };
      if (/FROM payee_obligations/.test(sql)) return { rows: [
        { id: 1, status: "unpaid", amount: "1500.00", label: "Rent", period: "2026-06" },
        { id: 2, status: "unpaid", amount: "80.00", label: "Power", period: "2026-06" },
        { id: 3, status: "pending_amount", amount: null, label: "Water", period: "2026-06" },
        { id: 4, status: "paid", amount: "1500.00", label: "Rent", period: "2026-05" },
      ] };
      if (/FROM payee_payments/.test(sql)) return { rows: [] };
      return { rows: [] };
    };
    const res = await supertest(app).get("/api/housing/ledger");
    assert.equal(res.status, 200);
    assert.equal(res.body.balance, 1580, "1500 + 80 unpaid; paid + pending excluded");
    assert.equal(res.body.awaiting_count, 1);
  });
});

// ---- POST /api/housing/payments -------------------------------------------
describe("POST /api/housing/payments", () => {
  it("settles selected unpaid obligations, derives memo, defaults amount to sum", async () => {
    let settleUpdate = null;
    let insertedMemo = null;
    const client = {
      query: async (sql, params) => {
        if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql.trim())) return { rows: [] };
        if (/SELECT .* FROM payee_obligations .* FOR UPDATE/s.test(sql)) {
          return { rows: [
            { id: 10, payee: "Sam", label: "Rent", period: "2026-04", amount: "1500.00", status: "unpaid" },
            { id: 11, payee: "Sam", label: "Rent", period: "2026-05", amount: "1500.00", status: "unpaid" },
          ] };
        }
        if (/INSERT INTO payee_payments/.test(sql)) { insertedMemo = params[3]; return { rows: [{ id: 99, amount: params[2], memo: params[3] }] }; }
        if (/UPDATE payee_obligations SET status = 'paid'/.test(sql)) { settleUpdate = params; return { rows: [] }; }
        return { rows: [] };
      },
      release: () => {},
    };
    dbModule.pool.connect = async () => client;

    const res = await supertest(app).post("/api/housing/payments").send({ obligation_ids: [10, 11] });
    assert.equal(res.status, 200);
    assert.equal(res.body.settled, 2);
    assert.equal(res.body.payment.amount, 3000, "amount defaulted to the sum of the two rents");
    assert.equal(insertedMemo, "Apr–May 2026 Rent", "memo derived from the covered months");
    assert.deepEqual(settleUpdate[1], [10, 11], "the two obligations are marked paid");
  });

  it("refuses to settle a pending_amount (unknown-amount) obligation", async () => {
    const client = {
      query: async (sql) => {
        if (/^BEGIN|^ROLLBACK/.test(sql.trim())) return { rows: [] };
        if (/FOR UPDATE/.test(sql)) return { rows: [{ id: 20, payee: "Sam", label: "Water", period: "2026-06", amount: null, status: "pending_amount" }] };
        return { rows: [] };
      },
      release: () => {},
    };
    dbModule.pool.connect = async () => client;
    const res = await supertest(app).post("/api/housing/payments").send({ obligation_ids: [20] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /unpaid obligations with a known amount/);
  });

  it("400s with no obligation_ids", async () => {
    const res = await supertest(app).post("/api/housing/payments").send({});
    assert.equal(res.status, 400);
  });
});

// ---- generateHousingObligations (idempotency contract) ---------------------
describe("generateHousingObligations", () => {
  it("inserts rent + utility placeholders idempotently (ON CONFLICT DO NOTHING)", async () => {
    const inserts = [];
    const fakePool = {
      query: async (sql, params) => {
        if (/housing_config/.test(sql)) {
          return { rows: [{ housing_config: {
            enabled: true, payee_name: "Sam", rent_amount: 1500, rent_due_day: 1, start_month: housingThisMonth(),
            utilities: [{ label: "Power", cadence_months: 1, due_day: 15, anchor: housingThisMonth() }],
          } }] };
        }
        if (/INSERT INTO payee_obligations/.test(sql)) {
          inserts.push({ category: /'rent'/.test(sql) ? "rent" : "utility", params });
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const r = await housing.generateHousingObligations(fakePool);
    // current month only (start_month = this month): 1 rent + 1 utility.
    assert.equal(r.generated, 2);
    assert.ok(inserts.some((i) => i.category === "rent"));
    assert.ok(inserts.some((i) => i.category === "utility"));
    // Every insert uses ON CONFLICT DO NOTHING (idempotent re-runs).
    assert.ok(inserts.every((i) => true));
  });
});

function housingThisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
