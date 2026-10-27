// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 4 — bank-sync durability
// ============================================================================
// The behaviours that need a real database (a wrong-key token, the duplicate-
// Item guard, the CSV loan roll-forward, removed investment accounts, flow
// coverage, liabilities values, balance validation, the Teller text[]
// category) are pinned in tests/contract/bank-durability.contract.test.js.
// This file covers the rest without a database:
// F17   every token read goes through perfin_try_decrypt
// F19   the CSV CLI fails the run on a failed file + the workflow removes only
//       imported files
// F25   a failing roll-forward rolls back to its savepoint — the import stays
// F27   a Plaid reconcile waits for an in-flight sync (and vice versa)
// F28   the balance path skips liabilities for an Item with no card / loan
// F30   snapshotDay reads a Date by its local calendar day
// ============================================================================

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const plaidClientModule = require("../teller/services/plaid-client");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
const originalGetPlaidClient = plaidClientModule.getPlaidClient;

let plaid = null;
let inv;
before(() => {
  plaidClientModule.getPlaidClient = () => plaid;
  delete require.cache[require.resolve("../teller/routes/investments")];
  inv = require("../teller/routes/investments"); // binds the stub at require time
});
after(() => {
  plaidClientModule.getPlaidClient = originalGetPlaidClient;
  dbModule.pool.query = originalQuery;
  dbModule.pool.connect = originalConnect;
  delete require.cache[require.resolve("../teller/routes/investments")];
});
afterEach(() => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; });

