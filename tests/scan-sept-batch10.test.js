// ============================================================================
// Broad-scan (Sept 2026) Batch 10 — Sheets & exports
// ============================================================================
// SXE-1/WD-6  Sheets sync errors are persisted, notified (deduped), surfaced
//             in data-health + Settings, and shown as "Partial" in the UI
// SXE-2       formatting is re-runnable (banding / rules deleted before re-add)
// SXE-14      one metadata read per run, 429-aware retries, archive cap
// SXE-3       month archives: 10-day delay + completion marker + rebuild
// SXE-5       Sheets goals use the derived (funding-linked) progress
// SXE-6       Sheets category expression = the app's (no PFC fallback; SX3)
// SXE-10      the Active Subscriptions count isn't currency-formatted
// SXE-13      formula-injection guard for Sheets cells and CSV fields
// SXE-8/PSC-10 ISO dates + user merchant names in CSV exports
// SXE-9       context-export: real insights, investments, debts as negatives
// SXE-15      Code.gs: user category wins; refuses a server-written layout
// SXE-16      doc drift
// ============================================================================

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
process.env.GOOGLE_SHEETS_ID = "sheet-test-id";
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "/nonexistent/key.json";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const sheetsSync = require("../scripts/sheets-sync");
const I = sheetsSync._internals;
const dbModule = require("../teller/services/database");
const notifications = require("../teller/routes/notifications");

