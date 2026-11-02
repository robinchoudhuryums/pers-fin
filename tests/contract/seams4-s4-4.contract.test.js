// Real-Postgres contract test for seams audit #4 batch S4-4 — the cross-app
// notification seam, with both apps' real databases wired the way the shell
// wires them (Perfin's embedded Per-sistant pool, Per-sistant's perfinPool):
//  A2 — a linked task you reopened by hand (source_detached) is "open" to BOTH
//       apps: Perfin's push for its item is covered, as Per-sistant hides its own
//  A6 — a Perfin push HELD for quiet hours counts as Perfin's (an expired hold
//       doesn't)
//  A5 — Perfin's embedded productivity stats agree with Per-sistant's /api/stats
//  A4 — the Perfin widget's next_expected is the calendar day itself
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, persistentApp } = require("./_setup");

describe("Seams audit #4 S4-4 across both apps on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, psApp, today;
  const ps = (s, p) => psPool.query(s, p);
  const pf = (s, p) => pfPool.query(s, p);

  before(async () => {
    psPool = await persistentDb("s4_4");
    pfPool = await perfinDb("s4_4");
    psApp = persistentApp(psPool);
    psApp.set("perfinPool", pfPool);
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(psPool);
    today = require("../../teller/services/financial-queries").todayStr();
  });
  after(async () => {
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(null);
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  it("A2: a hand-reopened linked task covers Perfin's push and hides Per-sistant's line alike", async () => {
    await ps(`INSERT INTO todos (title, source_app, source_key, source_url)
              VALUES ('Pay rent', 'perfin', 'perfin:housing:2026-11', '/housing')`);
    // Complete by hand, then reopen by hand — the trigger detaches it.
    await ps("UPDATE todos SET completed = true, completed_at = now() WHERE source_key = 'perfin:housing:2026-11'");
    await ps("UPDATE todos SET completed = false, completed_at = NULL WHERE source_key = 'perfin:housing:2026-11'");
    const row = (await ps("SELECT completed, source_detached FROM todos WHERE source_key = 'perfin:housing:2026-11'")).rows[0];
    assert.deepEqual([row.completed, row.source_detached], [false, true]);

    const { openLinkedItems } = require("../../apps/per-sistant/services/linked-tasks");
    const notifications = require("../../teller/routes/notifications");
    assert.ok((await openLinkedItems(psPool, ["housing:2026-11"])).has("housing:2026-11"), "Per-sistant: open");
    assert.equal(await notifications.itemCovered("housing:2026-11"), true, "Perfin: covered too");

    // Trashed → neither.
    await ps("UPDATE todos SET deleted_at = now() WHERE source_key = 'perfin:housing:2026-11'");
    assert.equal(await notifications.itemCovered("housing:2026-11"), false);
    assert.equal((await openLinkedItems(psPool, ["housing:2026-11"])).size, 0);
  });

  it("A6: a held Perfin push counts as Perfin's; an expired or muted one doesn't", async () => {
    const { perfinPushedItems } = require("../../apps/per-sistant/routes/notifications");
    const log = (item, state) => pf(
      "INSERT INTO notification_log (type, title, body, data, push_state, item_key) VALUES ('t', 't', 'b', '{}', $1, $2)", [state, item]);
    await log("housing:held", "held");
    await log("housing:sent", "sent");
    await log("housing:expired", "expired");
    await log("housing:muted", "muted");
    const got = await perfinPushedItems(pfPool, ["housing:held", "housing:sent", "housing:expired", "housing:muted"]);
    assert.deepEqual([...got].sort(), ["housing:held", "housing:sent"]);
  });

  it("A5: Perfin's embedded stats equal Per-sistant's /api/stats — no auto-closed or missed task done, overdue on the local day", async () => {
    await ps("DELETE FROM todos");
    await ps("INSERT INTO todos (title, completed, completed_at) VALUES ('done by hand', true, now())");
    await ps("INSERT INTO todos (title, completed, completed_at, missed) VALUES ('missed instance', true, NULL, true)");
    await ps(`INSERT INTO todos (title, source_app, source_key, completed, completed_at, auto_closed)
              VALUES ('closed by Perfin', 'perfin', 'perfin:housing:2026-10', true, now(), true)`);
    await ps("INSERT INTO todos (title, due_date) VALUES ('due today', $1::date)", [today]);
    const { queryPersistentStats } = require("../../teller/routes/persistent");
    const fromPerfin = (await queryPersistentStats(psPool)).todos;
    const fromPs = (await supertest(psApp).get("/api/stats").expect(200)).body.todos;
    assert.equal(Number(fromPerfin.done), 1);
    assert.equal(Number(fromPerfin.overdue), 1);
    for (const k of ["pending", "done", "urgent", "overdue"]) assert.equal(String(fromPerfin[k]), String(fromPs[k]), k);
  });

  it("A4: the widget's next_expected is the stored calendar day", async () => {
    await pf(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active)
              VALUES ('NETFLIX', 'Netflix', 15.49, 30, $1::date - 60, $1::date - 30, $1::date, true)`, [today]);
    const body = (await supertest(psApp).get("/api/perfin/stats").expect(200)).body;
    assert.equal(body.connected, true);
    const nf = body.upcoming.find((s) => s.display_name === "Netflix");
    assert.ok(nf, JSON.stringify(body));
    assert.equal(nf.next_expected, today);
  });
});