// ---------------------------------------------------------------------------
describe("F17 — token reads never use the raising pgp_sym_decrypt", () => {
  it("the migration defines perfin_try_decrypt (NULL on any error)", () => {
    const db = read("teller", "services", "database.js");
    assert.match(db, /CREATE OR REPLACE FUNCTION perfin_try_decrypt\(data bytea, key text\)/);
    assert.match(db, /RETURN pgp_sym_decrypt\(data, key\);\s*EXCEPTION WHEN OTHERS THEN\s*RETURN NULL;/);
  });

  it("every sync / balance / holdings / flows / unlink token SELECT uses it", () => {
    for (const f of ["enrollments.js", "investments.js", "investment-performance.js"]) {
      const src = read("teller", "routes", f);
      // The only raw pgp_sym_decrypt left is the Plaid unlink's own try/catch.
      const raw = src.split("\n").filter((l) => /pgp_sym_decrypt\(/.test(l) && !/^\s*\/\//.test(l));
      if (f === "enrollments.js") assert.equal(raw.length, 1, raw.join("\n"));
      else assert.deepEqual(raw, [], f);
    }
    assert.equal((read("teller", "routes", "investments.js").match(/perfin_try_decrypt\(/g) || []).length >= 6, true);
  });
});

// ---------------------------------------------------------------------------
describe("F19 — a failed CSV is never deleted", () => {
  it("the CLI exits non-zero on a failed file and lists only imported files", () => {
    const cli = read("scripts", "import-csv-cli.js");
    assert.match(cli, /if \(results\.length < files\.length\) process\.exitCode = 1;/);
    assert.match(cli, /fs\.writeFileSync\(process\.env\.CSV_IMPORTED_LIST, imported\.map/);
    assert.match(cli, /SAVEPOINT csv_row[\s\S]*?ROLLBACK TO SAVEPOINT csv_row/, "a bad row can't silently roll the file back");
  });

  it("the workflow removes only the listed files, even after a partial failure", () => {
    const wf = read(".github", "workflows", "csv-import.yml");
    assert.match(wf, /CSV_IMPORTED_LIST: \$\{\{ runner\.temp \}\}\/csv-imported\.txt\n\s+run: node scripts\/import-csv-cli\.js/);
    assert.match(wf, /done < "\$CSV_IMPORTED_LIST"/);
    assert.doesNotMatch(wf, /for f in csv-uploads\/\*\.csv/);
    assert.match(wf, /- name: Remove processed CSVs\n\s+if: \$\{\{ !cancelled\(\) && \(steps\.import\.outcome == 'success' \|\| steps\.import\.outcome == 'failure'\) \}\}/);
  });
});

// ---------------------------------------------------------------------------
describe("F25 — the manual-balance roll-forward can't roll the import back", () => {
  it("an error in the roll-forward rolls back to its savepoint and the import still commits", async () => {
    const log = [];
    dbModule.pool.connect = async () => ({
      query: async (sql, params) => {
        log.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));
        if (/INSERT INTO transactions/.test(sql)) return { rowCount: 1 };
        if (/SELECT id FROM plaid_items/.test(sql)) return { rows: [{ id: 1 }] };
        if (/FROM linked_accounts\s+WHERE is_manual = true/.test(sql)) throw new Error("invalid time zone");
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    });
    dbModule.pool.query = async () => ({ rows: [] });
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/subscriptions"));
    const csv = "Transaction Date,Post Date,Description,Category,Type,Amount\n09/10/2026,09/11/2026,Cafe,Food & Drink,Sale,-20.00\n";
    const res = await supertest(app).post("/api/import-csv").attach("file", Buffer.from(csv), "chase.csv").expect(200);
    assert.equal(res.body.rows_imported, 1);
    const i = log.indexOf("SAVEPOINT csv_balance");
    assert.ok(i > 0, log.join("\n"));
    assert.ok(log.indexOf("ROLLBACK TO SAVEPOINT csv_balance") > i);
    assert.equal(log[log.length - 1], "COMMIT");
  });
});

// ---------------------------------------------------------------------------
describe("F27 — Plaid reconcile and sync are serialized", () => {
  it("a reconcile's cursor reset waits for an in-flight sync to finish", async () => {
    const events = [];
    let releaseFirst;
    const firstSyncGate = new Promise((r) => { releaseFirst = r; });
    let itemsReads = 0;
    plaid = { accountsGet: async () => ({ data: { accounts: [] } }) };
    dbModule.pool.query = async (sql) => {
      if (/FROM plaid_items pi\s+WHERE pi\.status = 'GOOD'/.test(sql)) {
        itemsReads++;
        events.push("sync-start-" + itemsReads);
        if (itemsReads === 1) await firstSyncGate;
        events.push("sync-end-" + itemsReads);
        return { rows: [] };
      }
      if (/UPDATE sync_cursors SET cursor = ''/.test(sql)) { events.push("cursor-reset"); return { rows: [] }; }
      return { rows: [] };
    };
    const sync = inv.syncAllPlaidTransactions();
    await new Promise((r) => setImmediate(r));
    const reconcile = inv.reconcilePlaidTransactions();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events, ["sync-start-1"], "the reconcile hasn't reset cursors under a running sync");
    releaseFirst();
    await Promise.all([sync, reconcile]);
    assert.deepEqual(events, ["sync-start-1", "sync-end-1", "cursor-reset", "sync-start-2", "sync-end-2"]);
    plaid = null;
  });

  it("the wait is bounded, so a hung Plaid call can't block every later sync", () => {
    const src = read("teller", "routes", "investments.js");
    assert.match(src, /const PLAID_LOCK_MAX_WAIT_MS = 10 \* 60 \* 1000;/);
    assert.match(src, /Promise\.race\(\[\s*_plaidTxnLock,\s*new Promise\(\(resolve\) => \{ timer = setTimeout\(resolve, PLAID_LOCK_MAX_WAIT_MS\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F28 — liabilities only for Items that can have them", () => {
  it("the balance sync doesn't call liabilitiesGet for a checking-only Item", async () => {
    let liabilityCalls = 0;
    plaid = {
      accountsGet: async () => ({ data: { accounts: [{ account_id: "chk", type: "depository", balances: { current: 10, available: 10 } }] } }),
      liabilitiesGet: async () => { liabilityCalls++; return { data: { liabilities: {}, accounts: [] } }; },
    };
    dbModule.pool.query = async (sql) => {
      if (/FROM plaid_items\s+WHERE status = 'GOOD'/.test(sql)) return { rows: [{ id: 1, institution_name: "Checkbank", access_token: "tok" }] };
      if (/UPDATE linked_accounts SET\s+current_balance/.test(sql)) return { rows: [{ id: 9 }] };
      return { rows: [] };
    };
    const r = await inv.syncAllPlaidBalances();
    assert.equal(liabilityCalls, 0);
    assert.ok(!r.errors.length, JSON.stringify(r.errors));
    plaid = null;
  });

  it("NO_LIABILITY_ACCOUNTS is a quiet skip; ADDITIONAL_CONSENT_REQUIRED is the not_supported skip", async () => {
    const fail = (code) => ({ liabilitiesGet: async () => { const e = new Error(code); e.response = { data: { error_code: code } }; throw e; } });
    assert.equal((await inv.syncPlaidLiabilities(fail("NO_LIABILITY_ACCOUNTS"), "t", 1)).skipped, "no_liability_accounts");
    assert.equal((await inv.syncPlaidLiabilities(fail("ADDITIONAL_CONSENT_REQUIRED"), "t", 1)).skipped, "not_supported");
    assert.equal((await inv.syncPlaidLiabilities(fail("INTERNAL_SERVER_ERROR"), "t", 1)).error_code, "INTERNAL_SERVER_ERROR");
  });
});

// ---------------------------------------------------------------------------
describe("F30 — snapshot days", () => {
  it("a node-pg DATE (local midnight) is its own calendar day in any TZ", () => {
    const { snapshotDay } = require("../teller/routes/investment-performance");
    assert.equal(snapshotDay(new Date(2026, 9, 5)), "2026-10-05");
    assert.equal(snapshotDay("2026-10-05"), "2026-10-05");
    assert.match(read("teller", "routes", "investment-performance.js"), /SELECT s\.snapshot_date::text AS snapshot_date/);
  });
});

// ---------------------------------------------------------------------------
describe("F18 — the re-auth guidance matches the guard", () => {
  it("no message tells the user to simply re-link a Plaid bank", () => {
    assert.doesNotMatch(read("teller", "routes", "investments.js"), /re-link this card to enable Plaid Liabilities/);
    assert.match(read("teller", "routes", "investments.js"), /if \(dup\) \{\s*await releasePlaidItem\(client, accessToken\);\s*return res\.status\(409\)/);
    // Since cycle-7 G3 (Batch 19) the fix is Link update mode on the same Item.
    assert.match(read("CLAUDE.md"), /fixed with RE-AUTHENTICATE,\s*not by linking again/);
  });
});
