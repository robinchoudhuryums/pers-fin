#!/usr/bin/env node
// ============================================================================
// Fresh-start reset — wipe financial data + config, KEEP bank connections
// ============================================================================
// Clears all historical data and user config so the app starts clean, while
// PRESERVING the encrypted Teller/Plaid connections (and device auth) so you
// don't have to re-link banks or re-register biometrics. Sync watermarks are
// reset so the next sync re-pulls full, clean transaction history.
//
//   KEPT:  teller_enrollments, plaid_items, plaid_investment_items,
//          linked_accounts, sync_cursors (cursors reset to ''),
//          webauthn_credentials, push_subscriptions, schema_migrations
//   WIPED: transactions, transaction_splits, detected_subscriptions,
//          recurring_transfers, investment_accounts, investment_holdings,
//          financial_goals, net_worth_snapshots, tax_deductions, csv_imports,
//          budgets, budget_snapshots, categorization_rules, manual_bills,
//          bill_payments, notification_log, ai_audit_log, financial_insights,
//          account_balance_snapshots, watchlist_items, credit_scores
//   RESET: user_settings → single default row (clears zip, partner_name,
//          AI running summary, all watermarks, integration config, etc.)
//
// Usage:
//   node scripts/reset-fresh.js              # DRY RUN — prints row counts, no changes
//   node scripts/reset-fresh.js --yes        # actually perform the reset
//   CONFIRM_RESET=YES node scripts/reset-fresh.js   # same as --yes
//
// After running: trigger a sync (Settings → Sync Balances, then a transaction
// sync / Reconcile) to re-pull clean transactions; categorization, subscription
// detection, and AI insights repopulate from there.
// ============================================================================

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const { Pool } = require("pg");

if (!process.env.NEON_DATABASE_URL) {
  console.error("FATAL: NEON_DATABASE_URL is not set.");
  process.exit(1);
}

const CONFIRMED = process.argv.includes("--yes") || process.env.CONFIRM_RESET === "YES";

// Tables wiped completely. Order doesn't matter — a single TRUNCATE ... CASCADE
// handles inter-table FKs. transaction_splits / tax_deductions / ai_audit_log /
// budget_snapshots would cascade anyway, but they're listed explicitly so the
// dry-run row counts are complete.
const WIPE_TABLES = [
  "transactions", "transaction_splits", "detected_subscriptions", "recurring_transfers",
  "investment_accounts", "investment_holdings",
  "financial_goals", "net_worth_snapshots", "tax_deductions", "csv_imports",
  "budgets", "budget_snapshots", "categorization_rules", "manual_bills", "bill_payments",
  "notification_log", "ai_audit_log", "financial_insights",
  "account_balance_snapshots", "watchlist_items", "credit_scores",
];

// Preserved so the dry-run can show what's kept.
const KEEP_TABLES = [
  "teller_enrollments", "plaid_items", "plaid_investment_items",
  "linked_accounts", "sync_cursors", "webauthn_credentials",
  "push_subscriptions", "user_settings",
];

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 2,
  connectionTimeoutMillis: 10000,
});

async function count(client, table) {
  try {
    const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    return r.rows[0].n;
  } catch {
    return null; // table may not exist on an older schema
  }
}

async function main() {
  const client = await pool.connect();
  try {
    console.log("\n=== Fresh-start reset ===\n");

    console.log("KEEP (bank connections + device auth, preserved):");
    for (const t of KEEP_TABLES) {
      const n = await count(client, t);
      if (n !== null) console.log(`  • ${t.padEnd(26)} ${n} row(s)`);
    }

    console.log("\nWIPE (historical data + config, cleared):");
    let totalWipe = 0;
    for (const t of WIPE_TABLES) {
      const n = await count(client, t);
      if (n !== null) { console.log(`  • ${t.padEnd(26)} ${n} row(s)`); totalWipe += n; }
    }
    console.log(`\n  Total rows to clear: ${totalWipe}`);

    if (!CONFIRMED) {
      console.log("\nDRY RUN — no changes made. Re-run with --yes to perform the reset.\n");
      return;
    }

    console.log("\nPerforming reset...");
    await client.query("BEGIN");

    // Wipe data + config in one shot. CASCADE catches any dependent rows; no
    // KEPT table references a WIPED one, so nothing preserved is touched.
    const existing = [];
    for (const t of WIPE_TABLES) {
      if ((await count(client, t)) !== null) existing.push(t);
    }
    await client.query(`TRUNCATE TABLE ${existing.join(", ")} RESTART IDENTITY CASCADE`);

    // Reset sync watermarks so the next sync re-pulls FULL clean history
    // instead of resuming from where it left off.
    await client.query("UPDATE sync_cursors SET cursor = '', last_synced_at = NULL");
    await client.query("UPDATE teller_enrollments SET last_synced_txn_date = NULL");

    // Reset user_settings to a single default row (clears zip / partner_name /
    // AI running summary / all watermarks / integration config / widget prefs).
    await client.query("DELETE FROM user_settings");
    await client.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");

    await client.query("COMMIT");
    console.log("Reset complete.\n");
    console.log("Next steps:");
    console.log("  1. Settings → Sync Balances (refreshes balances, credit limits, APR, investments).");
    console.log("  2. Trigger a transaction sync or POST /api/sync/reconcile to re-pull clean history.");
    console.log("  3. Re-run categorization; subscription/transfer detection and AI insights repopulate.\n");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Reset FAILED (rolled back):", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
