// ============================================================================
// Oct 2026 broad scan (cycle 7) — Batch 16: imports, exports and privacy
//   F26 — a generic CSV's sign (charges vs deposits) chosen in the preview
//   F81 — the insight-email toggle + the webhook text that named a missing
//         Settings section
//   F85 — month archives carry a content fingerprint and are rebuilt when it
//         changes
// (F134 / ST5, the notes privacy tier, is pinned in
// apps/per-sistant/tests/scan-oct-batch16.test.js.) The real-Postgres half
// lives in tests/contract/batch16.contract.test.js.
// ============================================================================
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
process.env.GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "sheet-test-id";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const csv = require("../teller/data/csv-formats");
const dbModule = require("../teller/services/database");
const I = require("../scripts/sheets-sync")._internals;
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

// A deposits-positive bank export: charges negative, the paycheck positive.
const DEPOSITS_POSITIVE = [
  "Date,Description,Amount",
  "2026-09-01,ACME PAYROLL DIRECT DEP,2500.00",
  "2026-09-02,Coffee Shop,-4.50",
  "2026-09-03,Grocery Store,-82.10",
  "2026-09-04,Gas Station,-40.00",
].join("\n");
// The same activity in our debit-positive convention.
const CHARGES_POSITIVE = [
  "Date,Description,Amount",
  "2026-09-01,ACME PAYROLL DIRECT DEP,-2500.00",
  "2026-09-02,Coffee Shop,4.50",
  "2026-09-03,Grocery Store,82.10",
].join("\n");
const rowsOf = (text) => require("csv-parse/sync").parse(text, { columns: true, skip_empty_lines: true });

describe("F26 — a generic CSV's sign", () => {
  it("guessGenericSign reads inflow keywords, then the majority sign", () => {
    assert.equal(csv.guessGenericSign(rowsOf(DEPOSITS_POSITIVE)), "deposits");
    assert.equal(csv.guessGenericSign(rowsOf(CHARGES_POSITIVE)), "charges");
    // No inflow words: most rows are spending, so a negative majority means deposits-positive.
    assert.equal(csv.guessGenericSign(rowsOf("Date,Description,Amount\n2026-09-02,A,-1\n2026-09-03,B,-2\n2026-09-04,C,3")), "deposits");
    assert.equal(csv.guessGenericSign(rowsOf("Date,Description,Amount\n2026-09-02,A,1\n2026-09-03,B,2\n2026-09-04,C,-3")), "charges");
    assert.equal(csv.guessGenericSign([]), "charges", "a tie / empty file keeps the old default");
  });

  it("the generic parser negates only for positiveMeans 'deposits'; known formats ignore the option", () => {
    const row = { Date: "2026-09-02", Description: "Coffee", Amount: "-4.50" };
    assert.equal(csv.CSV_FORMATS.generic.parse(row).amount, -4.5);
    assert.equal(csv.CSV_FORMATS.generic.parse(row, null, { positiveMeans: "charges" }).amount, -4.5);
    assert.equal(csv.CSV_FORMATS.generic.parse(row, null, { positiveMeans: "deposits" }).amount, 4.5);
    const discover = { "Trans. Date": "09/02/2026", Description: "Coffee", Amount: "4.50" };
    assert.equal(csv.CSV_FORMATS.discover.parse(discover, null, { positiveMeans: "deposits" }).amount, 4.5);
    assert.deepEqual(csv.POSITIVE_MEANS, ["charges", "deposits"]);
  });

  function app() {
    const a = express(); a.use(express.json()); a.use(require("../teller/routes/subscriptions"));
    return a;
  }

  it("the preview returns the guess, applies positive_means and keeps the old default when none is sent", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const first = await supertest(app()).post("/api/import-csv/preview")
      .attach("file", Buffer.from(DEPOSITS_POSITIVE), "bank.csv").expect(200);
    assert.equal(first.body.format_detected, "generic");
    assert.equal(first.body.sign_guess, "deposits");
    assert.equal(first.body.positive_means, "charges", "nothing sent → the old default, so re-imports keep their IDs");
    assert.equal(first.body.sample.find((r) => r.merchant === "Coffee Shop").amount, -4.5);
    const flipped = await supertest(app()).post("/api/import-csv/preview")
      .field("positive_means", "deposits")
      .attach("file", Buffer.from(DEPOSITS_POSITIVE), "bank.csv").expect(200);
    assert.equal(flipped.body.positive_means, "deposits");
    assert.equal(flipped.body.sample.find((r) => r.merchant === "Coffee Shop").amount, 4.5);
    assert.equal(flipped.body.sample.find((r) => /PAYROLL/.test(r.merchant)).amount, -2500);
  });

  it("an unknown positive_means is a 400 on both routes; known formats report null", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    for (const route of ["/api/import-csv/preview", "/api/import-csv"]) {
      await supertest(app()).post(route).field("positive_means", "up")
        .attach("file", Buffer.from(DEPOSITS_POSITIVE), "bank.csv").expect(400);
    }
    const chase = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n09/02/2026,09/03/2026,Coffee,Food,Sale,-4.50,\n";
    const r = await supertest(app()).post("/api/import-csv/preview").field("positive_means", "deposits")
      .attach("file", Buffer.from(chase), "chase.csv").expect(200);
    assert.equal(r.body.format_detected, "chase");
    assert.equal(r.body.positive_means, null);
    assert.equal(r.body.sign_guess, null);
    assert.equal(r.body.sample[0].amount, 4.5, "Chase's own sign rule, untouched");
  });

  it("preview and commit parse through the same parseCsvUpload options; the CLI takes --positive-means", () => {
    const src = read("teller", "routes", "subscriptions.js");
    assert.equal((src.match(/fmt\.parse\(row, fmt\.headerless \? fmt\.columns : headers, parseOpts\)/g) || []).length, 2);
    const cli = read("scripts", "import-csv-cli.js");
    assert.match(cli, /a\.startsWith\("--positive-means="\)/);
    assert.match(cli, /POSITIVE_MEANS\.includes\(positiveMeans\)/);
    assert.match(cli, /fmt\.parse\(row, fmt\.headerless \? fmt\.columns : Object\.keys\(row\), parseOpts\)/);
    assert.match(cli, /const target = args\.find\(a => !a\.startsWith\("--"\)\)/);
  });

  it("both upload forms show the sign choice only for a generic file and send it once chosen", () => {
    for (const [file, sel] of [["accounts.ejs", "csvSign"], ["dashboard.ejs", "csvSign"]]) {
      const src = read("teller", "views", file);
      assert.match(src, new RegExp(`${sel}(Field)?\\.hidden = (d|data)\\.format_detected !== 'generic'`), file);
      assert.match(src, /append\('positive_means', csvSign\.value\)/, file);
      assert.match(src, /csvSign\.value = (d|data)\.sign_guess \|\| 'charges'/, file);
    }
    assert.match(read("teller", "views", "accounts.ejs"), /<label for="csv-sign">Positive amounts in this file are<\/label>/);
    assert.match(read("teller", "views", "dashboard.ejs"), /aria-label="Positive amounts in this file are" id="dash-csv-sign"/);
  });
});

