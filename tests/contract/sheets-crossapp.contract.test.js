// Real-Postgres contract tests for the cycle-7 Batch 9 Sheets / cross-app
// fixes: the Utilities and Important Dates tabs placing manual bills and
// transfers with the app's cadence rules (F76), the Credit Scores change per
// score type (F86), notification_log retention (F86) and the in-process digest
// reporting a draft as not sent (F79). The Google Sheets API is a recording
// fake; everything else is real.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb, persistentDb } = require("./_setup");

function fakeSheets() {
  const meta = [];
  let nextId = 500;
  const updates = [];
  return {
    updates,
    spreadsheets: {
      get: async () => ({ data: { sheets: meta } }),
      batchUpdate: async (p) => ({ data: { replies: p.requestBody.requests.map((r) => {
        if (!r.addSheet) return {};
        const sheetId = nextId++;
        meta.push({ properties: { title: r.addSheet.properties.title, sheetId } });
        return { addSheet: { properties: { sheetId, title: r.addSheet.properties.title } } };
      }) } }),
      values: {
        update: async (p) => { updates.push(p); return {}; },
        append: async () => ({}),
        clear: async () => ({}),
      },
    },
  };
}
const valuesFor = (api, sheet) => {
  const u = api.updates.filter((p) => p.range.startsWith(sheet + "!"));
  return u.length ? u[u.length - 1].requestBody.values : [];
};
// 'YYYY-MM-DD' helpers on the UTC calendar (APP_TIMEZONE is UTC in the suite).
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

