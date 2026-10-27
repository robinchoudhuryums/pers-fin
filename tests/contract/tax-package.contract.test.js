// Real-Postgres contract test for roadmap T3.3 K3 — the year-end tax package
// agrees with the exports that already show its figures:
//  - deductions: gatherTaxPackage's rows, per-category totals and total equal
//    GET /api/export/tax-report?format=json to the cent, and the ZIP's
//    deductions.csv is the export's CSV byte for byte (a formula-looking
//    merchant guarded in both);
//  - rent paid: the package's payments and total equal
//    GET /api/housing/export?format=json, and rent_paid.csv is that export's CSV;
//  - income equals getIncomeForYear (a joint deposit at 50%); investment income,
//    a FIFO sale and the documents checklist come through from K1 / K2's tables;
//  - GET /api/tax/package json / zip through the real mount order, and a year
//    with nothing recorded renders every section empty.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("ascii");
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out[name] = buf.slice(start, start + size);
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}
const binary = (res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); };

describe("Tax package (T3.3 K3) on real Postgres", { skip: SKIP }, () => {
  let pfPool, app, tp, fq, Y;
  const q = (s, p) => pfPool.query(s, p);

  before(async () => {
    pfPool = await perfinDb("taxpackage");
    app = perfinApp();
    tp = require("../../teller/services/tax-package");
    fq = require("../../teller/services/financial-queries");
    Y = Number(fq.todayStr().slice(0, 4)) - 1;

    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('card','Card','credit','credit card',true), ('chk','Checking','depository','checking',true)");
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, is_shared, spending_split_pct) VALUES ('joint','Joint','depository','checking',true,true,50)");
    const tx = (id, acct, amt, date, merchant, name) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending)
       VALUES ($1,$2,$3,$4,$5,$6,false)`, [acct, id, amt, date, merchant, name]);
    // Deductions: charity (a formula-looking merchant), two pharmacy rows and tuition;
    // a reimbursed one and one from the year before stay out.
    await tx("d1", "card", 100, `${Y}-01-15`, '=HYPERLINK("x") Red Cross Donation', "RED CROSS");
    await tx("d2", "card", 42.1, `${Y}-03-04`, "City Pharmacy", "CITY PHARMACY");
    await tx("d3", "card", 7.33, `${Y}-02-02`, "City Pharmacy", "CITY PHARMACY");
    await tx("d4", "card", 4000.5, `${Y}-06-01`, "State University Tuition", "STATE UNIVERSITY TUITION");
    await tx("d5", "card", 55, `${Y}-07-01`, "City Pharmacy", "CITY PHARMACY");
    await q("UPDATE transactions SET is_reimbursed = true WHERE transaction_id = 'd5'");
    await tx("d6", "card", 30, `${Y - 1}-12-30`, "City Pharmacy", "CITY PHARMACY");
    await q(`INSERT INTO tax_deductions (tax_year, merchant, amount, category, notes, is_confirmed)
             VALUES ($1, 'City Pharmacy', 0, 'medical', 'Rx, copay', true)`, [Y]);
    // Income: two paychecks and a joint direct deposit (counted at 50%).
    await tx("p1", "chk", -2000, `${Y}-01-15`, "Acme Corp", "ACME CORP PAYROLL PPD");
    await tx("p2", "chk", -2000, `${Y}-01-31`, "Acme Corp", "ACME CORP PAYROLL PPD");
    await tx("p3", "joint", -1000, `${Y}-02-15`, "Beta LLC", "BETA LLC DIRECT DEP");

    // Rent: two payments this year (one memo formula-looking), one the year before.
    await q("UPDATE user_settings SET housing_config = $1 WHERE id = 1", [JSON.stringify({ enabled: true, payee_name: "Sam Lee", rent_amount: 1800, rent_due_day: 1 })]);
    const pay = async (date, amount, memo, covers) => {
      const id = (await q("INSERT INTO payee_payments (payee, paid_date, amount, memo) VALUES ('Sam Lee',$1,$2,$3) RETURNING id", [date, amount, memo])).rows[0].id;
      for (const [label, period, cat] of covers) {
        await q("INSERT INTO payee_obligations (payee, category, label, period, amount, status, paid_payment_id) VALUES ('Sam Lee',$1,$2,$3,0,'paid',$4)", [cat, label, period, id]);
      }
    };
    await pay(`${Y}-01-03`, 1800, `Jan ${Y} Rent`, [["Rent", `${Y}-01`, "rent"]]);
    await pay(`${Y}-02-03`, 1950.25, "+Feb", [["Rent", `${Y}-02`, "rent"], ["Electricity", `${Y}-01`, "utility"]]);
    await pay(`${Y - 1}-12-03`, 1800, "Dec", [["Rent", `${Y - 1}-12`, "rent"]]);

    // Investments (K1's table): a FIFO sale and a qualified dividend.
    await q("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id) VALUES ('Brokerage','Fidelity','brokerage',5000,'brk')");
    const brk = (await q("SELECT id FROM investment_accounts WHERE plaid_account_id='brk'")).rows[0].id;
    const itx = (id, date, type, subtype, qty, amount) => q(
      `INSERT INTO investment_transactions (plaid_investment_transaction_id, investment_account_id, txn_date, type, subtype, security_id, ticker, quantity, amount)
       VALUES ($1,$2,$3,$4,$5,'sec','VTI',$6,$7)`, [id, brk, date, type, subtype, qty, amount]);
    await itx("b1", `${Y - 2}-03-01`, "buy", "buy", 10, 1000);
    await itx("s1", `${Y}-05-01`, "sell", "sell", -10, -1500);
    await itx("v1", `${Y}-06-30`, "cash", "qualified dividend", 0, -40.25);

    // Documents (K2's table).
    await q("INSERT INTO tax_documents (tax_year, form, issuer, expected_by, origin) VALUES ($1,'W-2','Acme Corp',$2,'manual')", [Y, `${Y + 1}-01-31`]);
  });
  after(async () => { if (pfPool) await pfPool.end(); });

  it("deductions agree with /api/export/tax-report to the cent, and deductions.csv is its CSV", async () => {
    const pkg = await tp.gatherTaxPackage(pfPool, Y);
    assert.equal(pkg.deductions.ok, true);
    const json = (await supertest(app).get(`/api/export/tax-report?year=${Y}&format=json`).expect(200)).body;
    assert.equal(pkg.deductions.total, json.grand_total);
    assert.equal(pkg.deductions.count, json.item_count);
    assert.equal(json.item_count, 4);
    for (const [cat, data] of Object.entries(json.categories)) {
      assert.equal(pkg.deductions.by_category[cat], Math.round(data.total * 100) / 100, cat);
    }
    assert.deepEqual(pkg.deductions.rows, Object.values(json.categories).flatMap((c) => c.items));
    const med = pkg.deductions.rows.filter((r) => r.category === "medical");
    assert.deepEqual(med.map((r) => [r.txn_date, r.amount, r.notes, r.is_confirmed]),
      [[`${Y}-02-02`, "7.33", "Rx, copay", true], [`${Y}-03-04`, "42.10", "Rx, copay", true]]);

    const csv = (await supertest(app).get(`/api/export/tax-report?year=${Y}&format=csv`).expect(200)).text;
    const z = await supertest(app).get(`/api/tax/package?year=${Y}&format=zip`).buffer(true).parse(binary).expect(200);
    assert.equal(z.headers["content-type"], "application/zip");
    const files = readZip(z.body);
    assert.equal(files["deductions.csv"].toString("utf8"), csv);
    assert.ok(csv.includes(`"'=HYPERLINK(""x"") Red Cross Donation"`));
  });

  it("rent paid agrees with /api/housing/export to the cent, and rent_paid.csv is its CSV", async () => {
    const pkg = await tp.gatherTaxPackage(pfPool, Y);
    const json = (await supertest(app).get(`/api/housing/export?year=${Y}&format=json`).expect(200)).body;
    assert.equal(pkg.rent_paid.total, json.total);
    assert.equal(json.total, 3750.25);
    assert.equal(pkg.rent_paid.payee, json.payee);
    assert.deepEqual(JSON.parse(JSON.stringify(pkg.rent_paid.payments)), json.payments);
    const csv = (await supertest(app).get(`/api/housing/export?year=${Y}&format=csv`).expect(200)).text;
    const files = readZip((await supertest(app).get(`/api/tax/package?year=${Y}&format=zip`).buffer(true).parse(binary).expect(200)).body);
    assert.equal(files["rent_paid.csv"].toString("utf8"), csv);
    assert.ok(csv.includes(`"'+Feb"`));
  });

  it("income, investments and documents come from the shared definitions", async () => {
    const pkg = (await supertest(app).get(`/api/tax/package?year=${Y}`).expect(200)).body;
    assert.deepEqual(pkg.overview.sections_failed, []);
    const inc = await fq.getIncomeForYear(pfPool, Y);
    assert.equal(pkg.income.total, inc.total);
    assert.equal(inc.total, 4500);
    assert.deepEqual(pkg.income.by_kind, inc.by_kind);
    assert.equal(pkg.investment_income.totals.dividends, 40.25);
    assert.equal(pkg.investment_income.totals.qualified_dividends, 40.25);
    assert.equal(pkg.realized_gains.sales.length, 1);
    assert.deepEqual([pkg.realized_gains.sales[0].cost_basis, pkg.realized_gains.sales[0].gain, pkg.realized_gains.sales[0].term], [1000, 500, "long"]);
    assert.equal(pkg.realized_gains.totals.long.gain, 500);
    assert.equal(pkg.overview.realized_gain_known, 500);
    assert.deepEqual(pkg.documents.documents.map((d) => [d.form, d.issuer, d.state]), [["W-2", "Acme Corp", "overdue"]]);
    assert.equal(pkg.overview.documents_open, 1);
    assert.equal(pkg.overview.documents_overdue, 1);
    const files = readZip((await supertest(app).get(`/api/tax/package?year=${Y}&format=zip`).buffer(true).parse(binary).expect(200)).body);
    assert.deepEqual(Object.keys(files), tp.ZIP_FILES);
    assert.equal(files["summary.pdf"].slice(0, 5).toString(), "%PDF-");
    const parsed = JSON.parse(files["package.json"].toString("utf8"));
    assert.equal(parsed.deductions.total, pkg.deductions.total);
  });

  it("a year with nothing recorded renders every section, empty", async () => {
    const pkg = await tp.gatherTaxPackage(pfPool, 2001);
    for (const k of tp.SECTION_ORDER) assert.equal(pkg[k].ok, true, k);
    assert.equal(pkg.deductions.total, 0);
    assert.equal(pkg.rent_paid.total, 0);
    assert.equal(pkg.income.total, 0);
    assert.deepEqual(pkg.realized_gains.sales, []);
    const pdf = await supertest(app).get("/api/tax/package?year=2001&format=pdf").buffer(true).parse(binary).expect(200);
    assert.equal(pdf.body.slice(0, 5).toString(), "%PDF-");
  });
});
