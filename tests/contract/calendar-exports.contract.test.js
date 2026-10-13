// Real-Postgres contract tests (TQ-2): bill calendar + ICS feed, bill payments,
// manual bills, and the CSV / tax / context exports. Regression class: DC-3
// (paid state never matched — a DATE column comes back as a JS Date, so the
// 'YYYY-MM-DD' key missed) and SXE-8 (exports printed "Mon Jan 05 2026 …
// GMT" and ignored the user's merchant rename) — both pass any mock pool that
// returns strings.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("calendar + exports on real Postgres", { skip: SKIP }, () => {
  let pool, app, cm, year, month;
  const q = (s, p) => pool.query(s, p);
  const DAY = 86400000;
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

  before(async () => {
    pool = await perfinDb("calexp");
    app = perfinApp();
    cm = require("../../teller/services/financial-queries").currentMonth();
    year = parseInt(cm.slice(0, 4), 10); month = parseInt(cm.slice(5, 7), 10);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('g','Bank','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items")).rows[0].id;
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance) VALUES ($1,'chk','Checking','depository','checking',3000)", [item]);
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance) VALUES ($1,'loan','Auto Loan','loan','auto',18000)", [item]);
    const today = Date.parse(require("../../teller/services/financial-queries").todayStr() + "T00:00:00Z");
    const ins = (id, amt, date, m, user = null) => q(
      "INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, user_merchant_name) VALUES ('chk',$1,$2,$3,$4,$4,false,$5)",
      [id, amt, date, m, user]);
    for (let i = 0; i < 6; i++) await ins("pay" + i, -(2000 + i), ymd(today - 14 * i * DAY), "ACME PAYROLL");
    await ins("r1", 12.34, ymd(today - 3 * DAY), "SQ *COFFEE 123", "Corner Coffee");
    await ins("f1", 9.99, ymd(today - 4 * DAY), "=HYPERLINK(\"x\")");
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active)
             VALUES ('Netflix','Netflix',15.49,30,$1,$2,$3,true)`, [ymd(today - 95 * DAY), ymd(today - 5 * DAY), ymd(today + 25 * DAY)]);
  });
  after(async () => { if (pool) await pool.end(); });

  it("manual bill → calendar event → mark paid shows is_paid (DC-3); default paid_amount (SXE-11)", async () => {
    const mb = (await supertest(app).post("/api/manual-bills").send({ name: "Water", amount: 60, due_day: 10, cadence: "monthly" }).expect(200)).body;
    await supertest(app).patch("/api/manual-bills/" + mb.id).send({ amount: "abc" }).expect(400);
    await supertest(app).patch("/api/manual-bills/" + mb.id).send({ due_day: 40 }).expect(400);
    const paidDate = cm + "-10";
    const bp = (await supertest(app).post("/api/bill-payments").send({ bill_source: "manual", bill_id: mb.id, paid_date: paidDate }).expect(200)).body;
    assert.equal(parseFloat(bp.paid_amount), 60);
    const cal = (await supertest(app).get(`/api/bill-calendar?year=${year}&month=${month}`).expect(200)).body;
    const day = cal.days.find((d) => d.date === paidDate);
    const ev = day && day.events.find((e) => e.bill_source === "manual" && e.bill_id === mb.id);
    assert.ok(ev, "the manual bill lands on its due day");
    assert.equal(ev.is_paid, true, "the paid key matches the DATE column");
    assert.ok(cal.days.some((d) => d.events.some((e) => e.is_income)), "biweekly payroll projected as income (DC-10)");
    const list = (await supertest(app).get(`/api/bill-payments?year=${year}&month=${month}`).expect(200)).body;
    const rows = list.payments || list;
    assert.ok(rows.some((p) => String(p.paid_date).slice(0, 10) === paidDate));
    await supertest(app).delete("/api/bill-payments/" + bp.id).expect(200);
  });

  it("forecast + ICS feed build on the real schema", async () => {
    const f = (await supertest(app).get("/api/forecast?days=60").expect(200)).body;
    assert.ok(JSON.stringify(f).includes("Netflix"));
    const ics = await require("../../teller/routes/subscriptions").buildBillCalendarIcs(90);
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:[^\r\n]*Netflix/);
    assert.match(ics, /SUMMARY:[^\r\n]*Water/);
  });

  it("transactions CSV export: ISO dates, user merchant name, formula guard (SXE-8/SXE-13)", async () => {
    const csv = (await supertest(app).get("/api/export?type=transactions&months=24").expect(200)).text;
    assert.ok(!/GMT/.test(csv), "no Date.toString() dates");
    assert.match(csv, /\n\d{4}-\d{2}-\d{2},"Corner Coffee",12\.34,/);
    assert.match(csv, /"'=HYPERLINK/, "a merchant starting with = can't run as a formula");
    const subs = (await supertest(app).get("/api/export?type=subscriptions").expect(200)).text;
    assert.match(subs, /"Netflix",15\.49,30,[^,]*,\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2},true/);
  });

  it("tax report: JSON + CSV computed from transactions", async () => {
    await q("INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('chk','tax1',75,$1,'RED CROSS','RED CROSS',false)", [`${year}-01-20`]);
    const js = (await supertest(app).get(`/api/export/tax-report?year=${year}&format=json`).expect(200)).body;
    assert.equal(js.item_count, 1);
    assert.equal(js.grand_total, 75);
    const csv = (await supertest(app).get(`/api/export/tax-report?year=${year}`).expect(200)).text;
    assert.match(csv, new RegExp(`${year}-01-20`));
  });

  it("context export: loans as debt, real insight only, ISO dates (SXE-9)", async () => {
    await q("INSERT INTO financial_insights (insight_text, entry_type) VALUES ('Real insight text','insight'), ('[ML Categorization] usage','categorize')");
    const md = (await supertest(app).get("/api/context-export").expect(200)).text;
    assert.match(md, /Auto Loan\*\* \([^)]*\): -\$18000\.00 owed/);
    assert.match(md, /Real insight text/);
    assert.ok(!/ML Categorization/.test(md));
    const js = (await supertest(app).get("/api/context-export?format=json").expect(200)).body;
    assert.equal(js.accounts.find((a) => a.name === "Auto Loan").is_liability, true);
  });
});
