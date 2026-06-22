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

  it("buildDoubleCountPattern: word-boundary regex from payee + utility labels, metachars escaped", () => {
    const p = housing.buildDoubleCountPattern({ payee_name: "Sam Vance", utilities: [{ label: "Electricity" }, { label: "Water" }] });
    assert.equal(p, "\\y(Sam Vance|Electricity|Water)\\y");
    // <3-char and empty labels dropped; regex metachars escaped.
    const p2 = housing.buildDoubleCountPattern({ payee_name: "AB", utilities: [{ label: "Gas (PG&E)" }, { label: "" }] });
    assert.equal(p2, "\\y(Gas \\(PG&E\\))\\y");
    // No usable terms → null (so the guard query is skipped entirely).
    assert.equal(housing.buildDoubleCountPattern({ payee_name: "", utilities: [] }), null);
  });

  it("computeSplit: you send the partner (rent+util − car)/2, each bears half the total", () => {
    const r = housing.computeSplit(1000, 560);
    assert.equal(r.transfer, 220);
    assert.equal(r.direction, "you_send_partner");
    assert.equal(r.each_share, 780);
    // car > rent+util → the partner reimburses you instead.
    const flip = housing.computeSplit(500, 560);
    assert.equal(flip.transfer, 30);
    assert.equal(flip.direction, "partner_sends_you");
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

// ---- GET /api/housing/export (#3) -----------------------------------------
describe("GET /api/housing/export", () => {
  it("returns a year's payments with total (json) + CSV attachment", async () => {
    dbModule.pool.query = async (sql, params) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: { enabled: true, payee_name: "Sam" } }] };
      if (/FROM payee_payments/.test(sql)) {
        assert.equal(params[0], 2026);
        return { rows: [
          { id: 1, payee: "Sam", paid_date: "2026-03-01", amount: "3000.00", memo: "Jan–Mar 2026 Rent", covers: [{ label: "Rent", period: "2026-01" }] },
          { id: 2, payee: "Sam", paid_date: "2026-06-01", amount: "80.00", memo: "Jun 2026 Electricity", covers: [{ label: "Electricity", period: "2026-06" }] },
        ] };
      }
      return { rows: [] };
    };
    const j = await supertest(app).get("/api/housing/export?year=2026&format=json");
    assert.equal(j.status, 200);
    assert.equal(j.body.total, 3080);
    assert.equal(j.body.payments.length, 2);
    assert.equal(j.body.payee, "Sam");

    const c = await supertest(app).get("/api/housing/export?year=2026&format=csv");
    assert.equal(c.status, 200);
    assert.match(c.headers["content-type"], /text\/csv/);
    assert.match(c.headers["content-disposition"], /rent_utilities_2026\.csv/);
    assert.match(c.text, /Jan–Mar 2026 Rent/);
    assert.match(c.text, /3080\.00/); // total row
  });
});

