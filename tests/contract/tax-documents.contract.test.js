// Real-Postgres contract test for roadmap T3.3 K2 — the tax documents
// checklist, with both apps' real databases wired the way the shell wires them:
//  - Suggest from real rows of last year:
//    - a payroll stream on a Teller account → a W-2 from the employer;
//    - interest on that account → a 1099-INT from the bank;
//    - a K1 brokerage sale → a 1099-B from the broker;
//    - a 401(k) withdrawal → a 1099-R;
//    - tuition → a 1098-T.
//  - Under $10 of interest elsewhere suggests nothing.
//  - getIncomeForYear on the same rows: by kind, the shared account at the user's share.
//  - Received and dismissed rows survive a second Suggest unchanged (ON CONFLICT on
//    the LOWER(issuer) index).
//  - A manual duplicate in another case is a 409; a suggested row can't be deleted.
//  - The linked-task round trip: each open form past its usual date opens a
//    Per-sistant task; marking it received through Perfin's route closes it (the
//    route's own refresh); a dismissed one closes too.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, perfinApp, persistentApp } = require("./_setup");

describe("Tax documents checklist (T3.3 K2) on real Postgres", { skip: SKIP }, () => {
  let pfPool, psPool, app, lt, fq, Y;
  const q = (s, p) => pfPool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const task = async (key) => (await psPool.query("SELECT * FROM todos WHERE source_key = $1", [key])).rows[0];
  const doc = async (form) => (await q("SELECT * FROM tax_documents WHERE tax_year = $1 AND form = $2", [Y, form])).rows[0];
  async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  before(async () => {
    psPool = await persistentDb("taxdocs");
    pfPool = await perfinDb("taxdocs");
    persistentApp(psPool);
    app = perfinApp();
    app.set("persistentPool", psPool);
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(psPool);
    lt = require("../../teller/services/linked-tasks");
    fq = require("../../teller/services/financial-queries");
    Y = Number(fq.todayStr().slice(0, 4)) - 1;

    // A Teller checking account at "Ally Bank": two paychecks, interest, and a
    // joint account at 50% with one more paycheck.
    await q("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status) VALUES ('e_ally','Ally Bank', pgp_sym_encrypt('t', $1), 'GOOD')", [PASS()]);
    const enr = (await q("SELECT id FROM teller_enrollments WHERE enrollment_id='e_ally'")).rows[0].id;
    await q("INSERT INTO linked_accounts (teller_enrollment_id, account_id, name, type, subtype) VALUES ($1,'chk','Checking','depository','checking')", [enr]);
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, is_shared, spending_split_pct, institution_name_manual) VALUES ('joint','Joint','depository','checking',true,true,50,'Credit Union')");
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual) VALUES ('card','Card','credit','credit card',true)");
    const tx = (id, acct, amt, date, merchant, name, extra = {}) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, personal_finance_category, pending)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)`,
      [acct, id, amt, date, merchant, name, extra.category || null, extra.pfc ? JSON.stringify(extra.pfc) : null]);
    await tx("p1", "chk", -2000, `${Y}-01-15`, "Acme Corp", "ACME CORP PAYROLL PPD");
    await tx("p2", "chk", -2000, `${Y}-01-31`, "Acme Corp", "ACME CORP PAYROLL PPD");
    await tx("i1", "chk", -12.5, `${Y}-06-30`, null, "INTEREST PAID", { category: ["income"] });
    await tx("p3", "joint", -1000, `${Y}-02-15`, "Beta LLC", "BETA LLC DIRECT DEP");
    await tx("i2", "joint", -4, `${Y}-03-31`, null, "INTEREST PAID", { category: ["income"] });
    await tx("old", "chk", -2000, `${Y - 1}-12-31`, "Acme Corp", "ACME CORP PAYROLL PPD"); // the year before
    await tx("tu", "card", 4000, `${Y}-08-20`, "State University Tuition", "STATE UNIVERSITY TUITION");

    // K1 data: a brokerage sale and a 401(k) withdrawal.
    await q("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id) VALUES ('Brokerage','Fidelity','brokerage',5000,'brk'), ('Work 401k','Fidelity','401k',9000,'k401')");
    const ids = Object.fromEntries((await q("SELECT plaid_account_id, id FROM investment_accounts")).rows.map((r) => [r.plaid_account_id, r.id]));
    const itx = (id, acct, date, type, subtype, qty, amount) => q(
      `INSERT INTO investment_transactions (plaid_investment_transaction_id, investment_account_id, txn_date, type, subtype, security_id, ticker, quantity, amount)
       VALUES ($1,$2,$3,$4,$5,'sec','VTI',$6,$7)`, [id, ids[acct], date, type, subtype, qty, amount]);
    await itx("b1", "brk", `${Y - 1}-03-01`, "buy", "buy", 10, 1000);
    await itx("s1", "brk", `${Y}-05-01`, "sell", "sell", -10, -1500);
    await itx("w1", "k401", `${Y}-08-01`, "cash", "withdrawal", 0, 600);
  });
  after(async () => {
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(null);
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  it("getIncomeForYear: last year's rows only, by kind, the joint account at 50%", async () => {
    const r = await fq.getIncomeForYear(pfPool, Y);
    assert.deepEqual(r.by_kind, { wages: 4500, interest: 14.5, dividends: 0, other: 0 });
    assert.equal(r.total, 4514.5);
    const acme = r.by_source.find((s) => s.source === "Acme Corp");
    assert.deepEqual([acme.kind, acme.institution, acme.total, acme.count], ["wages", "Ally Bank", 4000, 2]);
    assert.equal(r.by_source.find((s) => s.source === "Beta LLC").institution, "Credit Union");
  });

  it("Suggest adds a W-2, a 1099-INT, a 1099-B, a 1099-R and a 1098-T — nothing for under $10 of interest", async () => {
    await supertest(app).post("/api/tax/documents/suggest").send({ year: String(Y + 2) }).expect(400);
    const b = (await supertest(app).post("/api/tax/documents/suggest?year=" + Y).expect(200)).body;
    assert.deepEqual(b.errors, []);
    assert.equal(b.added, 6);
    assert.deepEqual(b.documents.map((d) => [d.form, d.issuer, d.origin, d.expected_by]), [
      ["W-2", "Acme Corp", "suggested", `${Y + 1}-01-31`],
      ["W-2", "Beta LLC", "suggested", `${Y + 1}-01-31`],
      ["1099-INT", "Ally Bank", "suggested", `${Y + 1}-01-31`],
      ["1099-B", "Fidelity", "suggested", `${Y + 1}-02-15`],
      ["1099-R", "Fidelity", "suggested", `${Y + 1}-01-31`],
      ["1098-T", "State University Tuition", "suggested", `${Y + 1}-01-31`],
    ]);
    assert.ok(!b.documents.some((d) => d.issuer === "Credit Union"), "$2 of interest at the user's share is under $10");
  });

  it("received and dismissed rows survive a second Suggest unchanged; a manual duplicate in another case is a 409", async () => {
    const w2 = await doc("W-2");
    await supertest(app).patch("/api/tax/documents/" + w2.id).send({ received: true, notes: "filed" }).expect(200);
    const int = await doc("1099-INT");
    await supertest(app).patch("/api/tax/documents/" + int.id).send({ dismissed: true }).expect(200);
    const again = (await supertest(app).post("/api/tax/documents/suggest?year=" + Y).expect(200)).body;
    assert.equal(again.added, 0);
    const w2After = await doc("W-2");
    assert.ok(w2After.received_at, "still received");
    assert.equal(w2After.notes, "filed");
    assert.ok((await doc("1099-INT")).dismissed_at, "still dismissed");
    assert.equal((await q("SELECT count(*)::int AS n FROM tax_documents")).rows[0].n, 6);
    await supertest(app).post("/api/tax/documents").send({ year: Y, form: "1099-INT", issuer: "ALLY BANK" }).expect(409);
    await supertest(app).delete("/api/tax/documents/" + int.id).expect(409);
    const manual = (await supertest(app).post("/api/tax/documents").send({ year: Y, form: "1099-NEC", issuer: "Client Co" }).expect(201)).body.document;
    assert.deepEqual([manual.origin, manual.expected_by], ["manual", `${Y + 1}-01-31`]);
    await supertest(app).delete("/api/tax/documents/" + manual.id).expect(200);
    assert.equal(await doc("1099-NEC"), undefined);
  });

  it("linked tasks: each open form past its usual date opens a task; received or dismissed closes it", async () => {
    await supertest(app).patch("/api/settings").send({ linked_tasks_enabled: true }).expect(200);
    const s = (await supertest(app).get("/api/settings").expect(200)).body;
    assert.equal(s.linked_tasks_sources.tax_documents, true, "on by default");
    const r = await lt.runLinkedTasks(pfPool, psPool);
    assert.equal(r.status, "ok", JSON.stringify(r));
    const open = (await q("SELECT id, form FROM tax_documents WHERE received_at IS NULL AND dismissed_at IS NULL ORDER BY id")).rows;
    assert.equal(open.length, 4, "the received W-2 and the dismissed 1099-INT have no task");
    for (const d of open) {
      const t = await task(`perfin:tax-doc:${d.id}`);
      assert.ok(t, d.form);
      assert.deepEqual([t.completed, t.category, t.source_url], [false, "finance", "/tax#documents"]);
    }
    assert.equal(await task(`perfin:tax-doc:${(await doc("W-2")).id}`), undefined);
    const b = await doc("1099-B");
    assert.equal((await task(`perfin:tax-doc:${b.id}`)).title, `Find your ${Y} 1099-B from Fidelity`);
    await supertest(app).patch("/api/tax/documents/" + b.id).send({ received: true }).expect(200);
    assert.ok(await until(async () => (await task(`perfin:tax-doc:${b.id}`)).completed), "the route's own refresh closed it");
    assert.equal((await task(`perfin:tax-doc:${b.id}`)).auto_closed, true);
    const t1098 = await doc("1098-T");
    await supertest(app).patch("/api/tax/documents/" + t1098.id).send({ dismissed: true }).expect(200);
    assert.ok(await until(async () => (await task(`perfin:tax-doc:${t1098.id}`)).completed), "dismissing closes it too");
  });
});
