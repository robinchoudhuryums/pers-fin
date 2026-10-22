// ============================================================================
// Plaid webhook event handlers (roadmap T2.1, W3–W4)
// ============================================================================
// routes/webhooks.js calls the handler after a Plaid event has been verified
// and recorded, detached from the request. Webhooks are a TRIGGER, not data:
// the handler re-fetches through the existing sync code (one ingestion path —
// INV-01 / INV-04 / INV-111) and never reads transactions from the payload.
// The event's Plaid item_id is looked up in plaid_items (GOOD only — a CSV
// item has no Plaid side) and in the investments-only registry.
//
//   TRANSACTIONS / SYNC_UPDATES_AVAILABLE (W3) — sync that one item now
//     (investments.syncPlaidItem — under the Plaid lock, coalesced per item),
//     then the shared post-sync steps over what it added (rename rules + one
//     anomaly check — enrollments.runPostSyncSteps, INV-67). It records nothing
//     globally: the item's own last_synced_at moves.
//   ITEM (W4) — the item's re-auth signal (plaid_items.last_error_code, the
//     Accounts page's Re-authenticate button + one notification on a new
//     code): ERROR with a re-auth error code, PENDING_EXPIRATION,
//     PENDING_DISCONNECT and USER_PERMISSION_REVOKED set it; LOGIN_REPAIRED
//     clears it. NEW_ACCOUNTS_AVAILABLE sends one "Add accounts" notification
//     (≤1 per item per day). An ERROR that isn't a re-auth code (an institution
//     outage) and every other ITEM code are 'ignored'. Investments-only Items
//     have no last_error_code, so their re-auth events are 'ignored'.
//   HOLDINGS / DEFAULT_UPDATE (W4) — that Item's holdings sync
//     (syncAllPlaidHoldings({ itemId })).
//   INVESTMENTS_TRANSACTIONS / DEFAULT_UPDATE | HISTORICAL_UPDATE (W4) — that
//     Item's investment cash-flow sync (syncAllPlaidInvestmentFlows({ itemId })).
//   anything else — 'ignored'.
//
// Outcome: { status: 'done' } after it acted, { status: 'ignored' } when there
// is nothing to do (an unknown item, an event it doesn't act on), a throw when
// a sync failed (the router marks the row 'failed').
// ============================================================================
const { pool } = require("../services/database");

const inv = () => require("./investments"); // lazy: the sync code loads on first use
const notifications = () => require("./notifications");

// ITEM codes that set the re-auth signal to themselves.
const ITEM_SIGNAL_CODES = new Set(["PENDING_EXPIRATION", "PENDING_DISCONNECT", "USER_PERMISSION_REVOKED"]);
const FLOW_CODES = new Set(["DEFAULT_UPDATE", "HISTORICAL_UPDATE"]);

function createPlaidEventHandler({
  db = pool,
  syncItem = (id) => inv().syncPlaidItem(id),
  postSync = (added) => require("./enrollments").runPostSyncSteps(added),
  setErrorCode = (id, code) => inv().setPlaidItemErrorCode(id, code),
  isReauthCode = (code) => inv().isReauthErrorCode(code),
  syncHoldings = (itemId) => inv().syncAllPlaidHoldings({ itemId }),
  syncFlows = (itemId) => inv().syncAllPlaidInvestmentFlows({ itemId }),
  notify = (n) => notifications().sendToAll(n),
  sentRecently = (tag, hours) => notifications().sentRecently(tag, hours),
} = {}) {
  // { txn: GOOD plaid_items row | null, inv: plaid_investment_items row | null }
  async function findItem(itemId) {
    const r = await db.query(
      `SELECT 'txn' AS kind, id, institution_name FROM plaid_items WHERE item_id = $1 AND status = 'GOOD'
       UNION ALL
       SELECT 'inv' AS kind, id, institution_name FROM plaid_investment_items WHERE item_id = $1`,
      [itemId]
    );
    return {
      txn: r.rows.find((x) => x.kind === "txn") || null,
      inv: r.rows.find((x) => x.kind === "inv") || null,
    };
  }

  async function syncUpdatesAvailable(item) {
    if (!item.txn) return { status: "ignored" };
    const result = await syncItem(item.txn.id);
    // Not configured / the item went away while queued — nothing to sync.
    if (!result || !result.ok) return { status: "ignored" };
    // Rows a partly failed run did add still get named + checked.
    await postSync(result.added || 0);
    if (result.failed) throw new Error("Plaid item sync failed");
    return { status: "done" };
  }

  async function itemEvent(event, item) {
    const code = event.code;
    if (code === "NEW_ACCOUNTS_AVAILABLE") {
      const row = item.txn || item.inv;
      if (!row) return { status: "ignored" };
      const tag = `plaid-new-accounts-${row.kind}-${row.id}`;
      if (await sentRecently(tag, 24)) return { status: "done" };
      await notify({
        title: "New bank account available",
        body: `${row.institution_name || "A Plaid connection"} has an account you haven't added. Open Accounts → Add accounts.`,
        tag,
        data: { url: "/accounts" },
      });
      return { status: "done" };
    }
    if (!item.txn) return { status: "ignored" };
    if (code === "LOGIN_REPAIRED") {
      await setErrorCode(item.txn.id, null);
      return { status: "done" };
    }
    let signal = null;
    if (code === "ERROR" && isReauthCode(event.error_code)) signal = event.error_code;
    else if (ITEM_SIGNAL_CODES.has(code)) signal = code;
    if (!signal) return { status: "ignored" };
    await setErrorCode(item.txn.id, signal);
    return { status: "done" };
  }

  async function investmentSync(fn, itemId, what) {
    const r = await fn(itemId);
    if (!r || !r.ok || (r.errors && r.errors.length)) throw new Error(`Plaid ${what} sync failed`);
    return { status: "done" };
  }

  return async function handlePlaidEvent(event) {
    const type = event && event.type;
    const code = event && event.code;
    const known =
      (type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE") ||
      type === "ITEM" ||
      (type === "HOLDINGS" && code === "DEFAULT_UPDATE") ||
      (type === "INVESTMENTS_TRANSACTIONS" && FLOW_CODES.has(code));
    if (!known || !event.subject) return { status: "ignored" };

    const item = await findItem(event.subject);
    if (type === "TRANSACTIONS") return syncUpdatesAvailable(item);
    if (type === "ITEM") return itemEvent(event, item);
    if (!item.txn && !item.inv) return { status: "ignored" };
    if (type === "HOLDINGS") return investmentSync(syncHoldings, event.subject, "holdings");
    return investmentSync(syncFlows, event.subject, "investment transactions");
  };
}

module.exports = { createPlaidEventHandler, handlePlaidEvent: createPlaidEventHandler() };
