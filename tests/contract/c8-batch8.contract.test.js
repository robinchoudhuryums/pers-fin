// Cycle-8 broad scan Batch 8 on real Postgres:
//  - F31: an existing tax_documents table whose form CHECK predates a form in
//    the code (the CREATE TABLE IF NOT EXISTS never re-runs) refuses that form
//    until the next migration run, which replaces the CHECK; an unchanged run
//    replaces nothing. The webhook_events CHECKs carry the names the sync uses.
//  - F52: Per-sistant's pool returns a DATE as 'YYYY-MM-DD' (GET /api/todos
//    serializes it as its own day) while Perfin's pool, in the same process,
//    keeps node-pg's Date.
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, persistentApp } = require("./_setup");

describe("cycle-8 Batch 8 — CHECK lists and DATE values on real Postgres", { skip: SKIP }, () => {
  let pfPool, psPool, database;
  before(async () => {
    pfPool = await perfinDb("c8_batch8");
    psPool = await persistentDb("c8_batch8");
    database = require("../../teller/services/database");
  });

  const checkDef = async (table, name) =>
    (await pfPool.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2", [table, name])).rows[0];

  it("F31: a stale form CHECK is replaced by the next migration run, then left alone", async () => {
    for (const [table, col] of [["tax_documents", "form"], ["tax_documents", "origin"], ["webhook_events", "provider"], ["webhook_events", "status"]]) {
      assert.ok(await checkDef(table, `${table}_${col}_check`), `${table}_${col}_check exists after a fresh migration`);
    }
    // The production shape: the table was created before 1099-K was a form.
    await pfPool.query("ALTER TABLE tax_documents DROP CONSTRAINT tax_documents_form_check");
    await pfPool.query("ALTER TABLE tax_documents ADD CONSTRAINT tax_documents_form_check CHECK (form IN ('W-2', 'other'))");
    const insert = () => pfPool.query("INSERT INTO tax_documents (tax_year, form, issuer) VALUES (2026, '1099-K', 'PayPal') RETURNING id");
    await assert.rejects(insert(), /tax_documents_form_check/);

    await database.runMigrations();
    assert.match((await checkDef("tax_documents", "tax_documents_form_check")).def, /'1099-K'::text/);
    assert.equal((await insert()).rows.length, 1);
    await assert.rejects(pfPool.query("INSERT INTO tax_documents (tax_year, form) VALUES (2026, 'W-9')"), /tax_documents_form_check/, "still enforced");

    const client = await pfPool.connect();
    try { assert.deepEqual(await database.syncInListChecks(client), [], "an unchanged run replaces nothing"); }
    finally { client.release(); }
  });

  it("F52: Per-sistant's DATE is text; Perfin's pool keeps its Date", async () => {
    const id = (await psPool.query("INSERT INTO todos (title, due_date) VALUES ('Rent', '2026-10-31') RETURNING id")).rows[0].id;
    const raw = (await psPool.query("SELECT due_date FROM todos WHERE id = $1", [id])).rows[0].due_date;
    assert.equal(raw, "2026-10-31");
    const list = (await supertest(persistentApp(psPool)).get("/api/todos").expect(200)).body;
    const row = (Array.isArray(list) ? list : list.todos || []).find((t) => t.id === id);
    assert.equal(row.due_date, "2026-10-31");
    const pf = (await pfPool.query("SELECT '2026-10-31'::date AS d")).rows[0].d;
    assert.ok(pf instanceof Date, "Perfin's parsing is unchanged");
  });
});
