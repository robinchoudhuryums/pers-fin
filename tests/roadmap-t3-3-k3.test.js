// ============================================================================
// Roadmap T3.3 K3 — the year-end tax package: one definition per figure +
// downloads
// ============================================================================
// The two refactors leave their exports unchanged byte for byte (a snapshot of
// /api/export/tax-report and /api/housing/export CSV + JSON over canned rows).
// gatherTaxPackage over injected readers (every section, one failing read
// isolated with its fixed sentence, the overview) and over a SQL-routing fake
// pool with the REAL readers (the shared definitions are what it calls). The
// ZIP read back with a parser written here (local headers, central directory,
// end record, CRC-32 against known vectors, names and contents). The PDF
// (%PDF, a bookmark per section, the disclaimer on the first and last page).
// The CSV formula guard in every section. GET /api/tax/package's year /
// format 400s, content types and fixed 500. The real-SQL half (the package
// agreeing with both exports to the cent) is tests/contract/tax-package.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const tp = require("../teller/services/tax-package");
const zip = require("../teller/services/zip-store");
const originalGather = tp.gatherTaxPackage;
afterEach(() => { dbModule.pool.query = originalQuery; tp.gatherTaxPackage = originalGather; });

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const HYPER = '=HYPERLINK("http://x")';

// ---------------------------------------------------------------------------
// An independent ZIP reader (STORE only) — never the production writer's code.
// ---------------------------------------------------------------------------
function crcRef(buf) {
  // Bitwise CRC-32, no table — a second implementation to check the first.
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, "end of central directory signature");
  const count = buf.readUInt16LE(eocd + 10);
  assert.equal(buf.readUInt16LE(eocd + 8), count);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  assert.equal(cdOff + cdSize, eocd, "central directory ends at the end record");
  const files = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central header signature");
    assert.equal(buf.readUInt16LE(p + 10), 0, "stored");
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("ascii");
    // The local header agrees with its central record.
    assert.equal(buf.readUInt32LE(local), 0x04034b50, "local header signature");
    assert.equal(buf.readUInt16LE(local + 8), 0);
    assert.equal(buf.readUInt32LE(local + 14), crc);
    assert.equal(buf.readUInt32LE(local + 18), csize);
    assert.equal(buf.readUInt32LE(local + 22), usize);
    const lnlen = buf.readUInt16LE(local + 26);
    const lelen = buf.readUInt16LE(local + 28);
    assert.equal(buf.slice(local + 30, local + 30 + lnlen).toString("ascii"), name);
    const data = buf.slice(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
    assert.equal(csize, usize);
    assert.equal(crcRef(data), crc, "CRC of " + name);
    files.push({ name, data, time: buf.readUInt16LE(p + 12), date: buf.readUInt16LE(p + 14) });
    p += 46 + nlen + elen + clen;
  }
  return files;
}

// The text of each pdfkit content stream (Flate-decoded, hex glyph strings).
function pdfPages(buf) {
  const s = buf.toString("latin1");
  const out = [];
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let b;
    try { b = zlib.inflateSync(Buffer.from(m[1], "latin1")); } catch { continue; } // not a Flate stream (a font file) — not page text
    const t = b.toString("latin1");
    const text = [...t.matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => Buffer.from(x[1], "hex").toString("latin1")).join("");
    if (text) out.push(text);
  }
  return out;
}
const pdfBookmarks = (buf) => [...buf.toString("latin1").matchAll(/\/Title \(((?:\\.|[^)\\])*)\)/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));

