// ============================================================================
// Broad-scan (Sept 2026) Batch 5 regression tests — Rent, Utilities & Settle Up
// (Perfin side; PB-2 lives in apps/per-sistant/tests/scan-sept-batch5.test.js)
// ============================================================================
// FAN-3  obligation generation covers the TRAILING 24 months, not the first 24
//        after start_month (generation used to stop two years after setup)
// FAN-4  a payee / utility-label rename carries the stored rows over instead of
//        regenerating every past month; generation skips periods that already
//        have a row; the ledger + split are scoped to the configured payee
// FAN-9  /api/housing/split reports utilities still awaiting their bill and the
//        Settle Up widget holds "Mark settled" until they're entered
// FAN-10 the double-count guard matches configurable statement merchant names
// FAN-11 Settle Up defaults to the prior month during the first week
// FAN-12 shared-card settlement nets refunds and excludes pending charges
// WUI-3  Settle Up / CSV / link-account links carry the basePath, and the
//        Activity page honors ?account_id=&month= deep links
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
afterEach(() => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; });

const housing = require("../teller/routes/housing");
const { currentMonth } = require("../teller/services/financial-queries");

function mountApp(mod) {
  const app = express();
  app.use(express.json());
  app.use(require(mod));
  return app;
}
const cfgRow = (cfg) => ({ rows: [{ housing_config: cfg }] });

