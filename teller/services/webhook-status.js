// ============================================================================
// Bank webhook status (roadmap T2.1, W6)
// ============================================================================
// What Sync Health and the operator checks show about the Plaid and Teller
// webhooks, read from webhook_events (never a body — only provider, type,
// status, times) and the per-connection registration columns:
//
//   getWebhookStatus(pool, { env, now }) → {
//     plaid:  { configured, opted_in, base_url, items_total, items_registered,
//               last_event_at, last_status, events_24h, failed_24h },
//     teller: { configured, enrollments_total,
//               last_event_at, last_status, events_24h, failed_24h },
//     error: true when a query failed (the fields it fed are null / 0) }
//
//   - Plaid is "configured" when a Plaid client exists (credentials set) and
//     "opted_in" when PUBLIC_URL is set (hosting.webhookBaseUrl — W4). An Item
//     counts as registered when its webhook_url starts with that base and ends
//     with /api/webhooks/plaid (the /perfin mount may sit between them).
//   - Teller is "configured" when TELLER_WEBHOOK_SECRET is set.
//
//   webhookChecks(status, { now }) → operator checks (services/operator-checks):
//     webhooks:plaid  — omitted without Plaid or connections; info while
//                       PUBLIC_URL isn't set; WARN when a connection isn't
//                       registered at the current address; info when no Plaid
//                       webhook arrived in 7 days; else ok.
//     webhooks:teller — omitted without Teller enrollments; info while the
//                       secret isn't set; info when no Teller webhook arrived
//                       in 7 days; else ok.
// ============================================================================
const hosting = require("./hosting");
const { tellerSecrets } = require("./webhook-verify");

const QUIET_DAYS = 7;
const PLAID_PATH = "/api/webhooks/plaid";

function plaidConfigured() {
  try { return !!require("./plaid-client").getPlaidClient(); }
  catch (e) { console.error("webhook status: Plaid client check failed:", e.message); return false; }
}

async function getWebhookStatus(pool, { env = process.env } = {}) {
  const base = hosting.webhookBaseUrl(env);
  const empty = () => ({ last_event_at: null, last_status: null, events_24h: 0, failed_24h: 0 });
  const out = {
    plaid: { configured: plaidConfigured(), opted_in: !!base, base_url: base, items_total: 0, items_registered: 0, ...empty() },
    teller: { configured: tellerSecrets(env).length > 0, enrollments_total: 0, ...empty() },
  };

  try {
    const r = await pool.query(
      `SELECT provider,
              max(received_at) AS last_event_at,
              (array_agg(status ORDER BY received_at DESC))[1] AS last_status,
              count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS events_24h,
              count(*) FILTER (WHERE status = 'failed' AND received_at > now() - interval '24 hours')::int AS failed_24h
         FROM webhook_events
        GROUP BY provider`
    );
    for (const row of r.rows) {
      const p = out[row.provider];
      if (!p) continue;
      p.last_event_at = row.last_event_at;
      p.last_status = row.last_status;
      p.events_24h = row.events_24h || 0;
      p.failed_24h = row.failed_24h || 0;
    }
  } catch (e) {
    console.error("webhook status: event read failed:", e.message);
    out.error = true;
  }

  try {
    // Every Plaid connection that can receive webhooks: GOOD transaction items
    // plus investments-only Items (a combined Item's registry row is the same
    // Item — counted once).
    const r = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE $1::text <> '' AND webhook_url IS NOT NULL
                                 AND left(webhook_url, length($1::text)) = $1::text
                                 AND right(webhook_url, ${PLAID_PATH.length}) = '${PLAID_PATH}')::int AS registered
         FROM (SELECT item_id, webhook_url FROM plaid_items WHERE status = 'GOOD'
               UNION ALL
               SELECT pii.item_id, pii.webhook_url FROM plaid_investment_items pii
                WHERE NOT EXISTS (SELECT 1 FROM plaid_items pi WHERE pi.item_id = pii.item_id)) u`,
      [base || ""]
    );
    out.plaid.items_total = r.rows[0] ? r.rows[0].total : 0;
    out.plaid.items_registered = r.rows[0] ? r.rows[0].registered : 0;
  } catch (e) {
    console.error("webhook status: Plaid registration read failed:", e.message);
    out.error = true;
  }

  try {
    const r = await pool.query("SELECT count(*)::int AS n FROM teller_enrollments WHERE status <> 'SUSPENDED'");
    out.teller.enrollments_total = r.rows[0] ? r.rows[0].n : 0;
  } catch (e) {
    console.error("webhook status: Teller enrollment read failed:", e.message);
    out.error = true;
  }
  return out;
}

function quiet(lastAt, now) {
  return !lastAt || now - new Date(lastAt).getTime() > QUIET_DAYS * 86400000;
}

function webhookChecks(status, { now = Date.now() } = {}) {
  const checks = [];
  if (!status) return checks;
  const p = status.plaid;
  if (p && p.configured && p.items_total > 0) {
    const id = "webhooks:plaid";
    const label = "Plaid webhooks";
    if (!p.opted_in) {
      checks.push({ id, label, status: "info",
        detail: "Plaid webhooks are off, so Plaid connections update with the scheduled syncs only.",
        fix: "Set PUBLIC_URL to this app's public https address, then Settings → Sync Health → Register Plaid webhooks." });
    } else if (p.items_registered < p.items_total) {
      const n = p.items_total - p.items_registered;
      checks.push({ id, label, status: "warn",
        detail: `${n} of ${p.items_total} Plaid connection(s) aren't registered at ${p.base_url}, so Plaid can't tell the app about their new data.`,
        fix: "Settings → Sync Health → Register Plaid webhooks." });
    } else if (quiet(p.last_event_at, now)) {
      checks.push({ id, label, status: "info",
        detail: `No Plaid webhook has arrived in ${QUIET_DAYS} days — the scheduled syncs still run.`,
        fix: "Check that PUBLIC_URL reaches this app from the internet; Register Plaid webhooks again after an address change." });
    } else {
      checks.push({ id, label, status: "ok", detail: `All ${p.items_total} Plaid connection(s) registered; last webhook ${new Date(p.last_event_at).toISOString()}.`, fix: null });
    }
  }
  const t = status.teller;
  if (t && t.enrollments_total > 0) {
    const id = "webhooks:teller";
    const label = "Teller webhooks";
    if (!t.configured) {
      checks.push({ id, label, status: "info",
        detail: "Teller webhooks are off, so Teller connections update with the scheduled syncs only.",
        fix: "Add <public address>/perfin/api/webhooks/teller in the Teller dashboard and set TELLER_WEBHOOK_SECRET to its signing secret." });
    } else if (quiet(t.last_event_at, now)) {
      checks.push({ id, label, status: "info",
        detail: `No Teller webhook has arrived in ${QUIET_DAYS} days — the scheduled syncs still run.`,
        fix: "Check the webhook URL in the Teller dashboard and that TELLER_WEBHOOK_SECRET matches its signing secret (send Teller's test event)." });
    } else {
      checks.push({ id, label, status: "ok", detail: `Last Teller webhook ${new Date(t.last_event_at).toISOString()}.`, fix: null });
    }
  }
  return checks;
}

module.exports = { getWebhookStatus, webhookChecks, QUIET_DAYS };