describe("zip-store", () => {
  it("crc32 matches the standard check values", () => {
    assert.equal(zip.crc32("123456789"), 0xcbf43926);
    assert.equal(zip.crc32(""), 0);
    assert.equal(zip.crc32(Buffer.from("The quick brown fox jumps over the lazy dog")), 0x414fa339);
    const rnd = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 131 + 7) & 0xff));
    assert.equal(zip.crc32(rnd), crcRef(rnd));
  });

  it("writes a STORE archive a reader takes back: headers, directory, CRCs, names and bytes", () => {
    const bin = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    const out = zip.createZip([
      { name: "a.csv", data: "x,y\n1,2\n" },
      { name: "dir/b.bin", data: bin },
      { name: "empty.txt", data: "" },
    ], { date: new Date(Date.UTC(2026, 1, 3, 14, 30, 22)) });
    const files = readZip(out);
    assert.deepEqual(files.map((f) => f.name), ["a.csv", "dir/b.bin", "empty.txt"]);
    assert.equal(files[0].data.toString(), "x,y\n1,2\n");
    assert.deepEqual([...files[1].data], [...bin]);
    assert.equal(files[2].data.length, 0);
    // DOS date / time from the UTC fields: 2026-02-03 14:30:22.
    assert.equal(files[0].date, ((2026 - 1980) << 9) | (2 << 5) | 3);
    assert.equal(files[0].time, (14 << 11) | (30 << 5) | 11);
    // An empty archive is just the end record.
    assert.equal(zip.createZip([]).length, 22);
  });

  it("takes the DOS date / time from the date's UTC fields whatever the server zone", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const [f] = readZip(zip.createZip([{ name: "a", data: "1" }], { date: new Date(Date.UTC(2026, 0, 1, 3, 4, 6)) }));
      assert.equal(f.date, ((2026 - 1980) << 9) | (1 << 5) | 1);
      assert.equal(f.time, (3 << 11) | (4 << 5) | 3);
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it("refuses a name that isn't a plain relative ASCII path, and duplicates", () => {
    for (const name of ["", "/abs.csv", "../up.csv", "a/../b", "a//b", "back\\slash", "naïve.csv", "tab\tname", " lead", "x".repeat(256), null]) {
      assert.throws(() => zip.createZip([{ name, data: "1" }]), /invalid file name/, String(name));
    }
    assert.throws(() => zip.createZip([{ name: "a", data: "1" }, { name: "a", data: "2" }]), /duplicate/);
  });
});

// ---------------------------------------------------------------------------
// The two exports, unchanged by the refactor (snapshots taken before it)
// ---------------------------------------------------------------------------
const TAX_TXNS = [
  { transaction_id: "t1", date: "2025-03-04", merchant: "City Pharmacy", amount: "42.10" },
  { transaction_id: "t2", date: "2025-01-15", merchant: '=HYPERLINK("x")Red Cross Donation', amount: "100.00" },
  { transaction_id: "t3", date: "2025-06-01", merchant: "State University Tuition", amount: "4000.5" },
  { transaction_id: "t4", date: "2025-02-02", merchant: "City Pharmacy", amount: "7.333" },
];
const PAYMENTS = [
  { id: 1, payee: "Sam Lee", paid_date: "2025-01-03", amount: "1800.00", memo: "Jan 2025 Rent", covers: [{ label: "Rent", period: "2025-01" }] },
  { id: 2, payee: "Sam Lee", paid_date: "2025-02-03", amount: "1950.25", memo: "+Feb", covers: [{ label: "Rent", period: "2025-02" }, { label: "Electricity", period: "2025-01" }] },
];
function exportsPool(sql) {
  if (/FROM transactions t/.test(sql)) return { rows: TAX_TXNS };
  if (/FROM tax_deductions/.test(sql)) return { rows: [{ merchant: "city pharmacy", category: "medical", is_confirmed: true, notes: "Rx, copay" }] };
  if (/housing_config/.test(sql)) return { rows: [{ housing_config: { enabled: true, payee_name: "Sam Lee", rent_amount: 1800, rent_due_day: 1 } }] };
  if (/FROM payee_payments/.test(sql)) return { rows: PAYMENTS };
  throw new Error("unexpected SQL " + sql.slice(0, 60));
}
const TAX_CSV = [
  "Tax Year,Date,Merchant,Amount,Category,Type,Notes,Confirmed",
  '2025,2025-01-15,"\'=HYPERLINK(""x"")Red Cross Donation",100.00,"charity","keyword_match","",false',
  '2025,2025-06-01,"State University Tuition",4000.50,"education","keyword_match","",false',
  '2025,2025-02-02,"City Pharmacy",7.33,"medical","keyword_match","Rx, copay",true',
  '2025,2025-03-04,"City Pharmacy",42.10,"medical","keyword_match","Rx, copay",true',
  "",
  "SUMMARY BY CATEGORY",
  "Category,Total",
  '"charity",100.00',
  '"education",4000.50',
  '"medical",49.43',
  "",
  "GRAND TOTAL,4149.93",
].join("\n");
const HOUSING_CSV = [
  "Date,Amount,Memo,Covers,Payee",
  '2025-01-03,1800.00,"Jan 2025 Rent","Jan 2025 Rent","Sam Lee"',
  '2025-02-03,1950.25,"\'+Feb","Feb 2025 Rent; Jan 2025 Electricity","Sam Lee"',
  ',3750.25,"Total 2025",,',
  "",
].join("\n");

