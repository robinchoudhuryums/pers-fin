// Real-Postgres contract tests for cycle-7 Batch 16 (Perfin side):
//  F26 — a generic CSV imported with positive_means=deposits stores charges
//        positive and the paycheck negative, and its preview then reports the
//        rows as already imported only under the same choice.
//  F81 — an insight run with insight_emails_enabled=false sends no email; the
//        default (true) still does.
//  F85 — the archive fingerprint query runs on the real schema: a month whose
//        rows change (a backfilled row, a rename) is rebuilt, the others are not.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

process.env.GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "contract-sheet";

const anthropicQueue = [];
class FakeAnthropic {
  constructor() {
    this.messages = { create: async () => {
      const r = anthropicQueue.shift();
      if (!r) throw new Error("FakeAnthropic: response queue empty");
      return r;
    } };
  }
}
const insightReply = () => ({
  content: [{ type: "tool_use", id: "tu_1", name: "generate_financial_insight", input: {
    insights_text: "## Overview\nA quiet month.",
    summary: { trends: [], completed_goals: [], pending_actions: [], alerts: [] },
  } }],
  stop_reason: "tool_use",
  usage: { input_tokens: 1000, output_tokens: 200 },
});

const GENERIC = [
  "Date,Description,Amount",
  "2026-09-01,ACME PAYROLL DIRECT DEP,2500.00",
  "2026-09-02,Coffee Shop,-4.50",
  "2026-09-03,Grocery Store,-82.10",
].join("\n");

describe("Batch 16 (Perfin) on real Postgres", { skip: SKIP }, () => {
  let pool, app, originalLoad;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    process.env.ANTHROPIC_API_KEY = "contract-test-key";
    originalLoad = Module._load;
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    pool = await perfinDb("batch16");
    app = perfinApp();
  });
  after(async () => {
    Module._load = originalLoad;
    if (pool) await pool.end();
  });

  describe("F26 — CSV sign", () => {
    it("positive_means=deposits stores charges positive and the paycheck as a credit", async () => {
      const pre = await supertest(app).post("/api/import-csv/preview")
        .attach("file", Buffer.from(GENERIC), "bank.csv").expect(200);
      assert.equal(pre.body.sign_guess, "deposits");
      const r = await supertest(app).post("/api/import-csv").field("positive_means", "deposits")
        .attach("file", Buffer.from(GENERIC), "bank.csv").expect(200);
      assert.equal(r.body.rows_imported, 3);
      assert.equal(r.body.positive_means, "deposits");
      const rows = Object.fromEntries((await q("SELECT merchant_name, amount::float AS a FROM transactions")).rows.map((x) => [x.merchant_name, x.a]));
      assert.deepEqual(rows, { "ACME PAYROLL DIRECT DEP": -2500, "Coffee Shop": 4.5, "Grocery Store": 82.1 });
    });

    it("the preview finds the rows already imported only under the same choice", async () => {
      const same = await supertest(app).post("/api/import-csv/preview").field("positive_means", "deposits")
        .attach("file", Buffer.from(GENERIC), "bank.csv").expect(200);
      assert.deepEqual([same.body.rows_new, same.body.rows_duplicate], [0, 3]);
      const other = await supertest(app).post("/api/import-csv/preview")
        .attach("file", Buffer.from(GENERIC), "bank.csv").expect(200);
      assert.deepEqual([other.body.rows_new, other.body.rows_duplicate], [3, 0],
        "the opposite sign makes different dedup IDs — which the preview shows before anything is written");
    });
  });

  describe("F81 — insight emails", () => {
    it("an insight run sends the email by default and skips it when switched off", async () => {
      const persistent = require("../../teller/routes/persistent");
      const insights = require("../../teller/routes/insights");
      const orig = persistent.sendPerSistantWebhook;
      const sent = [];
      persistent.sendPerSistantWebhook = async (event) => { sent.push(event); return { sent: true }; };
      try {
        anthropicQueue.push(insightReply());
        assert.equal((await insights.generateInsights()).ok, true);
        assert.deepEqual(sent, ["insights_generated"]);

        await supertest(app).patch("/api/settings").send({ insight_emails_enabled: false }).expect(200);
        const st = (await supertest(app).get("/api/settings").expect(200)).body;
        assert.equal(st.insight_emails_enabled, false);
        anthropicQueue.push(insightReply());
        assert.equal((await insights.generateInsights()).ok, true);
        assert.deepEqual(sent, ["insights_generated"], "no second email");
      } finally { persistent.sendPerSistantWebhook = orig; }
    });
  });

  describe("F85 — archive fingerprints", () => {
    function fakeSheets() {
      const sheets = [];
      let nextId = 100, nextRange = 1;
      const calls = { clear: [], update: [] };
      return { calls, sheets, spreadsheets: {
        get: async () => ({ data: { sheets } }),
        batchUpdate: async (p) => ({ data: { replies: p.requestBody.requests.map((r) => {
          if (r.addSheet) {
            const sheetId = nextId++;
            sheets.push({ properties: { title: r.addSheet.properties.title, sheetId }, protectedRanges: [] });
            return { addSheet: { properties: { sheetId, title: r.addSheet.properties.title } } };
          }
          if (r.deleteProtectedRange) for (const sh of sheets) sh.protectedRanges = sh.protectedRanges.filter((x) => x.protectedRangeId !== r.deleteProtectedRange.protectedRangeId);
          if (r.addProtectedRange) {
            const sh = sheets.find((x) => x.properties.sheetId === r.addProtectedRange.protectedRange.range.sheetId);
            sh.protectedRanges.push({ protectedRangeId: nextRange++, description: r.addProtectedRange.protectedRange.description });
          }
          return {};
        }) } }),
        values: {
          update: async (p) => { calls.update.push(p.range); return {}; },
          clear: async (p) => { calls.clear.push(p.range); return {}; },
          append: async () => ({}),
        },
      } };
    }
    const tx = (id, date, amount, merchant) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending)
       VALUES ((SELECT account_id FROM linked_accounts LIMIT 1), $1, $2, $3, $4, $4, false)`, [id, amount, date, merchant]);

    it("a backfilled row or an edit rebuilds exactly that month's archive", async () => {
      const I = require("../../scripts/sheets-sync")._internals;
      await q("DELETE FROM transactions");
      await tx("a1", "2025-01-05", 10, "Shop A");
      await tx("b1", "2025-02-05", 20, "Shop B");
      await tx("c1", "2025-03-05", 30, "Shop C");
      const api = fakeSheets();
      assert.equal(await I.syncMonthArchives(api, pool), 3);
      for (const s of api.sheets) assert.match(s.protectedRanges[0].description, /^Perfin archive complete — 2025-0\d · [0-9a-f]{12}$/);

      assert.equal(await I.syncMonthArchives(api, pool), 0, "unchanged months stay put");

      api.calls.clear.length = 0;
      await tx("b2", "2025-02-20", 5, "Late Charge");                    // a backfilled row
      await q("UPDATE transactions SET user_merchant_name = 'Shop C Renamed' WHERE transaction_id = 'c1'"); // an edit
      assert.equal(await I.syncMonthArchives(api, pool), 2);
      assert.deepEqual(api.calls.clear.sort(), ["2025-02 Transactions!A:Z", "2025-03 Transactions!A:Z"]);
      for (const s of api.sheets) assert.equal(s.protectedRanges.length, 1, "one marker per tab — the old one replaced");
    });
  });
});