// ---------------------------------------------------------------------------
describe("SXE-1 — Sheets sync outcome is recorded and surfaced", () => {
  const settings = require("../teller/routes/settings");
  let origQuery, origSend, origSyncAll, stored, sent;
  before(() => { origQuery = dbModule.pool.query; origSend = notifications.sendToAll; origSyncAll = sheetsSync.syncAll; });
  after(() => { dbModule.pool.query = origQuery; notifications.sendToAll = origSend; sheetsSync.syncAll = origSyncAll; });
  afterEach(() => { stored = undefined; sent = []; });

  function fakePool(extra = {}) {
    dbModule.pool.query = async (sql, params) => {
      if (/SELECT last_sheets_sync_result FROM user_settings/.test(sql)) return { rows: [{ last_sheets_sync_result: stored || null }] };
      if (/UPDATE user_settings SET last_sheets_sync_result/.test(sql)) { stored = JSON.parse(params[0]); return { rows: [] }; }
      if (extra.handler) return extra.handler(sql, params);
      return { rows: [] };
    };
    notifications.sendToAll = async (n) => { sent.push(n); return { logged: true }; };
  }

  it("persists the failed tabs and notifies once per CHANGE in the failing set", async () => {
    sent = []; fakePool();
    const r1 = await settings.recordSheetsSyncResult({ errors: [{ step: "dashboard", error: "403 forbidden" }, { step: "income", error: "403 forbidden" }] });
    assert.equal(r1.ok, false);
    assert.equal(r1.tabs_failed, 2);
    assert.deepEqual(stored.errors.map((e) => e.step), ["dashboard", "income"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /2 tabs failed/);
    // Same failing set (order-independent) → no second notification.
    await settings.recordSheetsSyncResult({ errors: [{ step: "income", error: "403" }, { step: "dashboard", error: "403" }] });
    assert.equal(sent.length, 1);
    // A different set → notifies again; a clean run clears + stays quiet.
    await settings.recordSheetsSyncResult({ errors: [{ step: "watchlist", error: "boom" }] });
    assert.equal(sent.length, 2);
    const clean = await settings.recordSheetsSyncResult({ errors: [] });
    assert.equal(clean.ok, true);
    assert.equal(stored.ok, true);
    assert.equal(sent.length, 2);
  });

  it("POST /api/sheets/sync reports partial instead of plain success, and records a wholesale throw", async () => {
    sent = []; fakePool();
    const app = express(); app.use(express.json()); app.use(settings);
    sheetsSync.syncAll = async () => ({ transactions_synced: 5, errors: [{ step: "investments", error: "429" }] });
    const res = await supertest(app).post("/api/sheets/sync").expect(200);
    assert.equal(res.body.partial, true);
    assert.equal(res.body.tabs_failed, 1);
    sheetsSync.syncAll = async () => { throw new Error("invalid_grant"); };
    await supertest(app).post("/api/sheets/sync").expect(500);
    assert.deepEqual(stored.errors, [{ step: "sync", error: "invalid_grant" }]);
  });

  it("data-health raises an issue from the last result", async () => {
    stored = { at: "2026-10-01T00:00:00Z", ok: false, tabs_failed: 1, errors: [{ step: "dashboard", error: "403 forbidden" }] };
    dbModule.pool.query = async (sql) => {
      if (/FROM user_settings/.test(sql)) return { rows: [{ last_txn_sync_at: new Date(), last_balance_sync_at: new Date(), last_sheets_sync_result: stored }] };
      return { rows: [{ total: 0, disconnected: 0, not_good: 0 }] };
    };
    const app = express(); app.use(settings);
    const res = await supertest(app).get("/api/data-health").expect(200);
    assert.ok(res.body.issues.some((i) => /Google Sheets sync: 1 tab\(s\) failed .*dashboard/.test(i.message)));
    assert.equal(res.body.last_sheets_sync_result.tabs_failed, 1);
  });

  it("the scheduler records the outcome (incl. a throw) and every UI caller shows partial failures", () => {
    const st = read("teller", "startup.js");
    assert.match(st, /result = await sheetsSync\.syncAll\(\);[\s\S]*?catch \(e\) \{\s*result = \{ errors: \[\{ step: "sync"[\s\S]*?recordSheetsSyncResult\(result\)/);
    const dash = read("teller", "views", "dashboard.ejs");
    assert.match(dash, /'Partial: ' \+ failedTabs/);
    assert.doesNotMatch(dash.slice(dash.indexOf("dash-sync-sheets-btn")), /typeof showStatus/);
    assert.match(read("teller", "views", "subscriptions.ejs"), /Sheets sync partial: ' \+ data\.errors\.length/);
    assert.match(read("teller", "views", "settings.ejs"), /last_sheets_sync_result[\s\S]*?'Partial: '/);
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS last_sheets_sync_result JSONB/);
  });
});

// ---------------------------------------------------------------------------
function fakeSheets(state = {}) {
  const calls = { get: [], batchUpdate: [], update: [], clear: [], append: [] };
  const sheetsMeta = state.sheets || [];
  let nextId = 900;
  const api = {
    calls,
    spreadsheets: {
      get: async (p) => { calls.get.push(p); return { data: { sheets: sheetsMeta } }; },
      batchUpdate: async (p) => {
        calls.batchUpdate.push(p);
        const replies = p.requestBody.requests.map((r) => {
          if (r.addSheet) {
            const sheetId = nextId++;
            sheetsMeta.push({ properties: { title: r.addSheet.properties.title, sheetId }, protectedRanges: [] });
            return { addSheet: { properties: { sheetId, title: r.addSheet.properties.title } } };
          }
          if (r.addProtectedRange) {
            const sh = sheetsMeta.find((x) => x.properties.sheetId === r.addProtectedRange.protectedRange.range.sheetId);
            if (sh) sh.protectedRanges = [...(sh.protectedRanges || []), { description: r.addProtectedRange.protectedRange.description }];
          }
          return {};
        });
        return { data: { replies } };
      },
      values: {
        update: async (p) => { calls.update.push(p); return {}; },
        append: async (p) => { calls.append.push(p); return {}; },
        clear: async (p) => { calls.clear.push(p); return {}; },
      },
    },
  };
  return api;
}

describe("SXE-2 — formatting is re-runnable", () => {
  it("deletes existing banding + conditional rules (highest index first) before the tab's own requests", async () => {
    const api = fakeSheets({ sheets: [
      { properties: { sheetId: 7 }, bandedRanges: [{ bandedRangeId: 11 }, { bandedRangeId: 12 }], conditionalFormats: [{}, {}, {}] },
      { properties: { sheetId: 8 }, bandedRanges: [{ bandedRangeId: 99 }], conditionalFormats: [{}] },
    ] });
    const own = [{ addBanding: { bandedRange: { range: { sheetId: 7 } } } }, { addConditionalFormatRule: { rule: {}, index: 0 } }];
    await I.formatSheet(api, 7, own);
    const reqs = api.calls.batchUpdate[0].requestBody.requests;
    assert.deepEqual(reqs.slice(0, 5), [
      { deleteBanding: { bandedRangeId: 11 } }, { deleteBanding: { bandedRangeId: 12 } },
      { deleteConditionalFormatRule: { sheetId: 7, index: 2 } },
      { deleteConditionalFormatRule: { sheetId: 7, index: 1 } },
      { deleteConditionalFormatRule: { sheetId: 7, index: 0 } },
    ]);
    assert.deepEqual(reqs.slice(5), own, "only this sheet's state is cleared; the tab's requests follow in ONE batch");
    assert.equal(api.calls.batchUpdate.length, 1);
    assert.match(api.calls.get[0].fields, /bandedRanges\(bandedRangeId\),conditionalFormats/);
  });

  it("resetFormats wipes cell formatting first (the Dashboard); plain passes skip the metadata read", async () => {
    const api = fakeSheets({ sheets: [{ properties: { sheetId: 3 } }] });
    await I.formatSheet(api, 3, [{ repeatCell: { range: { sheetId: 3 } } }], { resetFormats: true });
    assert.deepEqual(api.calls.batchUpdate[0].requestBody.requests[0], { repeatCell: { range: { sheetId: 3 }, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } });
    const api2 = fakeSheets();
    await I.formatSheet(api2, 3, [{ updateSheetProperties: {} }]);
    assert.equal(api2.calls.get.length, 0);
  });

  it("every format pass goes through formatSheet; the Dashboard resets formats", () => {
    const src = read("scripts", "sheets-sync.js");
    assert.ok((src.match(/await formatSheet\(sheets, sheetId, requests/g) || []).length >= 15);
    // The only remaining direct `{ requests }` batchUpdate is applyProtection's
    // (it deletes its own prior protections first).
    const direct = src.match(/await sheets\.spreadsheets\.batchUpdate\(\{\s*spreadsheetId: SPREADSHEET_ID,\s*requestBody: \{ requests \},\s*\}\);/g) || [];
    assert.equal(direct.length, 1);
    const ap = src.slice(src.indexOf("async function applyProtection("), src.indexOf("function fmtCurrency("));
    assert.match(ap, /requestBody: \{ requests \}/);
    const dash = src.slice(src.indexOf("async function buildDashboard("), src.indexOf("async function syncInsights("));
    assert.match(dash, /formatSheet\(sheets, sheetId, requests, \{ resetFormats: true \}\)/);
  });
});

describe("SXE-14 — API volume + quota retries", () => {
  it("sheet ids are read once per client with a fields mask; a new tab updates the cache", async () => {
    const api = fakeSheets({ sheets: [{ properties: { title: "Transactions", sheetId: 1 } }] });
    assert.equal(await I.ensureSheet(api, "Transactions"), false);
    assert.equal(await I.getSheetId(api, "Transactions"), 1);
    assert.equal(await I.ensureSheet(api, "Income"), true);
    assert.equal(await I.getSheetId(api, "Income"), 900);
    assert.equal(api.calls.get.length, 1, "one metadata read for the whole run");
    assert.equal(api.calls.get[0].fields, "sheets(properties(sheetId,title))");
  });

  it("429 retries any method; a 5xx POST is not retried (may have been applied); attempts are capped", () => {
    const err = (status, method, attempt = 0) => ({ response: status ? { status, headers: {} } : undefined, config: { method, retryConfig: { currentRetryAttempt: attempt } } });
    assert.equal(I.sheetsShouldRetry(err(429, "POST")), true);
    assert.equal(I.sheetsShouldRetry(err(503, "POST")), false);
    assert.equal(I.sheetsShouldRetry(err(503, "GET")), true);
    assert.equal(I.sheetsShouldRetry(err(400, "GET")), false);
    assert.equal(I.sheetsShouldRetry(err(429, "POST", 4)), false);
    assert.equal(I.sheetsRetryDelayMs({ response: { status: 429, headers: { "retry-after": "20" } } }, 1), 20000);
    assert.equal(I.sheetsRetryDelayMs({ response: { status: 429, headers: {} } }, 2), 30000);
    assert.ok(I.sheetsRetryDelayMs({ response: { status: 429, headers: {} } }, 9) <= 60000);
    assert.equal(I.SHEETS_RETRY_CONFIG.shouldRetry, I.sheetsShouldRetry);
    assert.match(read("scripts", "sheets-sync.js"), /google\.sheets\(\{ version: "v4", auth: client, retryConfig: SHEETS_RETRY_CONFIG \}\)/);
  });
});

// ---------------------------------------------------------------------------
describe("SXE-3 — month archives", () => {
  it("a month is archivable 10 days after it ends", () => {
    assert.equal(I.archiveReadyOn("2026-09"), "2026-10-10");
    assert.equal(I.archiveReadyOn("2026-02"), "2026-03-10");
    assert.equal(I.archiveReadyOn("2024-02"), "2024-03-10"); // leap Feb 29 + 10
    assert.equal(I.archiveReadyOn("2026-12"), "2027-01-10");
  });

  function archivePool(months) {
    return { query: async (sql) => {
      if (/SELECT DISTINCT TO_CHAR\(date, 'YYYY-MM'\) AS month/.test(sql)) return { rows: months.map((m) => ({ month: m })) };
      return { rows: [{ date: "2020-01-05", merchant: "=cmd", amount: "12.50", transaction_id: "t1" }] };
    } };
  }

  it("skips a COMPLETED archive, rebuilds one without the marker, and writes the marker last", async () => {
    const api = fakeSheets({ sheets: [
      { properties: { title: "2020-01 Transactions", sheetId: 1 }, protectedRanges: [{ description: I.archiveMarker("2020-01") }] },
      { properties: { title: "2020-02 Transactions", sheetId: 2 }, protectedRanges: [{ description: "Perfin sync — edits overwritten on next sync" }] },
    ] });
    const n = await I.syncMonthArchives(api, archivePool(["2020-01", "2020-02", "2020-03"]));
    assert.equal(n, 2, "02 rebuilt + 03 created; 01 untouched");
    assert.deepEqual(api.calls.clear.map((c) => c.range), ["2020-02 Transactions!A:Z"], "only the incomplete tab is cleared");
    const written = api.calls.update.map((u) => u.range);
    assert.deepEqual(written, ["2020-02 Transactions!A1", "2020-03 Transactions!A1"]);
    const sheet2 = api.calls.batchUpdate.flatMap((b) => b.requestBody.requests).filter((r) => r.addProtectedRange);
    assert.deepEqual(sheet2.map((r) => r.addProtectedRange.protectedRange.description), [I.archiveMarker("2020-02"), I.archiveMarker("2020-03")]);
    const del = api.calls.batchUpdate.flatMap((b) => b.requestBody.requests).filter((r) => r.deleteProtectedRange);
    assert.equal(del.length, 1, "the legacy generic protection is replaced by the marker");
  });

  it("builds at most MAX_ARCHIVES_PER_RUN tabs per run", async () => {
    const api = fakeSheets();
    const months = Array.from({ length: 9 }, (_, i) => `2019-0${i + 1}`);
    const n = await I.syncMonthArchives(api, archivePool(months));
    assert.equal(n, I.MAX_ARCHIVES_PER_RUN);
  });

  it("the month list is filtered by archiveReadyOn against the APP_TIMEZONE today", () => {
    const src = read("scripts", "sheets-sync.js");
    assert.match(src, /const ready = months\.filter\(\(\{ month \}\) => archiveReadyOn\(month\) <= today\);/);
    assert.match(src, /const today = sheetsTodayStr\(\);/);
  });
});

// ---------------------------------------------------------------------------
describe("SXE-5 / SXE-6 / SXE-10 — Sheets data fidelity", () => {
  const src = read("scripts", "sheets-sync.js");
  it("goals use the derived progress for funding-linked goals", () => {
    const q = src.slice(src.indexOf("// Financial goals."), src.indexOf("// Recurring transfers summary"));
    assert.match(q, /GREATEST\(0, COALESCE\(la\.available_balance, la\.current_balance\) - COALESCE\(g\.goal_baseline_amount, 0\)\)/);
    assert.match(q, /GREATEST\(0, ia\.balance - COALESCE\(g\.goal_baseline_amount, 0\)\)/);
    assert.match(q, /ELSE g\.current_amount\s+END AS current_amount/);
    assert.match(q, /LEFT JOIN linked_accounts\s+la ON la\.id = g\.funding_account_id/);
  });
  it("category expression has no PFC fallback", () => {
    assert.match(src, /const CAT_EXPR_PARENT = "COALESCE\(t\.user_category, t\.category\[1\], 'Uncategorized'\)";/);
  });
  it("the KPI row is skipped by the currency loop", () => {
    assert.match(src, /const kpiValuesRow = rows\.length;/);
    assert.match(src, /if \(r === kpiValuesRow\) continue;/);
  });
});

// ---------------------------------------------------------------------------
describe("SXE-13 — formula-injection guards", () => {
  it("guardCell neutralizes formula-leading and date-coercible text; our formulas pass", () => {
    const g = I.guardCell;
    assert.equal(g("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")");
    assert.equal(g("- spending rose"), "'- spending rose");
    assert.equal(g("+1 555"), "'+1 555");
    assert.equal(g("@here"), "'@here");
    assert.equal(g("7-11"), "'7-11");
    assert.equal(g("3/4"), "'3/4");
    assert.equal(g("Coffee"), "Coffee");
    assert.equal(g("2026-09-01"), "2026-09-01", "our ISO dates still parse as dates");
    assert.equal(g(-45.5), -45.5, "numbers untouched");
    assert.equal(g(I.sheetFormula("=SUM(A1:A3)")), "=SUM(A1:A3)");
  });

  it("guardSheetsWrites applies to update + append without mutating the caller's rows", async () => {
    const api = I.guardSheetsWrites(fakeSheets());
    const values = [["=evil()", 1]];
    await api.spreadsheets.values.update({ range: "A1", requestBody: { values } });
    await api.spreadsheets.values.append({ range: "A1", requestBody: { values: [["@x"]] } });
    assert.deepEqual(api.calls.update[0].requestBody.values, [["'=evil()", 1]]);
    assert.deepEqual(api.calls.append[0].requestBody.values, [["'@x"]]);
    assert.deepEqual(values, [["=evil()", 1]]);
  });

  it("the only formula strings the script writes are wrapped in sheetFormula()", () => {
    const src = read("scripts", "sheets-sync.js");
    const formulas = src.match(/= `=(IF|SPARKLINE)\(/g) || [];
    assert.equal(formulas.length, 0, "raw formula strings would now be neutralized");
    assert.equal((src.match(/sheetFormula\(`=/g) || []).length, 3);
  });

  it("csvText / csvDate", () => {
    const { csvText, csvDate } = require("../teller/services/csv-export");
    assert.equal(csvText('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvText("Joe's \"Diner\""), `"Joe's ""Diner"""`);
    assert.equal(csvText(null), `""`);
    assert.equal(csvDate(new Date(2026, 0, 5)), "2026-01-05");
    assert.equal(csvDate("2026-01-05"), "2026-01-05");
    assert.equal(csvDate(null), "");
  });
});

// ---------------------------------------------------------------------------
describe("SXE-8 / PSC-10 — CSV exports", () => {
  const settings = require("../teller/routes/settings");
  let orig;
  before(() => { orig = dbModule.pool.query; });
  after(() => { dbModule.pool.query = orig; });

  it("transactions CSV: ISO dates, the user's merchant rename, guarded text", async () => {
    let seenSql = "";
    dbModule.pool.query = async (sql) => {
      seenSql = sql;
      return { rows: [{ date: new Date(2026, 0, 5), merchant: "=cmd|calc", amount: "12.50", account: "Chk", institution: "Bank", category: "Food" }] };
    };
    const app = express(); app.use(settings);
    const res = await supertest(app).get("/api/export?type=transactions").expect(200);
    const line = res.text.split("\n")[1];
    assert.equal(line, `2026-01-05,"'=cmd|calc",12.50,"Chk","Bank","Food"`);
    assert.match(seenSql, /COALESCE\(t\.user_merchant_name, t\.merchant_name, t\.name\) AS merchant/);
  });

  it("subscriptions CSV: ISO dates and blank (not 'null') for missing ones", async () => {
    dbModule.pool.query = async () => ({ rows: [{ display_name: "Netflix", amount: "15.49", cadence_days: 30, category: "subscription",
      first_seen: new Date(2025, 5, 1), last_charged: new Date(2026, 8, 1), next_expected: null, is_active: true }] });
    const app = express(); app.use(settings);
    const res = await supertest(app).get("/api/export?type=subscriptions").expect(200);
    assert.equal(res.text.split("\n")[1], `"Netflix",15.49,30,"subscription",2025-06-01,2026-09-01,,true`);
  });
});

// ---------------------------------------------------------------------------
describe("SXE-9 — context-export", () => {
  const goals = require("../teller/routes/goals");
  let orig;
  before(() => { orig = dbModule.pool.query; });
  after(() => { dbModule.pool.query = orig; });

  it("real insight, investment accounts, debts as negatives, ISO dates, no Plaid phantom", async () => {
    const seen = [];
    dbModule.pool.query = async (sql) => {
      seen.push(sql);
      if (/FROM linked_accounts la\s+WHERE NOT EXISTS/.test(sql)) return { rows: [
        { name: "Checking", type: "depository", available_balance: "1000", current_balance: "1000" },
        { name: "Auto Loan", type: "loan", subtype: "auto", current_balance: "18000", apr: "6.9" },
        { name: "Visa", type: "credit", current_balance: "500" },
      ] };
      if (/FROM investment_accounts WHERE is_active/.test(sql)) return { rows: [{ name: "Schwab Brokerage", account_type: "brokerage", institution: "Schwab", balance: "52000" }] };
      if (/FROM financial_insights/.test(sql)) return { rows: [{ insight_text: "Real insight", created_at: new Date() }] };
      if (/FROM detected_subscriptions/.test(sql)) return { rows: [{ display_name: "Netflix", amount: "15.49", cadence_days: 30, category: "subscription", next_expected: new Date(2026, 9, 3) }] };
      if (/FROM net_worth_snapshots/.test(sql)) return { rows: [{ snapshot_date: new Date(2026, 9, 1), net_worth: "100", total_assets: "200", total_liabilities: "100" }] };
      return { rows: [] };
    };
    const app = express(); app.use(goals);
    const res = await supertest(app).get("/api/context-export").expect(200);
    const md = res.text;
    assert.match(md, /\*\*Auto Loan\*\* \(auto\): -\$18000\.00 owed @ 6\.9% APR/);
    assert.match(md, /\*\*Visa\*\* \(credit\): -\$500\.00 owed/);
    assert.match(md, /\*\*Checking\*\* \(depository\): \$1000\.00/);
    assert.match(md, /\*\*Schwab Brokerage\*\* \(brokerage, Schwab\): \$52000\.00/);
    assert.match(md, /next: 2026-10-03/);
    assert.match(md, /- 2026-10-01: \$100\.00/);
    assert.doesNotMatch(md, /GMT/);
    assert.ok(seen.some((s) => /FROM financial_insights WHERE entry_type = 'insight'/.test(s)));
    assert.ok(seen.some((s) => /ia\.plaid_account_id = la\.account_id AND ia\.is_active = true/.test(s)));
  });
});

// ---------------------------------------------------------------------------
describe("SXE-15 — Code.gs", () => {
  const gs = read("apps-script", "Code.gs");
  function extract(name) {
    const i = gs.indexOf("function " + name + "(");
    let depth = 0;
    for (let k = gs.indexOf("{", i); k < gs.length; k++) {
      if (gs[k] === "{") depth++;
      else if (gs[k] === "}") { depth--; if (depth === 0) return gs.slice(i, k + 1); }
    }
    return null;
  }
  // eslint-disable-next-line no-new-func
  const assertScriptLayout = new Function(extract("assertScriptLayout_") + "\nreturn assertScriptLayout_;")();
  const sheet = (row, name = "Transactions") => ({ getLastRow: () => 5, getName: () => name, getRange: () => ({ getValues: () => [row] }) });
  const TX = ["Date", "Merchant", "Amount", "Category", "Institution", "Account", "Import ID", "Transaction ID"];

  it("accepts its own layout and an empty tab; refuses the server's", () => {
    assertScriptLayout(sheet(TX), TX);
    assertScriptLayout({ getLastRow: () => 0 }, TX);
    assert.throws(() => assertScriptLayout(sheet(["Date", "Merchant", "Amount", "Account", "Institution", "Category", "Category (Detailed)", "Source"]), TX),
      /separate spreadsheet/);
  });

  it("every Transactions/Subscriptions acquisition is checked; the user's category wins over PFC", () => {
    assert.equal((gs.match(/assertScriptLayout_\((txnSheet|subSheet), /g) || []).length, 4);
    assert.match(gs, /txn\.category \|\| txn\.pfc_primary \|\| ""/);
    assert.doesNotMatch(gs, /txn\.pfc_primary \|\| txn\.category/);
  });
});

describe("SXE-16 — doc drift", () => {
  it("comments and CLAUDE.md match the code", () => {
    assert.doesNotMatch(read("scripts", "sheets-sync.js"), /is not mirrored here; see the/);
    const md = read("CLAUDE.md");
    assert.match(md, /AI Trust\*\* \(new\): 100 most-recent/);
    assert.match(md, /Tax Deductions YYYY \(one tab per year\)/);
  });
});