describe("the existing exports keep their output", () => {
  const app = () => {
    const a = express();
    a.use(require("../teller/routes/settings"));
    a.use(require("../teller/routes/housing"));
    return a;
  };

  it("GET /api/export/tax-report CSV and JSON are byte-identical to before the refactor", async () => {
    dbModule.pool.query = async (sql) => exportsPool(sql);
    const csv = await supertest(app()).get("/api/export/tax-report?year=2025&format=csv").expect(200);
    assert.equal(csv.text, TAX_CSV);
    const json = await supertest(app()).get("/api/export/tax-report?year=2025&format=json").expect(200);
    assert.equal(json.body.grand_total, 4149.93);
    assert.equal(json.body.item_count, 4);
    assert.deepEqual(Object.keys(json.body.categories), ["charity", "education", "medical"]);
    assert.deepEqual(json.body.categories.medical.items.map((d) => [d.txn_date, d.amount, d.notes, d.is_confirmed]),
      [["2025-02-02", "7.33", "Rx, copay", true], ["2025-03-04", "42.10", "Rx, copay", true]]);
    assert.deepEqual(Object.keys(json.body.categories.medical.items[0]),
      ["tax_year", "txn_date", "transaction_id", "merchant", "amount", "category", "deduction_type", "notes", "is_confirmed"]);
  });

  it("GET /api/housing/export CSV and JSON are byte-identical to before the refactor", async () => {
    dbModule.pool.query = async (sql) => exportsPool(sql);
    const csv = await supertest(app()).get("/api/housing/export?year=2025&format=csv").expect(200);
    assert.equal(csv.text, HOUSING_CSV);
    const json = await supertest(app()).get("/api/housing/export?year=2025&format=json").expect(200);
    assert.equal(json.text, JSON.stringify({ year: 2025, payee: "Sam Lee", total: 3750.25, payments: PAYMENTS }));
  });

  it("getTaxDeductionReport keeps the rows unannotated when the annotation read fails", async () => {
    const { getTaxDeductionReport } = require("../teller/services/financial-queries");
    const pool = { query: async (sql) => {
      if (/FROM tax_deductions/.test(sql)) throw new Error("relation missing");
      return exportsPool(sql);
    } };
    const rows = await getTaxDeductionReport(pool, 2025);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.notes === null && r.is_confirmed === false));
    assert.deepEqual(rows.map((r) => r.category), ["charity", "education", "medical", "medical"]);
  });

  it("getHousingPayments names the configured payee over a payment's stored one", async () => {
    const { getHousingPayments } = require("../teller/routes/housing");
    const renamed = PAYMENTS.map((p) => ({ ...p, payee: "Old Name" }));
    const pool = (cfgName) => ({ query: async (sql) => {
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: { enabled: true, payee_name: cfgName } }] };
      if (/FROM payee_payments/.test(sql)) return { rows: renamed };
      throw new Error("unexpected SQL");
    } });
    const r = await getHousingPayments(2025, pool("Sam Lee"));
    assert.equal(r.payee, "Sam Lee");
    assert.equal(r.total, 3750.25);
    assert.equal((await getHousingPayments(2025, pool(""))).payee, "Old Name");
    const none = { query: async (sql) => (/housing_config/.test(sql) ? Promise.reject(new Error("x")) : { rows: [] }) };
    assert.deepEqual(await getHousingPayments(2025, none), { year: 2025, payee: "Payee", total: 0, payments: [] });
  });

  it("each route reads through the shared definition and builds no CSV of its own", () => {
    const s = read("teller/routes/settings.js");
    const route = s.slice(s.indexOf('router.get("/api/export/tax-report"'));
    assert.match(route, /getTaxDeductionReport\(pool, year\)/);
    assert.match(route, /taxReportCsv\(deductions\.rows\)/);
    assert.doesNotMatch(route, /FROM tax_deductions|getTaxDeductionTransactions|SUMMARY BY CATEGORY/);
    const h = read("teller/routes/housing.js");
    const exp = h.slice(h.indexOf('router.get("/api/housing/export"'), h.indexOf("// POST /api/housing/scan-bill"));
    assert.match(exp, /getHousingPayments\(year\)/);
    assert.match(exp, /housingPaymentsCsv\(data\)/);
    assert.doesNotMatch(exp, /FROM payee_payments|Date,Amount,Memo/);
  });
});

