// Seams & Invariants audit #4, batch S4-3 (forecast, freshness & restore):
//   S1 — the forecast's merchant key is the detectors' TRIMmed key;
//   S3 — "What's in this forecast" and the totals share one window (today+1 …),
//        so a bill due today is in neither;
//   S6 — the low cash alert's freshness gate reads the OLDEST bank-synced
//        spendable balance (an unknown one skips too); manual-only uses the newest;
//   S4 — Sync Health's "haven't synced" warnings follow the bank connections
//        (the badge's helper) when any exist;
//   S5 — GET /api/deleted-transactions' per-row `restorable` follows the restore
//        route's refusals, with the reason, and Settings words each.
// The database-backed half is tests/contract/seams4-s4-3.contract.test.js.
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("S1 — the forecast's merchant key is the detectors' trimmed key", () => {
  const cf = require("../teller/services/cash-flow");
  it("DETECT_KEY_T is merchant-rename's DETECT_KEY, and no untrimmed copy is left in cash-flow.js", () => {
    const mr = read("teller", "routes", "merchant-rename.js");
    const detect = /const DETECT_KEY = "([^"]+)";/.exec(mr)[1];
    assert.equal(cf.DETECT_KEY_T, detect);
    assert.match(cf.DETECT_KEY_T, /^TRIM\(COALESCE\(t\.user_merchant_name, /);
    const src = read("teller", "services", "cash-flow.js");
    assert.doesNotMatch(src, /[^(]COALESCE\(t\.user_merchant_name, t\.merchant_name, LOWER\(REGEXP_REPLACE\(t\.name/,
      "every copy is inside TRIM(…)");
    assert.equal((src.match(/\$\{DETECT_KEY_T\}/g) || []).length, 2, "the mirrored-credit test and the subscription exclusion");
  });
});

describe("S3 — a bill due today is in neither the totals nor the forecast list", () => {
  const cf = require("../teller/services/cash-flow");
  const bill = { display_name: "Rent", amount: "1500", cadence_days: 30, next_expected: "2026-01-30", last_date: "2025-12-30" };

  it("occurrences, next date and projected total cover today+1 … today+days only", () => {
    const out = cf.projectCashFlow({ today: "2026-01-30", bills: [bill] }, { days: 30 });
    const item = out.forecast_items.bills[0];
    assert.equal(item.occurrences, 1, "Feb 28 only — not today's Jan 30");
    assert.equal(item.next_date, "2026-02-28");
    assert.equal(item.projected_total, 1500);
    assert.equal(out.total_projected_bills, 1500, "the list and the totals agree");
    assert.ok(out.projection.every((d) => d.date > "2026-01-30"));
  });

  it("the same bill due tomorrow is counted", () => {
    const out = cf.projectCashFlow({ today: "2026-01-29", bills: [bill] }, { days: 30 });
    assert.equal(out.forecast_items.bills[0].next_date, "2026-01-30");
    assert.equal(out.total_projected_bills, 3000);
  });
});

describe("S6 — the cash alert's freshness gate", () => {
  const ca = require("../teller/services/cash-alerts");
  const NOW = new Date("2026-03-10T15:00:00Z");
  const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3);
  beforeEach(() => ca._reset());

  function fakePool(over) {
    const seen = [];
    return {
      seen,
      query: async (sql) => {
        seen.push(sql);
        if (/UPDATE user_settings SET cash_alert_state/.test(sql)) return { rows: [] };
        if (/FROM user_settings s/.test(sql)) {
          return { rows: [{ cash_alert_enabled: true, cash_alert_threshold: "500.00", cash_alert_horizon_days: 14,
            cash_alert_state: null, cash_alerts_checked_at: null, balances_at: hoursAgo(1), data_at: hoursAgo(1),
            oldest_synced_at: hoursAgo(1), synced_unknown: false, ...over }] };
        }
        if (/low_balance_floor IS NOT NULL/.test(sql)) return { rows: [] };
        throw new Error("unexpected query: " + sql.slice(0, 60));
      },
    };
  }
  const run = async (over) => {
    let forecasts = 0;
    const pool = fakePool(over);
    const r = await ca.runCashAlerts(pool, { now: NOW, today: "2026-03-10", deps: {
      forecast: async () => { forecasts++; return { projection: [{ date: "2026-03-11", balance: 900 }], lowest: { date: "2026-03-11", balance: 900 } }; },
      sendToAll: async () => ({ logged: true }), sendEmail: async () => ({}), sentRecently: async () => false,
    } });
    return { r, forecasts, pool };
  };

  it("the newest is fresh but the oldest bank-synced balance is 72 h old → skipped, no forecast", async () => {
    const { r, forecasts } = await run({ oldest_synced_at: hoursAgo(72) });
    assert.deepEqual([r.status, r.reason], ["skipped", "stale_balances"]);
    assert.equal(forecasts, 0);
  });

  it("a bank-synced balance never stamped → skipped", async () => {
    const { r } = await run({ synced_unknown: true });
    assert.equal(r.status, "skipped");
  });

  it("every bank-synced balance fresh → evaluated; manual-only (no synced account) → the newest decides", async () => {
    assert.equal((await run({ oldest_synced_at: hoursAgo(35) })).forecasts, 1);
    ca._reset();
    assert.equal((await run({ oldest_synced_at: null, synced_unknown: false })).forecasts, 1);
    ca._reset();
    assert.equal((await run({ oldest_synced_at: null, balances_at: hoursAgo(40) })).r.reason, "stale_balances");
  });

  it("the query selects both new columns, filtered to bank-synced accounts with a balance", async () => {
    const { pool } = await run({});
    const sql = pool.seen.find((s) => /FROM user_settings s/.test(s));
    assert.match(sql, /b\.balances_at, b\.oldest_synced_at, b\.synced_unknown/);
    assert.match(sql, /min\(la\.balance_updated_at\) FILTER \(WHERE /);
    assert.match(ca.SYNCED_WITH_BALANCE, /la\.teller_enrollment_id IS NOT NULL/);
    assert.match(ca.SYNCED_WITH_BALANCE, /pi\.status = 'GOOD'/);
    assert.match(ca.SYNCED_WITH_BALANCE, /la\.available_balance IS NOT NULL OR la\.current_balance IS NOT NULL/);
  });
});

describe("S4 — Sync Health's sync-age warnings follow the connections", () => {
  const { syncAgeIssues } = require("../teller/routes/settings");
  const fq = require("../teller/services/freshness");
  const NOW = Date.parse("2026-03-10T15:00:00Z");
  const conn = (provider, institution, hours, status = "GOOD") => ({
    provider, id: 1, institution, status,
    last_synced: fq.ageInfo(hours == null ? null : new Date(NOW - hours * 3600e3), NOW),
  });
  const stale = fq.ageInfo(new Date(NOW - 48 * 3600e3), NOW);
  const fresh = fq.ageInfo(new Date(NOW - 3600e3), NOW);
  const globals = { last_txn_sync_at: "x", last_balance_sync_at: "x" };

  it("fresh connections + stale global stamps (a webhook-only setup) → no warning", () => {
    const out = syncAgeIssues({ connections: [conn("plaid", "Capital One", 0.2)], connectionsRead: true,
      freshness: { transactions: stale, balances: stale }, settings: globals });
    assert.deepEqual(out, []);
  });

  it("one warning per stale or never-synced connection; re-auth / disconnected ones aren't repeated", () => {
    const out = syncAgeIssues({ connections: [
      conn("plaid", "Capital One", 30), conn("teller", "Chase", null), conn("plaid", "Discover", 50, "NEEDS_REAUTH"),
      conn("teller", "BofA", 50, "DISCONNECTED"), conn("plaid", "Schwab", 1),
    ], connectionsRead: true, freshness: { transactions: fresh, balances: fresh }, settings: globals });
    assert.deepEqual(out.map((i) => i.message), [
      "Capital One (Plaid) hasn't synced in over 24h.",
      "Chase (Teller) has no complete sync recorded yet.",
    ]);
    assert.ok(out.every((i) => i.severity === "warning" && i.link === "/settings#sync-health"));
  });

  it("the global balance stamp still counts while a Teller connection exists (its sync doesn't refresh balances)", () => {
    const f = { transactions: stale, balances: stale };
    assert.deepEqual(syncAgeIssues({ connections: [conn("teller", "Chase", 1)], connectionsRead: true, freshness: f, settings: globals })
      .map((i) => i.message), ["Balances haven't refreshed in over 24h."]);
    assert.deepEqual(syncAgeIssues({ connections: [conn("plaid", "Chase", 1)], connectionsRead: true, freshness: f, settings: globals }), []);
  });

  it("no connection, or a failed read → the global stamps as before", () => {
    const f = { transactions: stale, balances: stale };
    const msgs = (o) => syncAgeIssues(o).map((i) => i.message);
    assert.deepEqual(msgs({ connections: [], connectionsRead: true, freshness: f, settings: globals }),
      ["Transactions haven't synced in over 24h.", "Balances haven't refreshed in over 24h."]);
    assert.deepEqual(msgs({ connections: [conn("plaid", "X", 0.1)], connectionsRead: false, freshness: f, settings: globals }),
      ["Transactions haven't synced in over 24h.", "Balances haven't refreshed in over 24h."]);
    assert.deepEqual(syncAgeIssues({ connections: [], connectionsRead: true, freshness: f, settings: {} }).map((i) => [i.severity, i.message]),
      [["info", "No transaction sync has run yet."]]);
  });

  it("gatherDataHealth reads the connections once, before the issues, and shares them with the response", () => {
    const src = read("teller", "routes", "settings.js");
    const fn = src.slice(src.indexOf("async function gatherDataHealth("), src.indexOf('router.get("/api/data-health"'));
    assert.equal((fn.match(/freshnessSvc\.readConnections\(/g) || []).length, 1);
    assert.ok(fn.indexOf("readConnections(") < fn.indexOf("syncAgeIssues("));
    assert.doesNotMatch(fn, /freshness\.transactions\.level === "stale"/, "no global-stamp warning outside syncAgeIssues");
  });
});

describe("S5 — a deleted row's restorable follows the restore route", () => {
  const { unrestorableReason } = require("../teller/routes/transactions");
  it("bank-removed, a legacy manual entry and a gone account are refused; the rest restorable", () => {
    const row = (o) => ({ has_snapshot: true, bank_removed: false, account_linked: true, ...o });
    assert.equal(unrestorableReason(row({}), "plaid"), null);
    assert.equal(unrestorableReason(row({ bank_removed: true }), "plaid"), "removed_by_bank");
    assert.equal(unrestorableReason(row({ account_linked: false }), "csv"), "account_gone");
    assert.equal(unrestorableReason(row({ has_snapshot: false, account_linked: false }), "teller"), null, "a legacy tombstone is lifted");
    assert.equal(unrestorableReason(row({ has_snapshot: false, account_linked: false }), "manual"), "never");
    assert.equal(unrestorableReason(row({ has_snapshot: false, bank_removed: true }), "plaid"), "removed_by_bank");
  });

  it("the list's query reads both facts", () => {
    const src = read("teller", "routes", "transactions.js");
    const route = src.slice(src.indexOf('router.get("/api/deleted-transactions"'), src.indexOf("GROUP BY batch_id"));
    assert.match(route, /\(d\.bank_removed_at IS NOT NULL\) AS bank_removed, \(la\.id IS NOT NULL\) AS account_linked/);
    assert.match(route, /restorable: reason === null,\s*unrestorable_reason: reason,/);
  });

  it("Settings words each refusal and offers no Restore button for it", () => {
    const src = read("teller", "views", "settings.ejs");
    const start = src.indexOf("function deletedRowHtml(d)");
    const fnSrc = src.slice(start, src.indexOf("function renderDeletedTransactions()"));
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const ctx = { esc, fmt: (n) => "$" + n, fmtDate: (d) => d, isFinite, Number, String, Date };
    vm.runInNewContext(fnSrc + "\nthis.deletedRowHtml = deletedRowHtml;", ctx);
    const base = { transaction_id: "t1", deleted_at: "2026-10-20T12:00:00Z", legacy: false, date: "2026-10-01", merchant: "Cafe", amount: 5 };
    const removed = ctx.deletedRowHtml({ ...base, restorable: false, unrestorable_reason: "removed_by_bank" });
    assert.match(removed, /Your bank has since removed this transaction — it can't be restored\./);
    assert.doesNotMatch(removed, /data-restore-deleted/);
    assert.match(ctx.deletedRowHtml({ ...base, restorable: false, unrestorable_reason: "account_gone" }),
      /Its account is no longer connected — it can't be restored\./);
    assert.match(ctx.deletedRowHtml({ ...base, legacy: true, restorable: false, unrestorable_reason: "never" }),
      /A manual entry deleted before undelete existed/);
    assert.match(ctx.deletedRowHtml({ ...base, restorable: true, unrestorable_reason: null }), /data-restore-deleted="t1"/);
  });
});