describe("F81 — insight emails and the webhook text", () => {
  it("the insight email is skipped only when insight_emails_enabled is false", () => {
    const src = read("teller", "routes", "insights.js");
    assert.match(src, /insight_modules, insight_emails_enabled FROM user_settings WHERE id = 1/);
    assert.match(src, /if \(settings\.insight_emails_enabled !== false\) try \{\s*const \{ sendPerSistantWebhook \} = require\("\.\/persistent"\);/);
    assert.match(read("teller", "services", "database.js"),
      /ADD COLUMN IF NOT EXISTS insight_emails_enabled BOOLEAN NOT NULL DEFAULT true/);
  });

  it("PATCH /api/settings takes a boolean only (INV-59)", async () => {
    const writes = [];
    dbModule.pool.query = async (sql, params) => { if (/UPDATE user_settings SET/.test(sql)) writes.push({ sql, params }); return { rows: [{}] }; };
    const a = express(); a.use(express.json()); a.use(require("../teller/routes/settings"));
    for (const v of ["false", 0, null]) {
      const r = await supertest(a).patch("/api/settings").send({ insight_emails_enabled: v });
      assert.equal(r.status, 400, JSON.stringify(v));
    }
    assert.equal(writes.length, 0);
    await supertest(a).patch("/api/settings").send({ insight_emails_enabled: false }).expect(200);
    assert.match(writes[0].sql, /insight_emails_enabled = \$1/);
    assert.equal(writes[0].params[0], false);
  });

  it("Settings has the toggle; no text points at a Settings section that doesn't exist", () => {
    const ejs = read("teller", "views", "settings.ejs");
    assert.match(ejs, /id="insight-email-toggle"/);
    assert.match(ejs, /saveToggle\(this, 'insight_emails_enabled'\)/);
    assert.match(ejs, /s\.insight_emails_enabled !== false/);
    for (const f of [["teller", "views", "settings.ejs"], ["teller", "routes", "persistent.js"]]) {
      assert.doesNotMatch(read(...f), /Per-sistant integration below|Settings → Per-sistant integration/, f.join("/"));
    }
    assert.match(read("teller", "routes", "persistent.js"), /PATCH \/api\/settings \{ persistent_webhook_secret \}/);
  });
});

describe("F85 — month archives are rebuilt when their content changes", () => {
  // A stateful fake Sheets API that keeps protected ranges (with ids) and honours deletes.
  function fakeSheets(sheets = []) {
    let nextId = 500, nextRange = 1;
    const calls = { clear: [], update: [] };
    const api = {
      calls, sheets,
      spreadsheets: {
        get: async () => ({ data: { sheets } }),
        batchUpdate: async (p) => {
          const replies = p.requestBody.requests.map((r) => {
            if (r.addSheet) {
              const sheetId = nextId++;
              sheets.push({ properties: { title: r.addSheet.properties.title, sheetId }, protectedRanges: [] });
              return { addSheet: { properties: { sheetId, title: r.addSheet.properties.title } } };
            }
            if (r.deleteProtectedRange) {
              for (const sh of sheets) sh.protectedRanges = (sh.protectedRanges || []).filter((x) => x.protectedRangeId !== r.deleteProtectedRange.protectedRangeId);
            }
            if (r.addProtectedRange) {
              const sh = sheets.find((x) => x.properties.sheetId === r.addProtectedRange.protectedRange.range.sheetId);
              sh.protectedRanges = [...(sh.protectedRanges || []), { protectedRangeId: nextRange++, description: r.addProtectedRange.protectedRange.description }];
            }
            return {};
          });
          return { data: { replies } };
        },
        values: {
          update: async (p) => { calls.update.push(p.range); return {}; },
          clear: async (p) => { calls.clear.push(p.range); return {}; },
          append: async () => ({}),
        },
      },
    };
    return api;
  }
  const pool = (fps) => ({ query: async (sql) => {
    if (/AS fp/.test(sql)) return { rows: Object.entries(fps).map(([month, fp]) => ({ month, fp })) };
    return { rows: [{ date: "2020-01-05", merchant: "Shop", amount: "12.50", transaction_id: "t1" }] };
  } });
  const marker = (api, title) => api.sheets.find((s) => s.properties.title === title).protectedRanges.map((p) => p.description);

  it("the marker carries the fingerprint; one grouped query computes it per month", () => {
    assert.equal(I.archiveMarker("2020-01", "abc123def456"), "Perfin archive complete — 2020-01 · abc123def456");
    assert.equal(I.archiveMarker("2020-01"), "Perfin archive complete — 2020-01", "the legacy form");
    const sql = I.ARCHIVE_MONTHS_SQL("'2026-10'");
    assert.match(sql, /LEFT\(md5\(string_agg\(/);
    assert.match(sql, /ORDER BY t\.transaction_id\)\), 12\) AS fp/);
    assert.match(sql, /COALESCE\(t\.user_merchant_name, t\.merchant_name, t\.name, ''\)/);
    assert.match(sql, /COALESCE\(t\.user_category, t\.category\[1\], ''\)/);
    assert.match(sql, /GROUP BY 1/);
  });

  it("an unchanged month is left alone; a changed one is rebuilt; a legacy marker is rebuilt once", async () => {
    const api = fakeSheets([
      { properties: { title: "2020-03 Transactions", sheetId: 3 }, protectedRanges: [{ protectedRangeId: 90, description: I.archiveMarker("2020-03") }] },
    ]);
    assert.equal(await I.syncMonthArchives(api, pool({ "2020-01": "aaa", "2020-02": "bbb", "2020-03": "ccc" })), 3);
    assert.deepEqual(api.calls.clear, ["2020-03 Transactions!A:Z"], "only the legacy tab had content to clear");
    assert.deepEqual(marker(api, "2020-03 Transactions"), [I.archiveMarker("2020-03", "ccc")], "the legacy marker is replaced, not stacked");

    assert.equal(await I.syncMonthArchives(api, pool({ "2020-01": "aaa", "2020-02": "bbb", "2020-03": "ccc" })), 0, "nothing changed");

    api.calls.clear.length = 0; api.calls.update.length = 0;
    assert.equal(await I.syncMonthArchives(api, pool({ "2020-01": "aaa", "2020-02": "b2b", "2020-03": "ccc" })), 1);
    assert.deepEqual(api.calls.clear, ["2020-02 Transactions!A:Z"]);
    assert.deepEqual(api.calls.update, ["2020-02 Transactions!A1"]);
    assert.deepEqual(marker(api, "2020-02 Transactions"), [I.archiveMarker("2020-02", "b2b")]);
  });
});