// ---------------------------------------------------------------------------
// gatherTaxPackage
// ---------------------------------------------------------------------------
const INCOME = {
  year: 2025, total: 52012.5,
  by_kind: { wages: 50000, interest: 12.5, dividends: 0, other: 2000 },
  by_source: [
    { source: "ACME PAYROLL", kind: "wages", institution: "Chase", total: 50000, count: 24, first_date: "2025-01-15", last_date: "2025-12-31" },
    { source: HYPER, kind: "other", institution: "Chase", total: 2000, count: 1, first_date: "2025-06-01", last_date: "2025-06-01" },
    { source: "SAVINGS INTEREST", kind: "interest", institution: "Ally", total: 12.5, count: 12, first_date: "2025-01-31", last_date: "2025-12-31" },
  ],
  by_month: [{ month: "2025-01", total: 4180.2 }, { month: "2025-02", total: 4167.9 }],
};
const INV = {
  year: 2025,
  accounts: [
    { id: 1, name: "Brokerage", institution: "Schwab", account_type: "brokerage", tax_advantaged: false },
    { id: 2, name: "Rollover IRA", institution: "Schwab", account_type: "ira", tax_advantaged: true },
  ],
  realized_gains: {
    sales: [
      { date: "2025-04-10", investment_account_id: 1, account_name: "Brokerage", ticker: "VTI", security_name: HYPER, quantity: 3, proceeds: 900, cost_basis: 600, gain: 300, term: "long", basis_coverage: "full", corporate_action: false },
      { date: "2025-09-01", investment_account_id: 1, account_name: "Brokerage", ticker: "XYZ", security_name: "XYZ Corp", quantity: 1, proceeds: 50, cost_basis: null, gain: null, term: "unknown", basis_coverage: "none", corporate_action: true },
    ],
    totals: { short: { proceeds: 0, cost_basis: 0, gain: 0, count: 0 }, long: { proceeds: 900, cost_basis: 600, gain: 300, count: 1 }, unknown: { proceeds: 50, count: 1 } },
    corporate_action_securities: 1,
  },
  investment_income: {
    accounts: [{ investment_account_id: 1, account_name: "Brokerage", institution: "Schwab", account_type: "brokerage", dividends: 120.4, qualified_dividends: 100, interest: 3.1, capital_gain_distributions_long: 20, capital_gain_distributions_short: 5, tax_withheld: 1.2 }],
    totals: { dividends: 120.4, qualified_dividends: 100, interest: 3.1, capital_gain_distributions_long: 20, capital_gain_distributions_short: 5, tax_withheld: 1.2 },
  },
  retirement: { distributions: [{ date: "2025-07-01", investment_account_id: 2, account_name: "Rollover IRA", institution: "Schwab", account_type: "ira", amount: 600 }], total: 600 },
  earliest_transaction_date: "2023-11-02",
};
const DED = [
  { tax_year: 2025, txn_date: "2025-01-15", transaction_id: "t2", merchant: HYPER, amount: "100.00", category: "charity", deduction_type: "keyword_match", notes: null, is_confirmed: false },
  { tax_year: 2025, txn_date: "2025-03-04", transaction_id: "t1", merchant: "City Pharmacy", amount: "42.10", category: "medical", deduction_type: "keyword_match", notes: "Rx", is_confirmed: true },
  { tax_year: 2025, txn_date: "2025-05-04", transaction_id: "t5", merchant: "City Pharmacy", amount: "0.07", category: "medical", deduction_type: "keyword_match", notes: "Rx", is_confirmed: true },
];
const RENT = { year: 2025, payee: "Sam Lee", total: 3750.2500000001, payments: PAYMENTS.map((p) => ({ ...p, memo: p.id === 2 ? HYPER : p.memo })) };
const DOCS = [
  { id: 1, tax_year: 2025, form: "W-2", issuer: "ACME", expected_by: "2026-01-31", received_at: "2026-01-20", dismissed_at: null, origin: "suggested", notes: null, state: "received" },
  { id: 2, tax_year: 2025, form: "1099-B", issuer: HYPER, expected_by: "2026-02-15", received_at: null, dismissed_at: null, origin: "suggested", notes: "-from the portal", state: "waiting" },
  { id: 3, tax_year: 2025, form: "1099-INT", issuer: "Ally", expected_by: "2026-01-31", received_at: null, dismissed_at: null, origin: "suggested", notes: null, state: "overdue" },
];
const calls = [];
const fail = (msg = "relation does not exist: secret detail") => async () => { throw new Error(msg); };
const deps = (over = {}) => ({
  today: "2026-02-10",
  getIncomeForYear: async (pool, y) => { calls.push(["income", y]); return INCOME; },
  getInvestmentTaxData: async (pool, y) => { calls.push(["inv", y]); return INV; },
  getTaxDeductionReport: async (pool, y) => { calls.push(["ded", y]); return DED; },
  getHousingPayments: async (y, pool) => { calls.push(["rent", y, !!pool]); return RENT; },
  listTaxDocuments: async (pool, y, today) => { calls.push(["docs", y, today]); return DOCS; },
  ...over,
});