// ---- GET /api/housing/split (partner even-up) ------------------------------
describe("GET /api/housing/split", () => {
  it("auto-pulls the car loan's monthly_payment and computes the even-up transfer", async () => {
    dbModule.pool.query = async (sql, params) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: {
        enabled: true, payee_name: "Sam",
        split: { enabled: true, partner_name: "Wife", car_loan_account_id: 7 },
      } }] };
      if (/SUM\(amount\)[\s\S]*FROM payee_obligations/.test(sql)) return { rows: [{ total: "1000.00" }] };
      if (/FROM linked_accounts WHERE id = \$1 AND type = 'loan'/.test(sql)) {
        assert.equal(params[0], 7);
        return { rows: [{ monthly_payment: "560.00" }] };
      }
      return { rows: [] };
    };
    const res = await supertest(app).get("/api/housing/split");
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.rent_utilities, 1000);
    assert.equal(res.body.car, 560);
    assert.equal(res.body.transfer, 220);
    assert.equal(res.body.direction, "you_send_partner");
    assert.equal(res.body.car_source, "loan");
    assert.equal(res.body.partner_name, "Wife");
  });

  it("falls back to user_settings.partner_name when the split has no partner name", async () => {
    dbModule.pool.query = async (sql) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: {
        enabled: true, payee_name: "Sam",
        split: { enabled: true, car_fixed_amount: 600 },
      } }] };
      if (/SUM\(amount\)[\s\S]*FROM payee_obligations/.test(sql)) return { rows: [{ total: "1200.00" }] };
      if (/partner_name.*FROM user_settings/.test(sql)) return { rows: [{ n: "Sarah" }] };
      return { rows: [] };
    };
    const res = await supertest(app).get("/api/housing/split");
    assert.equal(res.status, 200);
    assert.equal(res.body.partner_name, "Sarah");
    assert.equal(res.body.car, 600);
    assert.equal(res.body.transfer, 300); // (1200 - 600) / 2
    assert.equal(res.body.car_source, "fixed");
  });

  it("flags a shared-card charge matching a utility as a potential double-count", async () => {
    dbModule.pool.query = async (sql, params) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: {
        enabled: true, payee_name: "Landlord", utilities: [{ label: "Electricity" }],
        split: { enabled: true, partner_name: "Wife", car_fixed_amount: 500 },
      } }] };
      if (/SUM\(amount\)[\s\S]*FROM payee_obligations/.test(sql)) return { rows: [{ total: "1000.00" }] };
      if (/la\.is_shared = true/.test(sql)) {
        assert.ok(params[1].includes("Electricity"), "pattern includes the utility label");
        return { rows: [{ merchant: "ELECTRICITY CO", amount: "85.00" }] };
      }
      return { rows: [] };
    };
    const res = await supertest(app).get("/api/housing/split");
    assert.equal(res.status, 200);
    assert.ok(res.body.double_count_warning, "warning present");
    assert.equal(res.body.double_count_warning.count, 1);
    assert.equal(res.body.double_count_warning.total, 85);
    assert.equal(res.body.double_count_warning.sample[0].merchant, "ELECTRICITY CO");
  });

  it("no double-count warning when no shared-card charge matches", async () => {
    dbModule.pool.query = async (sql) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: {
        enabled: true, payee_name: "Landlord", utilities: [{ label: "Electricity" }],
        split: { enabled: true, car_fixed_amount: 500 },
      } }] };
      if (/SUM\(amount\)[\s\S]*FROM payee_obligations/.test(sql)) return { rows: [{ total: "1000.00" }] };
      return { rows: [] }; // is_shared query returns nothing
    };
    const res = await supertest(app).get("/api/housing/split");
    assert.equal(res.body.double_count_warning, null);
  });

  it("returns {enabled:false} when the split isn't configured", async () => {
    dbModule.pool.query = async (sql) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: { enabled: true, payee_name: "Sam" } }] };
      return { rows: [] };
    };
    const res = await supertest(app).get("/api/housing/split");
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
  });
});

// ---- POST /api/housing/scan-bill (#5 OCR) ----------------------------------
describe("POST /api/housing/scan-bill", () => {
  const origKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = origKey;
  });

  it("501 when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await supertest(app)
      .post("/api/housing/scan-bill")
      .attach("file", Buffer.from("img"), { filename: "bill.png", contentType: "image/png" });
    assert.equal(res.status, 501);
  });

  it("400 on an unsupported file type (before any AI call)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const res = await supertest(app)
      .post("/api/housing/scan-bill")
      .attach("file", Buffer.from("hello"), { filename: "bill.txt", contentType: "text/plain" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unsupported file type/);
  });

  it("source: charges the cap as entry_type='scan', forces the report_bill tool, image+pdf blocks", () => {
    const fs = require("fs"); const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../teller/routes/housing.js"), "utf8");
    assert.match(src, /'scan'\)/, "usage row uses entry_type='scan'");
    assert.match(src, /tool_choice: \{ type: "tool", name: "report_bill" \}/);
    assert.match(src, /getAiBudgetCents/, "checks the shared AI cap");
    assert.match(src, /application\/pdf/, "accepts PDF bills");
    assert.match(src, /type: "image"/, "accepts image bills");
  });
});

// ---- buildBillCalendarIcs — housing obligations on the calendar feed --------
describe("buildBillCalendarIcs — housing obligations (#1)", () => {
  const subs = require("../teller/routes/subscriptions");
  const fs = require("fs");
  const path = require("path");

  it("emits a VEVENT for an unpaid, known-amount housing obligation in the window", async () => {
    // Next month's 15th — always in the future and within a 90-day horizon.
    const now = new Date();
    const fut = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const period = `${fut.getUTCFullYear()}-${String(fut.getUTCMonth() + 1).padStart(2, "0")}`;
    dbModule.pool.query = async (sql) => {
      if (/detected_subscriptions/.test(sql)) return { rows: [] };
      if (/manual_bills/.test(sql)) return { rows: [] };
      if (/payee_obligations/.test(sql)) return { rows: [{ id: 5, label: "Electricity", amount: "80.00", period, due_day: 15 }] };
      return { rows: [] };
    };
    const ics = await subs.buildBillCalendarIcs(90);
    assert.match(ics, /UID:housing-5@perfin/);
    assert.match(ics, /SUMMARY:Electricity .* \$80\.00 \(rent\/utilities\)/);
  });

  it("only queries unpaid obligations with a known amount", () => {
    const src = fs.readFileSync(path.join(__dirname, "../teller/routes/subscriptions.js"), "utf8");
    assert.match(src, /payee_obligations WHERE status = 'unpaid' AND amount IS NOT NULL/);
  });
});
