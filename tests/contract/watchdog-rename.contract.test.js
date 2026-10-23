// Real-Postgres contract tests for cycle-7 Batch 15:
//  G5 (F53) — the subscription watchdog: a cancelled subscription charged more
//    than 7 days after the cancellation alerts once per charge; a price rise of
//    ≥ 5% or ≥ $1 alerts once per new price; a small change or a charge inside
//    the grace window doesn't.
//  ST2 (F55) — merchant rename rules: "Apply to all" on one transaction renames
//    every past + future row from that raw merchant, keeps a hand-renamed row,
//    folds the detected subscription onto the new name WITH its user state, and
//    deleting the rule reverts exactly the rows it renamed.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

describe("Subscription watchdog + rename rules on real Postgres", { skip: SKIP }, () => {
  let pool, app, subs, rename;
  const q = (s, p) => pool.query(s, p);
  const tx = (id, merchant, amount, date, extra = {}) => q(
    `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, user_merchant_name, category, pending)
     VALUES ('card', $1, $2, $3, $4, $4, $5, $6, false)`,
    [id, amount, date, merchant, extra.user || null, extra.category ? [extra.category] : null]);
  const logCount = async (type) => (await q("SELECT count(*)::int AS n FROM notification_log WHERE type = $1", [type])).rows[0].n;

  before(async () => {
    pool = await perfinDb("watchrename");
    app = perfinApp();
    subs = require("../../teller/routes/subscriptions");
    rename = require("../../teller/routes/merchant-rename");
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('i1','Bank','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items")).rows[0].id;
    await q(`INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance)
             VALUES ($1,'card','card','credit','credit card',0)`, [item]);
  });
  after(async () => { if (pool) await pool.end(); });

  describe("G5 — subscription watchdog", () => {
    let netflix, early, spotify, tiny;
    before(async () => {
      const ins = (key, amount, extra) => q(
        `INSERT INTO detected_subscriptions (merchant_key, display_name, amount, prior_amount, cadence_days,
           first_seen, last_charged, next_expected, is_active, amount_changed, cancelled_at)
         VALUES ($1, $1, $2, $3, 30, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [key, amount, extra.prior ?? amount, daysAgo(200), extra.last || daysAgo(5), daysAgo(-25),
         extra.active ?? true, !!extra.changed, extra.cancelled || null]).then((r) => r.rows[0].id);
      netflix = await ins("Netflix", 15.49, { cancelled: daysAgo(20), active: false });
      early = await ins("Hulu", 7.99, { cancelled: daysAgo(6), active: false });
      spotify = await ins("Spotify", 17.99, { prior: 15.49, changed: true, last: daysAgo(3) });
      tiny = await ins("Tiny", 10.2, { prior: 10.0, changed: true, last: daysAgo(3) });
      await tx("nf1", "Netflix", 15.49, daysAgo(5));   // 15 days after cancelling → alert
      await tx("hulu1", "Hulu", 7.99, daysAgo(2));     // 4 days after cancelling → grace
    });

    it("alerts once for a charge after cancellation and once for a price rise; not for the grace window or a small change", async () => {
      const r = await subs.runSubscriptionWatchdog();
      assert.deepEqual(r, { still_charging: 1, price_rises: 1 });
      assert.equal(await logCount("sub-still-charging-" + netflix), 1);
      assert.equal(await logCount("sub-still-charging-" + early), 0);
      assert.equal(await logCount("sub-price-" + spotify), 1);
      assert.equal(await logCount("sub-price-" + tiny), 0, "2% / $0.20 is below both thresholds");
      const nf = (await q("SELECT still_charging_txn, still_charging_at::text AS at, still_charging_amount FROM detected_subscriptions WHERE id = $1", [netflix])).rows[0];
      assert.deepEqual([nf.still_charging_txn, nf.at, Number(nf.still_charging_amount)], ["nf1", daysAgo(5), 15.49]);

      assert.deepEqual(await subs.runSubscriptionWatchdog(), { still_charging: 0, price_rises: 0 }, "no repeat");
      await tx("nf2", "Netflix", 15.49, daysAgo(1));
      assert.deepEqual(await subs.runSubscriptionWatchdog(), { still_charging: 1, price_rises: 0 }, "a NEW charge alerts again");
    });

    it("POST /api/detect runs the watchdog", async () => {
      const r = await supertest(app).post("/api/detect").expect(200);
      assert.ok(r.body.watchdog && typeof r.body.watchdog.still_charging === "number");
    });
  });

  describe("ST2 — merchant rename rules", () => {
    before(async () => {
      await tx("amzn1", "AMZN Mktp US", 12.99, daysAgo(90));
      await tx("amzn2", "AMZN Mktp US", 12.99, daysAgo(60));
      await tx("amzn3", "AMZN Mktp US", 12.99, daysAgo(30));
      await tx("amzn_hand", "AMZN Mktp US", 50, daysAgo(10), { user: "Gift for Sam" });
      await supertest(app).post("/api/detect").expect(200);
      const sub = (await q("SELECT id FROM detected_subscriptions WHERE merchant_key = 'AMZN Mktp US'")).rows[0];
      assert.ok(sub, "detected under the raw key first");
      await q("UPDATE detected_subscriptions SET cancelled_at = now(), is_active = false, notes = 'kept' WHERE id = $1", [sub.id]);
    });

    it("Apply to all renames past rows, keeps a hand-renamed row and folds the subscription with its state", async () => {
      const r = await supertest(app).patch("/api/transactions/amzn3")
        .send({ merchant_name: "Amazon Prime", apply_to_all: true }).expect(200);
      assert.equal(r.body.rename_rule.rename_to, "Amazon Prime");
      assert.equal(r.body.rename_rule_error, null);
      const names = Object.fromEntries((await q("SELECT transaction_id, user_merchant_name FROM transactions WHERE transaction_id LIKE 'amzn%'")).rows
        .map((x) => [x.transaction_id, x.user_merchant_name]));
      assert.deepEqual(names, { amzn1: "Amazon Prime", amzn2: "Amazon Prime", amzn3: "Amazon Prime", amzn_hand: "Gift for Sam" });
      const rows = (await q("SELECT merchant_key, is_active, cancelled_at IS NOT NULL AS cancelled, notes FROM detected_subscriptions WHERE merchant_key IN ('AMZN Mktp US', 'Amazon Prime')")).rows;
      assert.deepEqual(rows, [{ merchant_key: "Amazon Prime", is_active: false, cancelled: true, notes: "kept" }],
        "one row, re-keyed, still cancelled with its notes (detection didn't re-activate it)");
    });

    it("future rows from the merchant are renamed; a hand edit later wins", async () => {
      await tx("amzn4", "AMZN Mktp US", 12.99, daysAgo(0));
      assert.ok(await rename.applyRenameRules() >= 1);
      assert.equal((await q("SELECT user_merchant_name FROM transactions WHERE transaction_id = 'amzn4'")).rows[0].user_merchant_name, "Amazon Prime");
      await supertest(app).patch("/api/transactions/amzn4").send({ merchant_name: "Prime Video" }).expect(200);
      const row = (await q("SELECT user_merchant_name, user_merchant_rule_id FROM transactions WHERE transaction_id = 'amzn4'")).rows[0];
      assert.deepEqual(row, { user_merchant_name: "Prime Video", user_merchant_rule_id: null });
    });

    it("rejects a too-short contains rule and lists the rule", async () => {
      await supertest(app).post("/api/merchant-rename-rules").send({ merchant_pattern: "am", match_type: "contains", rename_to: "X" }).expect(400);
      const list = (await supertest(app).get("/api/merchant-rename-rules").expect(200)).body.rules;
      assert.equal(list.length, 1);
      assert.equal(list[0].merchant_pattern, "AMZN Mktp US");
    });

    it("deleting the rule reverts only the rows it renamed", async () => {
      const id = (await q("SELECT id FROM merchant_rename_rules")).rows[0].id;
      const r = await supertest(app).delete("/api/merchant-rename-rules/" + id).expect(200);
      assert.equal(r.body.reverted, 3);
      const names = Object.fromEntries((await q("SELECT transaction_id, user_merchant_name FROM transactions WHERE transaction_id LIKE 'amzn%'")).rows
        .map((x) => [x.transaction_id, x.user_merchant_name]));
      assert.deepEqual(names, { amzn1: null, amzn2: null, amzn3: null, amzn_hand: "Gift for Sam", amzn4: "Prime Video" });
    });
  });
});