describe("gatherTaxPackage", () => {
  it("assembles every section from the shared readers, investments read once", async () => {
    calls.length = 0;
    const pkg = await tp.gatherTaxPackage({}, 2025, deps());
    assert.deepEqual(calls.map((c) => c[0]).sort(), ["ded", "docs", "income", "inv", "rent"]);
    assert.ok(calls.every((c) => c[1] === 2025));
    assert.deepEqual(calls.find((c) => c[0] === "docs"), ["docs", 2025, "2026-02-10"]);
    assert.equal(pkg.year, 2025);
    assert.equal(pkg.generated_on, "2026-02-10");
    for (const k of tp.SECTION_ORDER) assert.equal(pkg[k].ok, true, k);
    assert.deepEqual(pkg.income.by_kind, INCOME.by_kind);
    assert.equal(pkg.income.total, 52012.5);
    assert.equal(pkg.income.by_source.length, 3);
    assert.deepEqual(pkg.investment_income.totals, INV.investment_income.totals);
    assert.deepEqual(pkg.realized_gains.coverage, { full: 1, partial: 0, none: 1 });
    assert.equal(pkg.realized_gains.corporate_action_securities, 1);
    assert.equal(pkg.realized_gains.earliest_transaction_date, "2023-11-02");
    assert.equal(pkg.retirement.total, 600);
    assert.deepEqual(pkg.retirement.accounts.map((a) => a.name), ["Rollover IRA"]);
    assert.deepEqual(pkg.deductions.by_category, { charity: 100, medical: 42.17 });
    assert.equal(pkg.deductions.total, 142.17);
    assert.equal(pkg.deductions.count, 3);
    assert.equal(pkg.rent_paid.total, 3750.25);
    assert.equal(pkg.rent_paid.payee, "Sam Lee");
    assert.deepEqual(pkg.documents.counts, { received: 1, dismissed: 0, overdue: 1, waiting: 1 });
    assert.deepEqual(pkg.overview, {
      year: 2025, income_total: 52012.5, investment_income_total: 148.5,
      realized_gain_known: 300, sales_without_basis: 1, retirement_distributions_total: 600,
      deductions_total: 142.17, rent_paid_total: 3750.25, documents_open: 2, documents_overdue: 1,
      sections_failed: [],
    });
    assert.equal(pkg.notes[0], tp.DISCLAIMER);
    assert.equal(pkg.disclaimer, tp.DISCLAIMER);
    assert.ok(pkg.notes.some((n) => /1099-B is the authority/.test(n)));
    assert.ok(pkg.notes.some((n) => /at your share/.test(n)));
  });

  it("a failing read marks only its section(s), with a fixed sentence, never the error text", async () => {
    const pkg = await tp.gatherTaxPackage({}, 2025, deps({ getInvestmentTaxData: fail() }));
    for (const k of ["investment_income", "realized_gains", "retirement"]) {
      assert.deepEqual(pkg[k], { ok: false, error: tp.SECTION_ERRORS.investments }, k);
    }
    for (const k of ["income", "deductions", "rent_paid", "documents"]) assert.equal(pkg[k].ok, true, k);
    assert.deepEqual(pkg.overview.sections_failed, ["investment_income", "realized_gains", "retirement"]);
    assert.equal(pkg.overview.realized_gain_known, null);
    assert.equal(pkg.overview.income_total, 52012.5);
    assert.doesNotMatch(JSON.stringify(pkg), /secret detail/);

    for (const [dep, key] of [["getIncomeForYear", "income"], ["getTaxDeductionReport", "deductions"], ["getHousingPayments", "rent_paid"], ["listTaxDocuments", "documents"]]) {
      const p = await tp.gatherTaxPackage({}, 2025, deps({ [dep]: fail() }));
      assert.deepEqual(p[key], { ok: false, error: tp.SECTION_ERRORS[key] }, key);
      assert.deepEqual(p.overview.sections_failed, [key]);
      assert.equal(tp.SECTION_ORDER.filter((k) => p[k].ok).length, tp.SECTION_ORDER.length - 1);
    }
  });

  it("a reader that throws synchronously is still contained", async () => {
    const pkg = await tp.gatherTaxPackage({}, 2025, deps({ getInvestmentTaxData: () => { throw new Error("sync"); } }));
    assert.equal(pkg.realized_gains.ok, false);
    assert.equal(pkg.income.ok, true);
  });

  it("refuses a year that isn't a whole year from 2000", async () => {
    for (const y of [1999, 2025.5, "2025", null, NaN]) {
      await assert.rejects(() => tp.gatherTaxPackage({}, y, deps()), /year must be an integer/, String(y));
    }
  });

  it("with no readers injected it calls the shared definitions (one SQL-routed fake pool)", async () => {
    const seen = new Set();
    const pool = { query: async (sql) => {
      if (/AS kind/.test(sql)) { seen.add("income"); return { rows: [{ source: "ACME", kind: "wages", institution: "Chase", month: "2025-01", total: "1000.004", count: 1, first_date: "2025-01-15", last_date: "2025-01-15" }] }; }
      if (/FROM investment_accounts/.test(sql)) { seen.add("inv-accounts"); return { rows: [] }; }
      if (/FROM investment_transactions/.test(sql)) { seen.add("inv-txns"); return { rows: [] }; }
      if (/FROM transactions t/.test(sql)) { seen.add("deductions"); return { rows: TAX_TXNS.slice(0, 1) }; }
      if (/FROM tax_deductions/.test(sql)) return { rows: [] };
      if (/housing_config/.test(sql)) return { rows: [{ housing_config: { enabled: true, payee_name: "Sam Lee" } }] };
      if (/FROM payee_payments/.test(sql)) { seen.add("rent"); return { rows: PAYMENTS }; }
      if (/FROM tax_documents/.test(sql)) { seen.add("docs"); return { rows: [] }; }
      throw new Error("unexpected SQL " + sql.slice(0, 80));
    } };
    const pkg = await tp.gatherTaxPackage(pool, 2025, { today: "2026-02-10" });
    assert.deepEqual([...seen].sort(), ["deductions", "docs", "income", "inv-accounts", "inv-txns", "rent"]);
    for (const k of tp.SECTION_ORDER) assert.equal(pkg[k].ok, true, k);
    assert.equal(pkg.income.total, 1000);
    assert.equal(pkg.deductions.rows[0].merchant, "City Pharmacy");
    assert.equal(pkg.rent_paid.total, 3750.25);
  });
});