// ---------------------------------------------------------------------------
// FAN-3
// ---------------------------------------------------------------------------
describe("FAN-3 — generation covers the trailing 24 months", () => {
  it("generationMonths ends at the current month even when start_month is >24 months back", () => {
    const m = housing.generationMonths("2024-08", "2026-09");
    assert.equal(m.length, 24);
    assert.equal(m[0], "2024-10");
    assert.equal(m[m.length - 1], "2026-09", "the old forward cap stopped at 2026-07");
    assert.deepEqual(housing.generationMonths("2026-07", "2026-09"), ["2026-07", "2026-08", "2026-09"]);
    assert.equal(housing.addMonths("2026-01", -1), "2025-12");
  });
  it("generateHousingObligations creates THIS month's rent for a ledger set up 3 years ago", async () => {
    const periods = [];
    const fakePool = {
      query: async (sql, params) => {
        if (/housing_config/.test(sql)) return cfgRow({ enabled: true, payee_name: "Sam", rent_amount: 1500, rent_due_day: 1, start_month: housing.addMonths(currentMonth(), -36), utilities: [] });
        if (/INSERT INTO payee_obligations/.test(sql)) { periods.push(params[1]); return { rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      },
    };
    await housing.generateHousingObligations(fakePool);
    assert.ok(periods.includes(currentMonth()), "current month generated");
    assert.equal(periods.length, 24);
  });
});

// ---------------------------------------------------------------------------
// FAN-4
// ---------------------------------------------------------------------------
describe("FAN-4 — renames carry rows over; no history backfill", () => {
  const existing = housing.normalizeConfig({
    enabled: true, payee_name: "Jhon", rent_amount: 1000, start_month: "2025-01",
    utilities: [{ label: "Electric", cadence_months: 1, due_day: 15, anchor: "2025-01" }],
  });
  it("planConfigUpdate detects a payee rename and a utility-label rename (rename_from), keeping the anchor", () => {
    const plan = housing.planConfigUpdate(existing, {
      enabled: true, payee_name: "John", rent_amount: 1000,
      utilities: [{ label: "Electricity", cadence_months: 1, due_day: 15, rename_from: "Electric" }],
    });
    assert.deepEqual(plan.payeeRename, { from: "Jhon", to: "John" });
    assert.deepEqual(plan.labelRenames, [{ from: "Electric", to: "Electricity" }]);
    assert.equal(plan.config.utilities[0].anchor, "2025-01", "renamed utility keeps its cadence anchor");
    assert.equal(plan.config.start_month, "2025-01");
    assert.ok(!("rename_from" in plan.config.utilities[0]));
  });
  it("a brand-new utility is anchored at THIS month (no backfilled placeholder per past cycle)", () => {
    const plan = housing.planConfigUpdate(existing, {
      enabled: true, payee_name: "Jhon",
      utilities: [{ label: "Electric", cadence_months: 1 }, { label: "Internet", cadence_months: 1 }],
    });
    const byLabel = Object.fromEntries(plan.config.utilities.map((u) => [u.label, u]));
    assert.equal(byLabel.Electric.anchor, "2025-01");
    assert.equal(byLabel.Internet.anchor, currentMonth());
    assert.equal(plan.payeeRename, null);
    assert.deepEqual(plan.labelRenames, []);
  });
  it("a rename_from whose old label is still in use is NOT treated as a rename", () => {
    const plan = housing.planConfigUpdate(existing, {
      enabled: true, payee_name: "Jhon",
      utilities: [{ label: "Electric" }, { label: "Gas", rename_from: "Electric" }],
    });
    assert.deepEqual(plan.labelRenames, []);
  });
  it("PATCH /api/housing/config renames stored obligations + payments in one transaction", async () => {
    const log = [];
    const client = {
      query: async (sql, params) => {
        log.push({ sql, params });
        if (/housing_config/.test(sql) && /SELECT/.test(sql)) return cfgRow(existing);
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    dbModule.pool.connect = async () => client;
    // Everything must go through the transaction client — fail fast (no real
    // connection attempt) if the route bypasses it.
    dbModule.pool.query = async () => { throw new Error("unexpected pool.query outside the transaction"); };
    const res = await supertest(mountApp("../teller/routes/housing")).patch("/api/housing/config").send({
      enabled: true, payee_name: "John", rent_amount: 1000,
      utilities: [{ label: "Electricity", cadence_months: 1, due_day: 15, rename_from: "Electric" }],
    });
    assert.equal(res.status, 200);
    const sqls = log.map((l) => l.sql);
    assert.ok(sqls.some((s) => /BEGIN/.test(s)) && sqls.some((s) => /COMMIT/.test(s)));
    const payeeUpd = log.find((l) => /UPDATE payee_obligations o SET payee/.test(l.sql));
    assert.deepEqual(payeeUpd.params, ["Jhon", "John"]);
    assert.match(payeeUpd.sql, /NOT EXISTS/);
    assert.ok(log.some((l) => /UPDATE payee_payments SET payee/.test(l.sql)));
    const labelUpd = log.find((l) => /UPDATE payee_obligations o SET label/.test(l.sql));
    assert.deepEqual(labelUpd.params, ["John", "Electric", "Electricity"]);
  });
  it("generation skips a period that already has rent (any payee) or the same utility label", async () => {
    const sqls = [];
    const fakePool = {
      query: async (sql) => {
        if (/housing_config/.test(sql)) return cfgRow({ enabled: true, payee_name: "John", rent_amount: 1000, start_month: currentMonth(), utilities: [{ label: "Water", anchor: currentMonth() }] });
        if (/INSERT INTO payee_obligations/.test(sql)) { sqls.push(sql); return { rowCount: 0 }; }
        return { rows: [], rowCount: 0 };
      },
    };
    await housing.generateHousingObligations(fakePool);
    const rent = sqls.find((s) => /'rent'/.test(s));
    const util = sqls.find((s) => /'utility'/.test(s));
    assert.match(rent, /WHERE NOT EXISTS \(SELECT 1 FROM payee_obligations WHERE period = \$2 AND category = 'rent'\)/);
    assert.match(util, /WHERE NOT EXISTS \(SELECT 1 FROM payee_obligations WHERE period = \$3 AND category = 'utility' AND label = \$2\)/);
  });
  it("ledger + split are scoped to the configured payee", async () => {
    const seen = [];
    dbModule.pool.query = async (sql, params) => {
      seen.push({ sql, params });
      if (/housing_config/.test(sql)) return cfgRow({ enabled: true, payee_name: "John", split: { enabled: true, car_fixed_amount: 0 } });
      if (/SUM\(amount\)/.test(sql)) return { rows: [{ total: "1000", awaiting: [] }] };
      return { rows: [] };
    };
    const app = mountApp("../teller/routes/housing");
    await supertest(app).get("/api/housing/ledger").expect(200);
    const obl = seen.find((s) => /FROM payee_obligations WHERE \(\$1::text IS NULL OR payee = \$1\)/.test(s.sql));
    assert.deepEqual(obl.params, ["John"]);
    assert.ok(seen.some((s) => /pp\.payee = \$1/.test(s.sql)));
    await supertest(app).get("/api/housing/split").expect(200);
    const sum = seen.find((s) => /SUM\(amount\)/.test(s.sql));
    assert.match(sum.sql, /payee = \$2/);
    assert.equal(sum.params[1], "John");
  });
});

// ---------------------------------------------------------------------------
// FAN-9
// ---------------------------------------------------------------------------
describe("FAN-9 — awaiting utility bills hold the even-up", () => {
  it("/api/housing/split returns awaiting_count + awaiting_labels for the month", async () => {
    dbModule.pool.query = async (sql) => {
      if (/housing_config/.test(sql)) return cfgRow({ enabled: true, payee_name: "Sam", split: { enabled: true, car_fixed_amount: 400 } });
      if (/SUM\(amount\)/.test(sql)) {
        assert.match(sql, /status = 'pending_amount'/);
        return { rows: [{ total: "1200.00", awaiting: ["Electricity", "Water"] }] };
      }
      return { rows: [] };
    };
    const res = await supertest(mountApp("../teller/routes/housing")).get("/api/housing/split").expect(200);
    assert.equal(res.body.awaiting_count, 2);
    assert.deepEqual(res.body.awaiting_labels, ["Electricity", "Water"]);
    assert.equal(res.body.transfer, 400);
  });
  it("the Settle Up widget warns and disables Mark settled while bills are awaited", () => {
    const src = read("teller", "views", "dashboard.ejs");
    assert.match(src, /housing\.awaiting_count/);
    assert.match(src, /awaiting\.length \? ' disabled title=/);
    assert.match(src, /dcNote \+\s*awaitNote \+\s*settleRow/);
  });
});

// ---------------------------------------------------------------------------
// FAN-10
// ---------------------------------------------------------------------------
describe("FAN-10 — double-count guard uses statement merchant names", () => {
  it("merchant_patterns replace the label; label is the fallback", () => {
    const p = housing.buildDoubleCountPattern({
      payee_name: "Sam Vance",
      utilities: [{ label: "Gas", merchant_patterns: ["PG&E", "Pacific Gas"] }, { label: "Water" }],
    });
    assert.match(p, /PG&E/);
    assert.match(p, /Pacific Gas/);
    assert.match(p, /Water/);
    assert.doesNotMatch(p, /\|Gas\||\(Gas\||\|Gas\)/, "the bare 'Gas' label is not used when patterns exist");
    const re = new RegExp(p.replace(/\\y/g, "\\b"), "i");
    assert.ok(re.test("PG&E WEB ONLINE"));
    assert.ok(!re.test("SHELL GAS 1234"));
  });
  it("normalizeConfig parses a comma-separated merchant list and the form sends it", () => {
    const c = housing.normalizeConfig({ utilities: [{ label: "Electricity", merchant_patterns: " Con Ed, ConEdison ,, " }] });
    assert.deepEqual(c.utilities[0].merchant_patterns, ["Con Ed", "ConEdison"]);
    assert.deepEqual(housing.normalizeConfig({ utilities: [{ label: "X" }] }).utilities[0].merchant_patterns, []);
    const ejs = read("teller", "views", "housing.ejs");
    assert.match(ejs, /merchant_patterns: r\.querySelector\('\.hz-u-merchants'\)\.value/);
    assert.match(ejs, /rename_from: r\.getAttribute\('data-orig-label'\)/);
  });
});

// ---------------------------------------------------------------------------
// FAN-11
// ---------------------------------------------------------------------------
describe("FAN-11 — Settle Up defaults to the prior month in the first week", () => {
  it("the selection picks index 1 on days 1–7 and index 0 otherwise", () => {
    const src = read("teller", "views", "dashboard.ejs");
    const m = src.match(/if \(i === \((now\.getDate\(\) <= 7 \? 1 : 0)\)\) \{\s*opt\.selected = true;/);
    assert.ok(m, "simple, non-inverted selection expression");
    for (const [day, want] of [[3, 1], [7, 1], [8, 0], [28, 0]]) {
      const now = { getDate: () => day };
      // eslint-disable-next-line no-new-func
      const pick = new Function("now", "return " + m[1])(now);
      assert.equal(pick, want, "day " + day);
    }
  });
});

// ---------------------------------------------------------------------------
// FAN-12
// ---------------------------------------------------------------------------
describe("FAN-12 — shared-card settlement nets refunds and excludes pending", () => {
  it("query includes non-transfer credits, excludes pending; response carries refunds_total + account_key", async () => {
    let sql = "";
    dbModule.pool.query = async (s) => {
      if (/partner_name/.test(s)) return { rows: [{ partner_name: "Sarah" }] };
      sql = s;
      return { rows: [{
        account_id: 4, account_key: "acc_card", account_name: "Joint Card", split_pct: 50, txn_count: 2,
        total_charges: "0.00", refunds_total: "200.00", shared_total: "0.00", shared_count: 2,
        your_personal_total: "0", your_personal_count: 0, partner_personal_total: "0", partner_personal_count: 0,
      }] };
    };
    const res = await supertest(mountApp("../teller/routes/subscriptions")).get("/api/shared-settlement?month=2026-09").expect(200);
    assert.match(sql, /t\.amount > 0 OR \(t\.amount < 0 AND/);
    assert.match(sql, /t\.pending = false/);
    assert.match(sql, /payment thank/, "NOT_TRANSFER keeps card payments out of the refund netting");
    const a = res.body.accounts[0];
    assert.equal(a.account_key, "acc_card");
    assert.equal(a.refunds_total, 200);
    assert.equal(a.partner_share, 0, "a $200 purchase refunded the same month bills the partner nothing");
  });
});

// ---------------------------------------------------------------------------
// WUI-3
// ---------------------------------------------------------------------------
describe("WUI-3 — basePath links + Activity deep-link filters", () => {
  it("Settle Up / CSV / link-account links carry the base path and point at real pages", () => {
    const src = read("teller", "views", "dashboard.ejs");
    assert.doesNotMatch(src, /href="\/housing"/);
    assert.doesNotMatch(src, /href="\/transactions\?/);
    assert.doesNotMatch(src, /href="\/"/, "no link to the shell tile picker");
    assert.match(src, /\(window\.BASE_PATH \|\| ''\) \+ '\/transactions\?account_id=' \+ encodeURIComponent\(a\.account_key/);
    assert.match(src, /href="<%= basePath %>\/accounts"[^>]*>Import CSV/);
  });
  it("the Activity page reads account_id/month from the query string and filters by account", () => {
    const js = read("teller", "public", "transactions.js");
    assert.match(js, /new URLSearchParams\(window\.location\.search\)/);
    assert.match(js, /urlParams\.get\('month'\)/);
    assert.match(js, /urlParams\.get\('account_id'\)/);
    assert.match(js, /params\.set\('account_id', filters\.account_id\)/);
    assert.match(read("teller", "views", "transactions.ejs"), /id="filter-account"/);
  });
  it("the search endpoint honors account_id", async () => {
    let captured;
    dbModule.pool.query = async (sql, params) => { captured = { sql, params }; return { rows: [{ total: 0 }] }; };
    await supertest(mountApp("../teller/routes/transactions")).get("/api/transactions/search?account_id=acc_card");
    assert.ok(captured.params.includes("acc_card"));
  });
});
