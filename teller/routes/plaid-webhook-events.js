// ============================================================================
// Plaid webhook event handlers (roadmap T2.1, W3)
// ============================================================================
// routes/webhooks.js calls the handler after a Plaid event has been verified
// and recorded, detached from the request. Webhooks are a TRIGGER, not data:
// the handler re-fetches through the existing sync code (one ingestion path —
// INV-01 / INV-04 / INV-111) and never reads transactions from the payload.
//
//   TRANSACTIONS / SYNC_UPDATES_AVAILABLE — the item has new transaction data:
//     sync that one item now (investments.syncPlaidItem — under the Plaid lock,
//     coalesced per item), then the shared post-sync steps over what it added
//     (rename rules + one anomaly check — enrollments.runPostSyncSteps,
//     INV-67). It records nothing globally: the item's own last_synced_at
//     moves, last_txn_sync_at and last_sync_result stay the scheduled syncs'.
//   anything else — 'ignored' (item events come with W4).
//
// Outcome: { status: 'done' } after a sync, { status: 'ignored' } when there is
// nothing to do (an unknown or non-GOOD item — a CSV item, one unlinked since),
// a throw when the item's sync failed (the router marks the row 'failed').
// ============================================================================
const { pool } = require("../services/database");

function createPlaidEventHandler({
  db = pool,
  syncItem = (id) => require("./investments").syncPlaidItem(id),
  postSync = (added) => require("./enrollments").runPostSyncSteps(added),
} = {}) {
  async function syncUpdatesAvailable(event) {
    if (!event.subject) return { status: "ignored" };
    const r = await db.query(
      "SELECT id FROM plaid_items WHERE item_id = $1 AND status = 'GOOD'",
      [event.subject]
    );
    if (!r.rows.length) return { status: "ignored" };
    const result = await syncItem(r.rows[0].id);
    // Not configured / the item went away while queued — nothing to sync.
    if (!result || !result.ok) return { status: "ignored" };
    // Rows a partly failed run did add still get named + checked.
    await postSync(result.added || 0);
    if (result.failed) throw new Error("Plaid item sync failed");
    return { status: "done" };
  }

  return async function handlePlaidEvent(event) {
    if (event && event.type === "TRANSACTIONS" && event.code === "SYNC_UPDATES_AVAILABLE") {
      return syncUpdatesAvailable(event);
    }
    return { status: "ignored" };
  };
}

module.exports = { createPlaidEventHandler, handlePlaidEvent: createPlaidEventHandler() };