// ---------------------------------------------------------------------------
// CSV, PDF, ZIP
// ---------------------------------------------------------------------------
describe("the package downloads", () => {
  it("every section's CSV guards formula-looking text and prints dates plainly", async () => {
    const pkg = await tp.gatherTaxPackage({}, 2025, deps());
    const files = tp.packageCsvFiles(pkg);
    for (const name of ["deductions.csv", "income.csv", "realized_gains.csv", "rent_paid.csv", "documents.csv"]) {
      assert.ok(files[name].includes(`"'=HYPERLINK(""http://x"")"`), name);
      assert.doesNotMatch(files[name], /(^|,)"=HYPERLINK/m, name);
    }
    assert.ok(files["documents.csv"].includes(`"'-from the portal"`));
    assert.match(files["income.csv"], /^Source,Kind,Institution,Total,Deposits,First Deposit,Last Deposit\n"ACME PAYROLL","wages","Chase",50000.00,24,2025-01-15,2025-12-31\n/);
    assert.match(files["income.csv"], /\nMonth,Total\n"2025-01",4180.20\n"2025-02",4167.90\n$/);
    assert.match(files["investment_income.csv"], /\n"Brokerage","Schwab","brokerage",120.40,100.00,3.10,20.00,5.00,1.20\n"TOTAL",,,120.40,100.00,3.10,20.00,5.00,1.20\n$/);
    assert.match(files["retirement.csv"], /\n2025-07-01,"Rollover IRA","Schwab","ira",600.00\n,"TOTAL",,,600.00\n$/);
    assert.match(files["documents.csv"], /\n"W-2","ACME",2026-01-31,2026-01-20,,"received","suggested",""\n/);
    // An unknown basis is a blank cell, never 0.00.
    assert.match(files["realized_gains.csv"], /\n2025-09-01,"Brokerage","XYZ","XYZ Corp",1,50.00,,,"unknown","none",true\n/);
    assert.match(files["realized_gains.csv"], /"TOTAL LONG-TERM",,,,900.00,600.00,300.00,,,\n,"TOTAL UNKNOWN BASIS",,,,50.00,,,,,\n$/);
    // deductions.csv is the tax-report CSV; rent_paid.csv the landlord CSV.
    assert.equal(files["deductions.csv"], tp.taxReportCsv(DED));
    const { housingPaymentsCsv } = require("../teller/routes/housing");
    assert.equal(files["rent_paid.csv"], housingPaymentsCsv(RENT));
  });

  it("a failed section's CSV carries its fixed sentence", async () => {
    const pkg = await tp.gatherTaxPackage({}, 2025, deps({ getHousingPayments: fail(), getInvestmentTaxData: fail() }));
    const files = tp.packageCsvFiles(pkg);
    assert.equal(files["rent_paid.csv"], `Error\n"${tp.SECTION_ERRORS.rent_paid}"\n`);
    for (const n of ["investment_income.csv", "realized_gains.csv", "retirement.csv"]) {
      assert.equal(files[n], `Error\n"${tp.SECTION_ERRORS.investments}"\n`);
    }
  });

  it("the PDF has a bookmark per section and the disclaimer on its first and last page", async () => {
    const pkg = await tp.gatherTaxPackage({}, 2025, deps());
    const pdf = await tp.renderPackagePdf(pkg);
    assert.equal(pdf.slice(0, 5).toString(), "%PDF-");
    assert.deepEqual(pdfBookmarks(pdf).filter((t) => Object.values(tp.TITLES).includes(t)), Object.values(tp.TITLES));
    const pages = pdfPages(pdf);
    assert.ok(pages.length >= 2, "more than one page");
    const head = "For informational purposes only";
    assert.ok(pages[0].includes(head), "first page");
    assert.ok(pages[pages.length - 1].trimEnd().endsWith("Consult a tax professional before filing."), "last page");
    assert.ok(pages[pages.length - 1].includes(head));
    const all = pages.join("");
    for (const s of ["Tax package 2025", "Rollover IRA", "Total paid to Sam Lee", "1099-B is the authority", "sale(s) without a basis"]) {
      assert.ok(all.includes(s), s);
    }
  });

  it("a failed section's sentence shows in the PDF", async () => {
    const pkg = await tp.gatherTaxPackage({}, 2025, deps({ listTaxDocuments: fail() }));
    const all = pdfPages(await tp.renderPackagePdf(pkg)).join("");
    assert.ok(all.includes(tp.SECTION_ERRORS.documents));
    assert.ok(all.includes("Not available: Tax documents."));
  });

  it("the ZIP holds summary.pdf, a CSV per section and package.json", async () => {
    const pkg = await tp.gatherTaxPackage({}, 2025, deps());
    const files = readZip(await tp.buildPackageZip(pkg, { date: new Date(Date.UTC(2026, 1, 10)) }));
    assert.deepEqual(files.map((f) => f.name), [
      "summary.pdf", "deductions.csv", "income.csv", "investment_income.csv",
      "realized_gains.csv", "retirement.csv", "rent_paid.csv", "documents.csv", "package.json",
    ]);
    const by = Object.fromEntries(files.map((f) => [f.name, f.data]));
    assert.equal(by["summary.pdf"].slice(0, 5).toString(), "%PDF-");
    const csv = tp.packageCsvFiles(pkg);
    for (const n of Object.keys(csv)) assert.equal(by[n].toString("utf8"), csv[n], n);
    assert.deepEqual(JSON.parse(by["package.json"].toString("utf8")), JSON.parse(JSON.stringify(pkg)));
  });
});

// ---------------------------------------------------------------------------
// GET /api/tax/package
// ---------------------------------------------------------------------------
describe("GET /api/tax/package", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/tax")); return a; };
  const thisYear = Number(require("../teller/services/financial-queries").todayStr().slice(0, 4));
  const canned = async (pool, y) => originalGather(pool, y, deps());

  it("400s a bad year or format before reading anything", async () => {
    let gathered = 0;
    tp.gatherTaxPackage = async () => { gathered += 1; return {}; };
    for (const y of ["", "1999", String(thisYear + 1), "2025.5", "abc"]) {
      const r = await supertest(app()).get("/api/tax/package?year=" + y).expect(400);
      assert.match(r.body.error, /whole year from 2000/);
    }
    await supertest(app()).get("/api/tax/package").expect(400);
    for (const f of ["csv", "xlsx", ""]) {
      const r = await supertest(app()).get(`/api/tax/package?year=${thisYear - 1}&format=${f}`).expect(400);
      assert.equal(r.body.error, "format must be json, pdf or zip");
    }
    assert.equal(gathered, 0);
  });

  it("json by default, pdf and zip as attachments", async () => {
    tp.gatherTaxPackage = canned;
    const y = thisYear - 1;
    const j = await supertest(app()).get("/api/tax/package?year=" + y).expect(200);
    assert.equal(j.body.year, y);
    assert.equal(j.body.deductions.total, 142.17);
    const p = await supertest(app()).get(`/api/tax/package?year=${y}&format=PDF`).buffer(true).parse((res, cb) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c)));
    }).expect(200);
    assert.equal(p.headers["content-type"], "application/pdf");
    assert.equal(p.headers["content-disposition"], `attachment; filename=perfin_tax_package_${y}.pdf`);
    assert.equal(p.headers["cache-control"], "no-store");
    assert.equal(p.body.slice(0, 5).toString(), "%PDF-");
    const z = await supertest(app()).get(`/api/tax/package?year=${y}&format=zip`).buffer(true).parse((res, cb) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c)));
    }).expect(200);
    assert.equal(z.headers["content-type"], "application/zip");
    assert.equal(z.headers["content-disposition"], `attachment; filename=perfin_tax_package_${y}.zip`);
    assert.equal(readZip(z.body).length, 9);
  });

  it("an unexpected failure is a fixed 500", async () => {
    tp.gatherTaxPackage = async () => { throw new Error("pool exploded: password=hunter2"); };
    const r = await supertest(app()).get(`/api/tax/package?year=${thisYear - 1}`).expect(500);
    assert.deepEqual(r.body, { error: "Could not build the tax package." });
  });

  it("is mounted with the other tax routes and documented", () => {
    assert.match(read("teller/routes/tax.js"), /router\.get\("\/api\/tax\/package"/);
    assert.match(read("CLAUDE.md"), /GET \/api\/tax\/package/);
  });
});