describe("Sheets + cross-app on real Postgres", { skip: SKIP }, () => {
  let pool, ppool, I, today;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    process.env.GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "contract-sheet";
    pool = await perfinDb("sheetsx");
    ppool = await persistentDb("sheetsx");
    I = require("../../scripts/sheets-sync")._internals;
    today = require("../../teller/services/financial-queries").todayStr();
  });
  after(async () => {
    if (pool) await pool.end();
    if (ppool) await ppool.end();
  });

  it("F76: a yearly utility bill's next due is its anniversary, not next month", async () => {
    const [y, m] = today.split("-").map(Number);
    // Created last month → the yearly anniversary is ~11 months away.
    await q(`INSERT INTO manual_bills (name, amount, due_day, cadence, category, created_at)
             VALUES ('Water (yearly)', 300, 5, 'yearly', 'utility', $1::date)`, [ymd(y, m - 2, 10)]);
    const api = fakeSheets();
    await I.syncUtilities(api, pool);
    const row = valuesFor(api, "Utilities").find((r) => r[0] === "Water (yearly)");
    assert.ok(row, "utility row written");
    assert.equal(row[5], ymd(y + 1, m - 2, 5), "next due = the anniversary month + due_day");
  });

  it("F76: Important Dates lists every monthly occurrence and steps a month-end transfer by calendar month", async () => {
    const [y, m] = today.split("-").map(Number);
    await q(`INSERT INTO manual_bills (name, amount, due_day, cadence, category, created_at)
             VALUES ('Gym', 40, 31, 'monthly', 'other', $1::date)`, [ymd(y, m - 3, 1)]);
    // Last transfer on the last day of two months ago, monthly cadence: the
    // calendar-month series lands on this month's last day. Adding 30 days put
    // it in LAST month (before today), so the transfer was dropped.
    const lastTransfer = ymd(y, m - 2, 0); // last day of the month before last
    await q(`INSERT INTO recurring_transfers (merchant_key, display_name, amount, cadence_days, transfer_type, direction, last_transferred, next_expected, first_seen, is_active)
             VALUES ('rent-xfer', 'Rent transfer', 1500, 30, 'peer_transfer', 'outgoing', $1::date, $1::date + 30, $1::date - 60, true)`, [lastTransfer]);
    const api = fakeSheets();
    await I.syncImportantDates(api, pool);
    const rows = valuesFor(api, "Important Dates");
    const gym = rows.filter((r) => r[3] === "Gym");
    assert.ok(gym.length >= 2, `every monthly occurrence in 90 days: ${JSON.stringify(gym.map((r) => r[0]))}`);
    for (const r of gym) {
      const [yy, mm, dd] = r[0].split("-").map(Number);
      assert.equal(dd, new Date(Date.UTC(yy, mm, 0)).getUTCDate(), "due day 31 → the month's last day (no 28 cap)");
    }
    const xfer = rows.find((r) => r[3] === "Rent transfer");
    assert.ok(xfer, "the month-end transfer is listed");
    // Two calendar months after the anchor, its day clamped to this month.
    const anchorDay = Number(lastTransfer.slice(8, 10));
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    assert.equal(xfer[0], ymd(y, m - 1, Math.min(anchorDay, dim)));
  });

  it("F86: the Credit Scores change compares the same score type only", async () => {
    await q(`INSERT INTO credit_scores (score, score_type, checked_at) VALUES
             (700, 'fico', '2026-01-01'), (650, 'vantagescore', '2026-02-01'), (720, 'fico', '2026-03-01')`);
    const api = fakeSheets();
    await I.syncCreditScores(api, pool);
    const rows = valuesFor(api, "Credit Scores");
    const byDate = Object.fromEntries(rows.slice(1).filter((r) => r[0]).map((r) => [r[0], r[5]]));
    assert.equal(byDate["2026-03-01"], "+20", "FICO 720 vs the earlier FICO 700, not the VantageScore 650");
    assert.equal(byDate["2026-02-01"], "", "the only VantageScore has nothing to compare with");
  });

  it("F86: read notifications past the retention window are pruned; unread ones stay", async () => {
    const notifications = require("../../teller/routes/notifications");
    await q(`INSERT INTO notification_log (type, title, body, data, is_read, created_at) VALUES
             ('old-read', 'a', '', '{}', true, now() - interval '200 days'),
             ('old-unread', 'b', '', '{}', false, now() - interval '200 days'),
             ('new-read', 'c', '', '{}', true, now() - interval '10 days')`);
    await notifications.pruneNotificationLog(Date.now() + 2 * 86400000);
    const types = (await q("SELECT type FROM notification_log ORDER BY type")).rows.map((r) => r.type);
    assert.deepEqual(types, ["new-read", "old-unread"]);
  });

  it("F79: an in-process digest with no valid recipient is saved as a draft and reported NOT sent", async () => {
    const persistent = require("../../teller/routes/persistent");
    persistent.setEmbeddedPersistentPool(ppool);
    const prev = { from: process.env.SMTP_FROM, user: process.env.SMTP_USER };
    delete process.env.SMTP_FROM; delete process.env.SMTP_USER;
    try {
      await ppool.query("UPDATE user_settings SET perfin_webhook_recipient = NULL WHERE id = 1");
      const r1 = await persistent.sendPerSistantWebhook("weekly_summary", { subject: "W", plain_text: "x" });
      assert.deepEqual({ sent: r1.sent, stored: r1.stored, reason: r1.reason }, { sent: false, stored: "draft", reason: "no_recipient_configured" });
      await ppool.query("UPDATE user_settings SET perfin_webhook_recipient = 'not-an-address' WHERE id = 1");
      const r2 = await persistent.sendPerSistantWebhook("daily_summary", { subject: "D", plain_text: "y" });
      assert.equal(r2.sent, false);
      assert.equal(r2.reason, "invalid_recipient");
      await ppool.query("UPDATE user_settings SET perfin_webhook_recipient = 'me@example.com' WHERE id = 1");
      const r3 = await persistent.sendPerSistantWebhook("weekly_summary", { subject: "W2", plain_text: "z" });
      assert.equal(r3.sent, true);
      const statuses = (await ppool.query("SELECT subject, status FROM emails ORDER BY id")).rows.map((r) => `${r.subject}:${r.status}`);
      assert.deepEqual(statuses, ["W:draft", "D:draft", "W2:scheduled"]);
    } finally {
      persistent.setEmbeddedPersistentPool(null);
      if (prev.from !== undefined) process.env.SMTP_FROM = prev.from;
      if (prev.user !== undefined) process.env.SMTP_USER = prev.user;
    }
  });
});
