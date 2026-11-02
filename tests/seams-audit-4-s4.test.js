// Seams & Invariants audit #4, batch S4-4 (the cross-app notification seam):
//   A2 — Perfin's "open linked task" is Per-sistant's own predicate
//        (openLinkedItems — no source_detached filter), so the two apps agree;
//   A6 — Per-sistant counts a Perfin push HELD for quiet hours as Perfin's;
//   A5 — queryPersistentStats uses Per-sistant's /api/stats filters;
//   A4 — the Perfin widget reads next_expected as its calendar-day text.
// The database-backed half is tests/contract/seams4-s4-4.contract.test.js.
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("A2 — one 'open linked task' predicate for both apps", () => {
  const persistent = require("../teller/routes/persistent");
  const notifications = require("../teller/routes/notifications");
  after(() => persistent.setEmbeddedPersistentPool(null));

  it("itemCovered asks Per-sistant's openLinkedItems — a hand-reopened (detached) task covers its item", async () => {
    const seen = [];
    persistent.setEmbeddedPersistentPool({
      query: async (sql, params) => {
        seen.push([sql, params]);
        // The row a detached, open task returns: openLinkedItems doesn't filter on source_detached.
        return { rows: params[0].map((source_key) => ({ source_key })) };
      },
    });
    assert.equal(await notifications.itemCovered("housing:2026-11"), true);
    assert.deepEqual(seen[0][1], [["perfin:housing:2026-11"]]);
    assert.doesNotMatch(seen[0][0], /source_detached/);
    const { openLinkedItems } = require("../apps/per-sistant/services/linked-tasks");
    const ps = [];
    await openLinkedItems({ query: async (sql) => { ps.push(sql); return { rows: [] }; } }, ["housing:2026-11"]);
    assert.equal(seen[0][0], ps[0], "the same SQL in both apps");
  });

  it("no Per-sistant pool or a failed read → not covered (the push goes out)", async () => {
    persistent.setEmbeddedPersistentPool(null);
    assert.equal(await notifications.itemCovered("housing:2026-11"), false);
    persistent.setEmbeddedPersistentPool({ query: async () => { throw new Error("down"); } });
    const orig = console.error;
    console.error = () => {};
    try { assert.equal(await notifications.itemCovered("housing:2026-11"), false); } finally { console.error = orig; }
  });

  it("no hand-written todos query is left in Perfin's notifications route", () => {
    assert.doesNotMatch(read("teller", "routes", "notifications.js"), /FROM todos/);
  });
});

describe("A6 — a held Perfin push counts as Perfin's", () => {
  it("perfinPushedItems reads sent and held rows, not expired / muted / covered / none", async () => {
    const { perfinPushedItems } = require("../apps/per-sistant/routes/notifications");
    let sql = null;
    await perfinPushedItems({ query: async (s) => { sql = s; return { rows: [] }; } }, ["housing:2026-11"]);
    assert.match(sql, /push_state IN \('sent', 'held'\)/);
  });
});

describe("A5 — Perfin's embedded productivity stats use /api/stats' filters", () => {
  const { queryPersistentStats } = require("../teller/routes/persistent");
  it("done leaves out missed and auto-closed tasks; overdue is against the given local day", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{}] }; } };
    await queryPersistentStats(pool, "2026-11-02");
    const [sql, params] = calls.find(([s]) => /FROM todos/.test(s));
    assert.match(sql, /FILTER \(WHERE completed AND NOT COALESCE\(missed, false\) AND NOT auto_closed\) as done/);
    assert.match(sql, /due_date <= \$1::date\) as overdue/);
    assert.doesNotMatch(sql, /CURRENT_DATE/);
    assert.deepEqual(params, ["2026-11-02"]);
  });

  it("the same todos SQL as Per-sistant's /api/stats", () => {
    const ps = read("apps", "per-sistant", "routes", "settings.js");
    const psSql = /pool\.query\("(SELECT count\(\*\) FILTER \(WHERE NOT completed\) as pending[^"]+)"/.exec(ps)[1];
    const pf = read("teller", "routes", "persistent.js");
    const pfSql = /"(SELECT count\(\*\) FILTER \(WHERE NOT completed\) as pending[^"]+)"/.exec(pf)[1];
    assert.equal(pfSql, psSql);
  });
});

describe("A4 — the Perfin widget's next_expected is the calendar day", () => {
  it("the embedded query reads next_expected::text", () => {
    const src = read("apps", "per-sistant", "routes", "perfin.js");
    assert.match(src, /SELECT display_name, amount, cadence_days, next_expected::text AS next_expected\s+FROM detected_subscriptions/);
  });
});
