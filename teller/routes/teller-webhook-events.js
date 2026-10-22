// ============================================================================
// Teller webhook event handlers (roadmap T2.1, W5)
// ============================================================================
// routes/webhooks.js calls the handler after a Teller event has been verified
// and recorded, detached from the request. A webhook is a TRIGGER, not data:
// the handler re-fetches through the existing Teller sync (one ingestion path
// — INV-01 / INV-02 / INV-111) and never reads the payload's transactions,
// only which enrollment they belong to.
//
//   transactions.processed — the enrollment(s) the event names (payload
//     enrollment_id, else the enrollments owning the transactions' account
//     ids) are synced now, incrementally (enrollments.syncTellerEnrollment —
//     coalesced per enrollment), then the shared post-sync steps over what they
//     added (rename rules + one anomaly check — runPostSyncSteps, INV-67).
//     Nothing global is recorded: each enrollment's last_synced_at moves.
//   enrollment.disconnected — a GOOD enrollment becomes DISCONNECTED (Sync
//     Health's disconnected-link issue) and ONE notification says to connect it
//     again; one already DISCONNECTED (or SUSPENDED) is left alone, silently.
//     The next sync that authenticates still restores GOOD (BSI-9).
//   webhook.test — 'done' (Teller's end-to-end check of the endpoint).
//   anything else — 'ignored'.
// A SUSPENDED enrollment is never synced (as in syncAllEnrollments).
// ============================================================================
const { pool } = require("../services/database");

// Teller's disconnect reasons, in words (an unknown one adds nothing).
function reasonText(reason) {
  const r = String(reason || "");
  if (/credentials_invalid/.test(r)) return "the bank login changed";
  if (/account_locked/.test(r)) return "the bank account is locked";
  if (/user_action|mfa_required|captcha|web_login/.test(r)) return "the bank needs you to sign in again";
  if (/enrollment_inactive/.test(r)) return "the connection was inactive too long";
  return null;
}

function createTellerEventHandler({
  db = pool,
  syncEnrollment = (id) => require("./enrollments").syncTellerEnrollment(id),
  postSync = (added) => require("./enrollments").runPostSyncSteps(added),
  notify = (n) => require("./notifications").sendToAll(n),
} = {}) {
  async function enrollmentsFor(event) {
    if (event.subject) {
      const r = await db.query(
        "SELECT id, institution_name, status FROM teller_enrollments WHERE enrollment_id = $1 AND status <> 'SUSPENDED'",
        [event.subject]
      );
      return r.rows;
    }
    const ids = Array.isArray(event.account_ids) ? event.account_ids : [];
    if (!ids.length) return [];
    const r = await db.query(
      `SELECT DISTINCT te.id, te.institution_name, te.status
         FROM linked_accounts la
         JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
        WHERE la.account_id = ANY($1::text[]) AND te.status <> 'SUSPENDED'
        ORDER BY te.id`,
      [ids]
    );
    return r.rows;
  }

  async function transactionsProcessed(event) {
    const rows = await enrollmentsFor(event);
    if (!rows.length) return { status: "ignored" };
    let added = 0;
    let failed = false;
    let synced = 0;
    for (const row of rows) {
      const r = await syncEnrollment(row.id);
      if (!r || !r.ok) continue; // removed / suspended while queued
      synced++;
      added += r.added || 0;
      if (r.failed) failed = true;
    }
    if (!synced) return { status: "ignored" };
    // Rows a partly failed run did add still get named + checked.
    await postSync(added);
    if (failed) throw new Error("Teller enrollment sync failed");
    return { status: "done" };
  }

  async function enrollmentDisconnected(event) {
    if (!event.subject) return { status: "ignored" };
    const r = await db.query(
      "SELECT id, institution_name, status FROM teller_enrollments WHERE enrollment_id = $1",
      [event.subject]
    );
    const row = r.rows[0];
    if (!row) return { status: "ignored" };
    if (row.status !== "GOOD") return { status: "done" };
    const upd = await db.query(
      "UPDATE teller_enrollments SET status = 'DISCONNECTED', updated_at = now() WHERE id = $1 AND status = 'GOOD' RETURNING id",
      [row.id]
    );
    if (!upd.rows.length) return { status: "done" };
    const why = reasonText(event.reason);
    try {
      await notify({
        title: "Bank connection disconnected",
        body: `${row.institution_name || "A Teller connection"} was disconnected at Teller${why ? " — " + why : ""}. Open Accounts and connect it again with Teller Connect.`,
        tag: `teller-disconnected-${row.id}`,
        data: { url: "/accounts" },
      });
    } catch (e) { console.error("teller disconnect notification failed:", e.message); }
    return { status: "done" };
  }

  return async function handleTellerEvent(event) {
    const type = event && event.type;
    if (type === "transactions.processed") return transactionsProcessed(event);
    if (type === "enrollment.disconnected") return enrollmentDisconnected(event);
    if (type === "webhook.test") return { status: "done" };
    return { status: "ignored" };
  };
}

module.exports = { createTellerEventHandler, handleTellerEvent: createTellerEventHandler(), reasonText };
