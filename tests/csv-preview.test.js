// ============================================================================
// POST /api/import-csv/preview — dry-run classification (new/duplicate/skipped)
// ============================================================================
// Mounts the subscriptions router with a stubbed pool and posts a small Chase
// CSV. The preview must (a) detect the format, (b) compute dedup IDs the SAME
// way the real import does (makeCsvTxnIdGenerator), and (c) classify a row whose
// id already exists in `transactions` as a duplicate — without writing anything.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const { csvTransactionId } = require("../teller/data/csv-formats");
const originalQuery = dbModule.pool.query;

// One existing transaction: the first Chase row below ("Starbucks", 5.00 on
// 2026-01-02). accountLabel defaults to "Chase Account" for the chase format,
// occurrence 0 → the legacy single-arg hash.
const EXISTING_ID = csvTransactionId("Chase Account", "2026-01-02", 5, "Starbucks");

dbModule.pool.query = async (sql, params) => {
  if (/transaction_id = ANY/.test(sql)) {
    const wanted = (params[0] || []).filter((id) => id === EXISTING_ID);
    return { rows: wanted.map((id) => ({ transaction_id: id })) };
  }
  return { rows: [] };
};

const router = require("../teller/routes/subscriptions");
const app = express();
app.use(router);

after(() => { dbModule.pool.query = originalQuery; });

const CSV = [
  "Transaction Date,Post Date,Description,Category,Type,Amount",
  "01/02/2026,01/03/2026,Starbucks,Food & Drink,Sale,-5.00",   // existing -> duplicate
  "01/03/2026,01/04/2026,Amazon,Shopping,Sale,-20.00",          // new
  "01/04/2026,01/05/2026,BadRow,Misc,Sale,",                    // blank amount -> skipped
].join("\n");

describe("POST /api/import-csv/preview", () => {
  it("classifies rows as new / duplicate / skipped without writing", async () => {
    const res = await supertest(app)
      .post("/api/import-csv/preview")
      .attach("file", Buffer.from(CSV), "chase.csv");

    assert.equal(res.status, 200);
    assert.equal(res.body.format_detected, "chase");
    assert.equal(res.body.account_label, "Chase Account");
    assert.equal(res.body.rows_total, 3);
    assert.equal(res.body.rows_parseable, 2, "2 rows parse (blank-amount row skipped)");
    assert.equal(res.body.rows_skipped, 1);
    assert.equal(res.body.rows_duplicate, 1, "the pre-existing Starbucks row is a duplicate");
    assert.equal(res.body.rows_new, 1, "the Amazon row is new");
    // Sample carries per-row status so the UI can show new/dup badges.
    const statuses = res.body.sample.map((r) => r.status).sort();
    assert.deepEqual(statuses, ["duplicate", "new"]);
  });

  it("400s on an empty upload", async () => {
    const res = await supertest(app).post("/api/import-csv/preview");
    assert.equal(res.status, 400);
  });
});
