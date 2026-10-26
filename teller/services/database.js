// ============================================================================
// Database — Pool setup and auto-migrations
// ============================================================================

const { Pool } = require("pg");

if (!process.env.NEON_DATABASE_URL) {
  console.error("FATAL: NEON_DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  // PGSSLMODE=disable opts out for the CI migration test's plaintext service
  // container (an explicit ssl object would otherwise override the env var).
  // Production (Neon) never sets it, so TLS verification stays on.
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: true },
  // Single-user app — 3 connections is sufficient. Each idle connection
  // holds a Postgres backend process on Neon, consuming compute hours
  // even when not running queries. The previous max of 5 was oversized.
  // Tip: switch NEON_DATABASE_URL to the "-pooler" endpoint (Neon
  // dashboard → Connection Details → Pooled) for pgbouncer-level
  // connection multiplexing and faster cold starts.
  max: 3,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 10000,
});

// Log pool errors to prevent unhandled rejections
pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err.message);
});

const ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE;
if (!ENCRYPTION_PASSPHRASE) {
  // Fail fast (same posture as the NEON_DATABASE_URL check above): without the
  // passphrase every pgp_sym_encrypt/decrypt of Teller/Plaid tokens and the
  // Per-sistant webhook secret breaks at request time, which previously
  // surfaced only as scattered decryption_failed errors long after boot.
  // ALLOW_MISSING_TOKEN_PASSPHRASE=true is the explicit local-debug escape
  // hatch for booting without any bank links.
  if (process.env.ALLOW_MISSING_TOKEN_PASSPHRASE === "true") {
    console.warn("WARNING: TOKEN_ENCRYPTION_PASSPHRASE is not set (ALLOW_MISSING_TOKEN_PASSPHRASE override active). Token encryption will fail.");
  } else {
    console.error("FATAL: TOKEN_ENCRYPTION_PASSPHRASE environment variable is not set. " +
      "Token encryption/decryption cannot work without it. " +
      "Set it, or set ALLOW_MISSING_TOKEN_PASSPHRASE=true to boot anyway for local debugging.");
    process.exit(1);
  }
}

// Current schema version — increment when adding new migration steps.
// Bumped to 3 (PSA1) so the detection-key orphan cleanup below runs ONCE
// (gated on `currentVersion < 3`) instead of on every boot.
const SCHEMA_VERSION = 3;

// Migration locking (cycle-7 F10). Each boot re-runs ~100 idempotent ALTER
// TABLE statements in one transaction, and ALTER TABLE takes an ACCESS
// EXCLUSIVE lock even when the column already exists. Two things bound that:
//   - an advisory lock (MIGRATION_LOCK_KEY), so a second instance booting
//     during a deploy overlap waits for the first instead of interleaving;
//   - lock_timeout, so a migration stuck behind a long query on the old
//     instance gives up in seconds — while it waits, every new query on that
//     table queues behind its lock request and the live app freezes.
// A lock timeout (SQLSTATE 55P03) rolls back and is retried with backoff;
// any other failure, or running out of attempts, is still fatal (INV-17).
const MIGRATION_LOCK_KEY = 727274001; // Per-sistant uses 727274002
const MIGRATION_LOCK_TIMEOUT = "5s";
const MIGRATION_ATTEMPTS = 5;

async function runMigrations({ attempts = MIGRATION_ATTEMPTS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runMigrationsOnce();
    } catch (err) {
      if (err && err.code === "55P03" && attempt < attempts) {
        console.warn(`Migration lock timeout (attempt ${attempt}/${attempts}) — retrying: ${err.message}`);
        await sleep(2000 * attempt);
        continue;
      }
      console.error("FATAL: Migration failed:", err.message);
      throw err;
    }
  }
}

async function runMigrationsOnce() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Advisory lock FIRST, with no timeout: a second instance waits for the
    // first runner (whose own statements are bounded by lock_timeout below).
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    // Cycle-7 F17: pgp_sym_decrypt RAISES on a wrong key (it doesn't return
    // NULL), so one row encrypted under an old TOKEN_ENCRYPTION_PASSPHRASE
    // failed the whole items query — every Teller/Plaid sync, the balance sync
    // and the reconcile — and the per-row `decryption_failed` branches were
    // dead code. Every token read goes through this wrapper: a row that won't
    // decrypt is NULL, which those branches report and skip.
    await client.query(`CREATE OR REPLACE FUNCTION perfin_try_decrypt(data bytea, key text)
      RETURNS text LANGUAGE plpgsql STABLE AS $fn$
      BEGIN
        RETURN pgp_sym_decrypt(data, key);
      EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
      END
      $fn$`);

    // Schema versioning — track which migration version has been applied
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const versionResult = await client.query("SELECT MAX(version) AS v FROM schema_migrations");
    const currentVersion = versionResult.rows[0]?.v || 0;

    // ------------------------------------------------------------------
    // Base tables (001_schema.sql + 002_csv_import.sql + 003_teller.sql)
    // These must exist before the ALTER TABLEs below can run on a fresh DB.
    // ------------------------------------------------------------------
    await client.query(`CREATE TABLE IF NOT EXISTS plaid_items (
      id               SERIAL PRIMARY KEY,
      item_id          TEXT UNIQUE NOT NULL,
      institution_id   TEXT,
      institution_name TEXT NOT NULL,
      access_token_enc BYTEA NOT NULL,
      status           TEXT NOT NULL DEFAULT 'GOOD',
      consent_expires_at TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS teller_enrollments (
      id                   SERIAL PRIMARY KEY,
      enrollment_id        TEXT UNIQUE NOT NULL,
      institution_name     TEXT NOT NULL,
      access_token_enc     BYTEA NOT NULL,
      status               TEXT NOT NULL DEFAULT 'GOOD',
      last_synced_txn_date DATE,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS linked_accounts (
      id                   SERIAL PRIMARY KEY,
      plaid_item_id        INT REFERENCES plaid_items(id) ON DELETE CASCADE,
      teller_enrollment_id INT REFERENCES teller_enrollments(id) ON DELETE CASCADE,
      account_id           TEXT UNIQUE NOT NULL,
      name                 TEXT NOT NULL,
      official_name        TEXT,
      type                 TEXT,
      subtype              TEXT,
      mask                 TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS sync_cursors (
      plaid_item_id  INT PRIMARY KEY REFERENCES plaid_items(id) ON DELETE CASCADE,
      cursor         TEXT NOT NULL DEFAULT '',
      last_synced_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS transactions (
      id                        SERIAL PRIMARY KEY,
      account_id                TEXT NOT NULL REFERENCES linked_accounts(account_id),
      transaction_id            TEXT UNIQUE NOT NULL,
      amount                    NUMERIC(12,2) NOT NULL,
      iso_currency_code         TEXT DEFAULT 'USD',
      date                      DATE NOT NULL,
      authorized_date           DATE,
      merchant_name             TEXT,
      name                      TEXT,
      category                  TEXT[],
      personal_finance_category JSONB,
      pending                   BOOLEAN NOT NULL DEFAULT false,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions (account_id, date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_txn_merchant ON transactions (merchant_name) WHERE merchant_name IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions (date)`);
    // Cycle-7 F54: when the categorize AI last saw this row and left it
    // unanswered — it isn't re-sent for 30 days.
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_skipped_at TIMESTAMPTZ");
    // Cycle-7 F20: transactions the user deleted. The Teller and Plaid upserts
    // skip these ids so a re-fetch (lookback, reconcile) can't resurrect them.
    await client.query(`CREATE TABLE IF NOT EXISTS deleted_transactions (
      transaction_id TEXT PRIMARY KEY,
      deleted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Roadmap T2.5 U1: the deleted row (and its splits) as it was —
    // { row, splits } — so Restore can put it back, and the connection it came
    // from (teller / plaid / csv / manual). NULL on a tombstone written before.
    await client.query("ALTER TABLE deleted_transactions ADD COLUMN IF NOT EXISTS snapshot JSONB");
    await client.query("ALTER TABLE deleted_transactions ADD COLUMN IF NOT EXISTS source TEXT");
    await client.query(`CREATE TABLE IF NOT EXISTS detected_subscriptions (
      id             SERIAL PRIMARY KEY,
      merchant_key   TEXT NOT NULL,
      display_name   TEXT NOT NULL,
      amount         NUMERIC(12,2) NOT NULL,
      prior_amount   NUMERIC(12,2),
      cadence_days   INT NOT NULL,
      first_seen     DATE NOT NULL,
      last_charged   DATE NOT NULL,
      next_expected  DATE NOT NULL,
      is_active      BOOLEAN NOT NULL DEFAULT true,
      is_new         BOOLEAN NOT NULL DEFAULT true,
      amount_changed BOOLEAN NOT NULL DEFAULT false,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (merchant_key, cadence_days)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS csv_imports (
      id            SERIAL PRIMARY KEY,
      filename      TEXT NOT NULL,
      institution   TEXT NOT NULL,
      account_label TEXT,
      rows_imported INT NOT NULL DEFAULT 0,
      rows_skipped  INT NOT NULL DEFAULT 0,
      imported_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Allow Plaid linkage to be optional (Teller and CSV accounts don't have one)
    await client.query(`ALTER TABLE linked_accounts ALTER COLUMN plaid_item_id DROP NOT NULL`);

    // 005_settings.sql
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id                      INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        session_timeout_minutes INT NOT NULL DEFAULT 15,
        theme                   TEXT NOT NULL DEFAULT 'dark',
        dashboard_months        INT NOT NULL DEFAULT 6,
        insights_enabled        BOOLEAN NOT NULL DEFAULT false,
        insights_last_run       TIMESTAMPTZ,
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    await client.query("CREATE TABLE IF NOT EXISTS financial_insights (id SERIAL PRIMARY KEY, insight_text TEXT NOT NULL, period_start DATE, period_end DATE, model_used TEXT, tokens_used INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    // 006_insights_memory.sql
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_running_summary TEXT DEFAULT NULL");
    // Structured running summary (S5): replaces the plain-text running summary
    // with categorized JSON {trends, completed_goals, pending_actions, alerts}.
    // Both columns coexist — the JSON is the source of truth going forward;
    // the TEXT column gets a human-readable rendering for backward-compat and
    // for any consumer that hasn't been updated yet.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_running_summary_json JSONB DEFAULT NULL");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_model TEXT NOT NULL DEFAULT 'sonnet'");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_cadence_days INT NOT NULL DEFAULT 30");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS zip_code TEXT DEFAULT NULL");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insight_modules JSONB NOT NULL DEFAULT '{\"utility_comparison\":true,\"spending_benchmarks\":true,\"savings_suggestions\":true,\"subscription_audit\":true,\"anomaly_detection\":true,\"seasonal_forecast\":true,\"debt_optimizer\":true,\"bill_negotiation\":true,\"income_savings\":true,\"tax_deductions\":true,\"goal_tracking\":true,\"recurring_transfers\":true}'::jsonb");
    // 003_dashboard_features.sql
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS is_dismissed BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'detected'");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS cancel_confirmed BOOLEAN NOT NULL DEFAULT false");
    // Subscription watchdog (cycle-7 F53 / G5): the latest post-cancellation
    // charge already alerted (one alert per charge) and the price last alerted
    // (one alert per new price).
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS still_charging_txn TEXT");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS still_charging_at DATE");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS still_charging_amount NUMERIC(12,2)");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS price_alerted_amount NUMERIC(12,2)");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS notes TEXT");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'subscription'");
    // 004_balances.sql
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS available_balance NUMERIC(12,2)");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS current_balance NUMERIC(12,2)");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS balance_currency TEXT DEFAULT 'USD'");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS balance_updated_at TIMESTAMPTZ");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS apr NUMERIC(5,2)");
    // Manual monthly payment for loan accounts (auto loans etc.). Plaid's
    // Liabilities product covers only credit/student/mortgage — auto-loan APR
    // and payment are never reported, so both are operator-entered fields
    // (same pattern as the manual Discover credit limit). Drives the
    // dashboard's loan payoff projection (computeLoanPayoff).
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS monthly_payment NUMERIC(12,2)");
    // Roadmap T2.2 L4: a per-account current-balance floor for the cash alerts
    // (services/cash-alerts.js) — NULL = none; depository, non-investment only.
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS low_balance_floor NUMERIC(12,2)");
    // keep-alive settings
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_start INT NOT NULL DEFAULT 6");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_end INT NOT NULL DEFAULT 0");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_timezone TEXT NOT NULL DEFAULT 'America/New_York'");
    // Shell-layer idle-session timeout. Read by shell/middleware/auth.js to
    // refresh the session cookie's expiration on each authenticated request
    // (sliding window). 60-minute default; UI exposes it as a Settings input.
    // Enforce a sane lower bound at write time, not here, so existing rows
    // don't break if the bound shifts.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS shell_idle_timeout_minutes INT NOT NULL DEFAULT 60");
    // Shell session epoch (cycle-7 F12): "Sign out everywhere" bumps it and the
    // shell refuses any cookie signed with an older epoch.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS shell_session_epoch INT NOT NULL DEFAULT 0");
    // Pyramid visualization settings
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pyramid_data_source TEXT NOT NULL DEFAULT 'wellness'");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pyramid_color_mode TEXT NOT NULL DEFAULT 'single'");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS debt_baseline_amount NUMERIC(12,2) DEFAULT NULL");
    // 002_csv_import.sql
    await client.query("CREATE TABLE IF NOT EXISTS csv_imports (id SERIAL PRIMARY KEY, filename TEXT NOT NULL, institution TEXT NOT NULL, account_label TEXT, rows_imported INT NOT NULL DEFAULT 0, rows_skipped INT NOT NULL DEFAULT 0, imported_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    // Financial goals
    await client.query(`CREATE TABLE IF NOT EXISTS financial_goals (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'savings',
      target_amount NUMERIC(14,2) NOT NULL,
      current_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      monthly_contribution NUMERIC(10,2) DEFAULT 0,
      target_date DATE,
      interest_rate NUMERIC(5,2) DEFAULT 0,
      notes TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Net worth snapshots
    await client.query(`CREATE TABLE IF NOT EXISTS net_worth_snapshots (
      id SERIAL PRIMARY KEY,
      total_assets NUMERIC(14,2) NOT NULL DEFAULT 0,
      total_liabilities NUMERIC(14,2) NOT NULL DEFAULT 0,
      net_worth NUMERIC(14,2) NOT NULL DEFAULT 0,
      breakdown JSONB,
      snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(snapshot_date)
    )`);
    // Tax deduction tracking — persistent year-round accumulation
    await client.query(`CREATE TABLE IF NOT EXISTS tax_deductions (
      id SERIAL PRIMARY KEY,
      tax_year INT NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE),
      transaction_id TEXT REFERENCES transactions(transaction_id),
      merchant TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      category TEXT NOT NULL DEFAULT 'uncategorized',
      deduction_type TEXT,
      notes TEXT,
      is_confirmed BOOLEAN NOT NULL DEFAULT false,
      flagged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(transaction_id, tax_year)
    )`);
    // Partial unique index for AI-detected deductions (no transaction_id)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_deductions_merchant_year
      ON tax_deductions (merchant, tax_year) WHERE transaction_id IS NULL`);
    // Investment / manual accounts (brokerage, retirement, etc.)
    await client.query(`CREATE TABLE IF NOT EXISTS investment_accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      institution TEXT,
      account_type TEXT NOT NULL DEFAULT 'brokerage',
      balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      notes TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Budgets
    await client.query(`CREATE TABLE IF NOT EXISTS budgets (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL UNIQUE,
      monthly_limit NUMERIC(12,2) NOT NULL,
      is_ai_suggested BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Push notification subscriptions
    await client.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      keys JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Plaid investment items
    await client.query(`CREATE TABLE IF NOT EXISTS plaid_investment_items (
      id SERIAL PRIMARY KEY,
      item_id TEXT NOT NULL UNIQUE,
      institution_name TEXT NOT NULL DEFAULT 'Unknown',
      access_token_enc BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Add plaid_account_id to investment_accounts
    await client.query("ALTER TABLE investment_accounts ADD COLUMN IF NOT EXISTS plaid_account_id TEXT UNIQUE");
    // Investment holdings
    await client.query(`CREATE TABLE IF NOT EXISTS investment_holdings (
      id SERIAL PRIMARY KEY,
      plaid_account_id TEXT NOT NULL,
      security_id TEXT NOT NULL,
      ticker TEXT,
      name TEXT NOT NULL DEFAULT 'Unknown',
      quantity NUMERIC(16,6) NOT NULL DEFAULT 0,
      cost_basis NUMERIC(14,2) NOT NULL DEFAULT 0,
      current_value NUMERIC(14,2) NOT NULL DEFAULT 0,
      security_type TEXT DEFAULT 'unknown',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(plaid_account_id, security_id)
    )`);
    // BSI-5: an unknown cost basis is NULL, not 0 (0 counted the whole value
    // as gain). Idempotent: dropping an absent NOT NULL / default is a no-op.
    await client.query("ALTER TABLE investment_holdings ALTER COLUMN cost_basis DROP NOT NULL");
    await client.query("ALTER TABLE investment_holdings ALTER COLUMN cost_basis DROP DEFAULT");
    // Granular token tracking for prompt caching
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS input_tokens INT");
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS output_tokens INT");
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS cache_read_tokens INT");
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS cache_creation_tokens INT");
    // Entry-type discriminator so /api/categorize can write tracking rows that
    // count against the shared monthly AI budget without showing up in the
    // user-facing "AI Insights" feed. Display queries filter entry_type='insight';
    // cost-cap queries don't filter (both feature areas count toward the cap).
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'insight'");
    // Manual accounts support
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS institution_name_manual TEXT DEFAULT NULL");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(12,2) DEFAULT NULL");
    // Liabilities data from Plaid (APR, minimum payment, loan details).
    // apr already exists; these columns supplement it for the debt
    // optimizer AI module and the bill calendar.
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS minimum_payment NUMERIC(12,2) DEFAULT NULL");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS next_payment_due_date DATE DEFAULT NULL");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS last_payment_amount NUMERIC(12,2) DEFAULT NULL");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS last_payment_date DATE DEFAULT NULL");
    // Transaction logo URL from Plaid's counterparties enrichment.
    // Stored at sync time; NULL for Teller-sourced or un-enriched rows.
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS logo_url TEXT DEFAULT NULL");
    // Shared/joint account support — spending_split_pct controls what fraction of spending counts as yours (default 100)
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS spending_split_pct INT NOT NULL DEFAULT 100");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false");
    // Fix check constraint to allow manual accounts (no plaid/teller enrollment).
    // Guarded (PSC-13): an unconditional DROP + ADD took an ACCESS EXCLUSIVE
    // lock and re-validated every row on EVERY boot. Rebuild only when the
    // constraint is missing or is the old definition without is_manual.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_account_source' AND conrelid = 'linked_accounts'::regclass
            AND pg_get_constraintdef(oid) LIKE '%is_manual%'
        ) THEN
          ALTER TABLE linked_accounts DROP CONSTRAINT IF EXISTS chk_account_source;
          ALTER TABLE linked_accounts ADD CONSTRAINT chk_account_source CHECK (plaid_item_id IS NOT NULL OR teller_enrollment_id IS NOT NULL OR is_manual = true);
        END IF;
      END $$;
    `);
    // Dashboard widget order/visibility
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dashboard_widgets JSONB NOT NULL DEFAULT '{"pyramid":true,"accounts":true,"recentTxns":true,"monthlySpend":true,"categories":true,"merchants":true,"upcoming":true,"forecast":true,"charts":true,"calendar":true,"cashFlow":true,"savingsRate":true,"yoy":true,"investments":true,"reviewQueue":true,"aiMemory":true,"settlement":true}'::jsonb`);
    // Sheets auto-sync
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sheets_auto_sync_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sheets_auto_sync_interval TEXT NOT NULL DEFAULT 'weekly'");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sheets_last_auto_sync TIMESTAMPTZ DEFAULT NULL");
    // SXE-1: outcome of the most recent Sheets sync ({ at, ok, tabs_failed,
    // errors: [{ step, error }] }) — surfaced by /api/data-health + Settings.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_sheets_sync_result JSONB");
    // Bank transaction auto-sync (Phase A) — scheduler calls syncAllEnrollments
    // in-process every auto_sync_interval_hours when enabled.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_sync_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_sync_interval_hours INT NOT NULL DEFAULT 6");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_auto_sync_at TIMESTAMPTZ DEFAULT NULL");
    // Transaction user-edits (Phase B1): overrides live in user_* columns so
    // re-syncing from Teller doesn't clobber the user's edits to merchant_name
    // or notes.
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_merchant_name TEXT");
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_notes TEXT");
    // Reimbursement flag (Phase B2): reimbursed transactions are excluded from
    // spending/budget/cash-flow/savings-rate aggregations so e.g. work travel
    // that the employer repaid doesn't eat into the user's entertainment budget.
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_reimbursed BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reimbursed_at TIMESTAMPTZ");
    await client.query("CREATE INDEX IF NOT EXISTS idx_transactions_reimbursed ON transactions (is_reimbursed) WHERE is_reimbursed = true");
    // User category override: manual category edits survive Teller re-sync because
    // the upsert only writes to `category` (Teller's slot). Display layers use
    // COALESCE(user_category, category[1]).
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_category TEXT");

    // Categorization provenance + accuracy verification. `user_category_source`
    // records HOW user_category was set ('ai' | 'rule' | 'teller_map' | 'manual'
    // | 'review') so the accuracy sampler can target AI-assigned rows
    // specifically. `category_verified_at` / `category_was_correct` capture the
    // user's verdict when they review a sampled AI categorization, driving the
    // running accuracy % shown in Settings.
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_category_source TEXT");
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_verified_at TIMESTAMPTZ");
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_was_correct BOOLEAN");
    // Partial index: only AI-sourced rows are ever sampled/scored.
    await client.query("CREATE INDEX IF NOT EXISTS idx_txn_cat_source_ai ON transactions (user_category_source) WHERE user_category_source = 'ai'");

    // Transaction splits (Phase B3): a single Teller transaction can be
    // subdivided into N (amount, category, merchant, notes) child rows so a
    // $120 Costco run showing up as "Groceries" can be split into groceries,
    // gas, and household. When splits exist they REPLACE the parent row in
    // category/merchant aggregations (see `routes/subscriptions.js` list
    // endpoints and `services/financial-queries.js`).
    await client.query(`CREATE TABLE IF NOT EXISTS transaction_splits (
      id                     SERIAL PRIMARY KEY,
      parent_transaction_id  TEXT NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
      amount                 NUMERIC(12,2) NOT NULL,
      category               TEXT,
      merchant_name          TEXT,
      notes                  TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_transaction_splits_parent ON transaction_splits (parent_transaction_id)");
    // CSV import reminder
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS csv_reminder_days INT NOT NULL DEFAULT 14");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS csv_reminder_enabled BOOLEAN NOT NULL DEFAULT true");
    // Performance indexes
    await client.query("CREATE INDEX IF NOT EXISTS idx_transactions_date_pending ON transactions (date, pending)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_linked_accounts_account_id ON linked_accounts (account_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_detected_subscriptions_active ON detected_subscriptions (is_active, is_dismissed, cancelled_at)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_financial_goals_active ON financial_goals (is_active)");
    // Phase C — link a goal to a specific savings/investment account. When set,
    // current_amount is computed as (account_balance - goal_baseline_amount) so
    // the goal auto-advances with the real account balance instead of requiring
    // manual edits. Mutually exclusive: at most one of funding_account_id /
    // funding_investment_id may be set.
    await client.query("ALTER TABLE financial_goals ADD COLUMN IF NOT EXISTS funding_account_id INT REFERENCES linked_accounts(id) ON DELETE SET NULL");
    await client.query("ALTER TABLE financial_goals ADD COLUMN IF NOT EXISTS funding_investment_id INT REFERENCES investment_accounts(id) ON DELETE SET NULL");
    await client.query("ALTER TABLE financial_goals ADD COLUMN IF NOT EXISTS goal_baseline_amount NUMERIC(14,2)");
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_goal_funding_exclusive') THEN
        ALTER TABLE financial_goals ADD CONSTRAINT chk_goal_funding_exclusive
          CHECK (NOT (funding_account_id IS NOT NULL AND funding_investment_id IS NOT NULL));
      END IF;
    END $$;`);
    // WebAuthn credentials (FaceID / biometric login)
    await client.query(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id SERIAL PRIMARY KEY,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      device_name TEXT DEFAULT 'Unknown Device',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Authenticator transports captured at registration (stored, but NOT used
    // as the login hint). Per INV-50 both auth-options endpoints advertise
    // transports: ['internal'] ONLY in allowCredentials — registration pins
    // authenticatorAttachment: 'platform', so every credential is same-device,
    // and advertising the cross-device 'hybrid' transport is exactly what
    // surfaced the "use a phone" QR option instead of local Touch/Face ID.
    // NULL for pre-existing rows is fine — the endpoints don't read this column
    // for the hint.
    await client.query(`ALTER TABLE webauthn_credentials
      ADD COLUMN IF NOT EXISTS transports TEXT[]`);
    // Seams audit #3: credential ids used to be stored double-encoded, so no
    // biometric login could match. Rewrite them to the real id (idempotent).
    {
      const n = await require("./webauthn-ids").repairCredentialIds(client);
      if (n) console.log(`Repaired ${n} biometric credential id(s)`);
    }
    // Recurring transfers — detected recurring transfers between accounts
    await client.query(`CREATE TABLE IF NOT EXISTS recurring_transfers (
      id SERIAL PRIMARY KEY,
      merchant_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      prior_amount NUMERIC(12,2),
      cadence_days INT NOT NULL,
      first_seen DATE NOT NULL,
      last_transferred DATE NOT NULL,
      next_expected DATE NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      is_dismissed BOOLEAN NOT NULL DEFAULT false,
      transfer_type TEXT NOT NULL DEFAULT 'other',
      direction TEXT NOT NULL DEFAULT 'outgoing',
      notes TEXT,
      amount_changed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (merchant_key, cadence_days, direction)
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_recurring_transfers_active ON recurring_transfers (is_active, is_dismissed)");
    // DC-4: a transfer_type the user picked (PATCH /api/recurring-transfers/:id/type)
    // survives re-detection; the detector's upsert only overwrites auto types.
    await client.query("ALTER TABLE recurring_transfers ADD COLUMN IF NOT EXISTS transfer_type_user_set BOOLEAN NOT NULL DEFAULT false");
    // Per-sistant integration: webhook target + enabled flag.
    // (The webhook HMAC secret is added below as encrypted BYTEA — older DBs
    // may have a plaintext TEXT column from before; that path migrates it.)
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS persistent_url TEXT");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS persistent_webhook_enabled BOOLEAN NOT NULL DEFAULT false");
    // Anomaly notification dedupe — only fire on transactions inserted after this watermark
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_anomaly_check_at TIMESTAMPTZ");
    // Encrypt-at-rest for the Per-sistant webhook HMAC secret. Older deployments
    // stored it as plain TEXT in `persistent_webhook_secret`; we add a BYTEA
    // column, copy any existing plaintext into it (encrypted), then drop the old
    // TEXT column. Idempotent: if the TEXT column is already gone we just keep
    // the BYTEA column.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS persistent_webhook_secret_enc BYTEA");
    if (ENCRYPTION_PASSPHRASE) {
      const hasOldCol = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'user_settings' AND column_name = 'persistent_webhook_secret'"
      );
      if (hasOldCol.rows.length > 0) {
        await client.query(
          `UPDATE user_settings
             SET persistent_webhook_secret_enc = pgp_sym_encrypt(persistent_webhook_secret, $1)
           WHERE persistent_webhook_secret IS NOT NULL
             AND persistent_webhook_secret_enc IS NULL`,
          [ENCRYPTION_PASSPHRASE]
        );
        await client.query("ALTER TABLE user_settings DROP COLUMN persistent_webhook_secret");
      }
    }

    // ---- Merchant categorization rules engine ----
    await client.query(`CREATE TABLE IF NOT EXISTS categorization_rules (
      id SERIAL PRIMARY KEY,
      merchant_pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'contains',
      is_active BOOLEAN NOT NULL DEFAULT true,
      times_applied INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(merchant_pattern, category)
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_categorization_rules_active ON categorization_rules (is_active) WHERE is_active = true");
    // Merchant rename rules (cycle-7 F55 / ST2): raw merchant pattern → display
    // name, applied at sync time; user_merchant_rule_id marks the rows a rule
    // renamed (NULL = renamed by hand, which always wins).
    await client.query(`CREATE TABLE IF NOT EXISTS merchant_rename_rules (
      id SERIAL PRIMARY KEY,
      merchant_pattern TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'exact' CHECK (match_type IN ('exact', 'starts_with', 'contains')),
      rename_to TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      times_applied INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (merchant_pattern, match_type)
    )`);
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_merchant_rule_id INT");

    // ---- Budget rollover / monthly snapshots ----
    await client.query("ALTER TABLE budgets ADD COLUMN IF NOT EXISTS rollover_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE budgets ADD COLUMN IF NOT EXISTS budget_type TEXT NOT NULL DEFAULT 'recurring'");
    await client.query("ALTER TABLE budgets ADD COLUMN IF NOT EXISTS effective_month TEXT DEFAULT NULL");
    await client.query(`CREATE TABLE IF NOT EXISTS budget_snapshots (
      id SERIAL PRIMARY KEY,
      budget_id INT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      monthly_limit NUMERIC(12,2) NOT NULL,
      spent NUMERIC(12,2) NOT NULL DEFAULT 0,
      rollover_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(budget_id, month)
    )`);

    // ---- Calendar manual bills ----
    await client.query(`CREATE TABLE IF NOT EXISTS manual_bills (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      due_day INT NOT NULL,
      cadence TEXT NOT NULL DEFAULT 'monthly',
      category TEXT NOT NULL DEFAULT 'bill',
      is_active BOOLEAN NOT NULL DEFAULT true,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS bill_payments (
      id SERIAL PRIMARY KEY,
      bill_source TEXT NOT NULL,
      bill_id INT NOT NULL,
      paid_date DATE NOT NULL,
      paid_amount NUMERIC(12,2),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(bill_source, bill_id, paid_date)
    )`);

    // ---- Unified notification log ----
    await client.query(`CREATE TABLE IF NOT EXISTS notification_log (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      data JSONB,
      is_read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_notification_log_unread ON notification_log (is_read, created_at DESC) WHERE is_read = false");

    // ---- Data freshness tracking ----
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_balance_sync_at TIMESTAMPTZ DEFAULT NULL");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_txn_sync_at TIMESTAMPTZ DEFAULT NULL");
    // Structured result of the most recent sync run (any path), so per-item
    // errors (esp. `decryption_failed`, which deliberately does NOT mark an
    // enrollment DISCONNECTED) surface in the Sync Health card instead of only
    // living in a manual-sync HTTP payload. Shape: { at, errors:[{provider,
    // institution, error}] }.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_sync_result JSONB DEFAULT NULL");
    // Sync notification toggle
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sync_notifications_enabled BOOLEAN NOT NULL DEFAULT true");

    // ---- AI Audit Log ----
    await client.query(`CREATE TABLE IF NOT EXISTS ai_audit_log (
      id SERIAL PRIMARY KEY,
      insight_id INT REFERENCES financial_insights(id) ON DELETE CASCADE,
      module TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      check_type TEXT NOT NULL,
      claim_text TEXT,
      expected_value TEXT,
      actual_value TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_ai_audit_log_insight ON ai_audit_log (insight_id, severity)");

    // ---- Account balance history (per-account daily snapshots) ----
    // Captures balance over time for each account so the UI can show
    // performance for investment accounts (and arbitrary balance trends for
    // any account). Polymorphic: source='linked' rows reference linked_accounts.id,
    // source='investment' rows reference investment_accounts.id. The lack of FK
    // is deliberate — both source tables exist with their own lifecycles, and a
    // polymorphic UNIQUE keeps lookups O(1) per (source, source_id, date).
    // Writes happen at the end of syncAllBalances and POST /api/plaid/sync-holdings,
    // both of which are the only paths that update account balances.
    await client.query(`CREATE TABLE IF NOT EXISTS account_balance_snapshots (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('linked', 'investment')),
      source_id INT NOT NULL,
      snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
      balance NUMERIC(14,2) NOT NULL,
      available_balance NUMERIC(14,2),
      current_balance NUMERIC(14,2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source, source_id, snapshot_date)
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_acct_balance_snapshots_lookup ON account_balance_snapshots (source, source_id, snapshot_date DESC)");

    // ---- Insight user-feedback loop (S1: trust loop) ----
    // Per-insight thumbs-up/down + optional free-form correction, fed back
    // into the next insight's prompt so Claude learns from user pushback.
    // Severity-graded into a small enum so /api/insights/feedback-summary
    // can show "X positive / Y negative / Z mixed" without scanning blobs.
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS user_feedback TEXT CHECK (user_feedback IS NULL OR user_feedback IN ('positive', 'negative', 'mixed'))");
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS user_feedback_text TEXT");
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS user_feedback_at TIMESTAMPTZ");
    // AI-5/AI-6: explicit per-run audit completion marker. `audited_at` proves
    // the post-generation audit actually ran for this insight; `audit_incomplete`
    // is true when one or more audit tiers threw (DB error) and produced no
    // findings. getAuditAccuracy uses these to count ONLY genuinely-audited,
    // complete runs — previously a run with zero audit rows (never audited, or
    // a swallowed tier failure) was indistinguishable from a clean run and
    // inflated the accuracy %.
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ");
    await client.query("ALTER TABLE financial_insights ADD COLUMN IF NOT EXISTS audit_incomplete BOOLEAN NOT NULL DEFAULT false");

    // ---- "What changed since last sync" view (S3) ----
    // Watermark for the dashboard's "since you last looked" widget. POSTed
    // to /api/whats-new/seen on dashboard load; the widget queries
    // /api/whats-new which aggregates new txns, balance deltas, new
    // subscriptions/anomalies/notifications since this timestamp.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_dashboard_view_at TIMESTAMPTZ");

    // ---- Weekly digest scheduler (S2) ----
    // Independent of the per-insight `insights_generated` email — this is a
    // standing Monday-morning digest rendered from the structured running
    // summary (trends, pending_actions, alerts). The toggle lets users
    // opt out without disabling the insights_generated channel.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS weekly_digest_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS weekly_digest_day INT NOT NULL DEFAULT 1");  // 0=Sun, 1=Mon, ...
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_weekly_digest_at TIMESTAMPTZ");

    // ---- Target allocation (#8) ----
    // Per-asset-class target weights as JSONB, e.g. {"equity": 70, "etf": 20, "bond": 10}.
    // Sums should be 100 ± float-noise but the API tolerates anything for input —
    // /api/investments/performance computes drift = actual_pct - target_pct so a
    // miscalibrated target still produces a useful (just biased) drift signal.
    // Empty object means "no targets configured" → drift fields omitted from
    // the response.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS target_allocation_pct JSONB NOT NULL DEFAULT '{}'::jsonb");

    // ---- Daily "what changed" digest (#19) ----
    // Opt-in mail of the last 24h of activity (new txns, balance deltas,
    // new subscriptions, notifications). Independent of the dashboard
    // widget's last_dashboard_view_at watermark — the daily digest always
    // looks back exactly 24h regardless of when the user last opened the
    // dashboard. Hourly scheduler ticks; runDailyDigest dedupes with a
    // 20-hour gate from last_daily_digest_at.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_daily_digest_at TIMESTAMPTZ");
    // PSC-3: watermark for the CSV-import reminder (hourly tick, ≤ 1 per 24h,
    // survives restarts — it used to be a 24-hour setInterval that needed 24h
    // of continuous uptime and essentially never fired).
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_csv_reminder_at TIMESTAMPTZ");
    // Cycle-7 F63: the AI-insights auto-trigger stamps every ATTEMPT here, so a
    // run that fails (cap reached, empty answer, DB error) isn't re-attempted —
    // full Teller+Plaid sync chain included — on every 6-hour tick.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_last_attempt_at TIMESTAMPTZ");

    // ---- Self-healing reconcile watermark ----
    // Tracks the last time the trailing-window backfill (POST /api/sync/reconcile
    // and the weekly self-healing scheduler) ran, so the weekly job can dedupe
    // its ticks. Reconcile re-fetches a bounded recent window and re-upserts
    // (idempotent) to recover any transactions a prior incremental sync dropped.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_reconcile_at TIMESTAMPTZ");

    // ---- Shared-card per-transaction settlement override ----
    // For shared/joint accounts (is_shared = true), the account-level
    // spending_split_pct splits every transaction at the same percentage.
    // personal_for overrides that split for individual transactions: when set,
    // the row is 100% attributed to one person ('self' = you, 'partner' = the
    // other cardholder) instead of being split. NULL = use the account default.
    // Only honored when the account is is_shared = true; on non-shared accounts
    // the split formula falls back to spending_split_pct as before.
    await client.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS personal_for TEXT");
    // Guarded like chk_account_source (PSC-13) — no per-boot lock + full scan.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_personal_for' AND conrelid = 'transactions'::regclass
        ) THEN
          ALTER TABLE transactions ADD CONSTRAINT chk_personal_for CHECK (personal_for IS NULL OR personal_for IN ('self','partner'));
        END IF;
      END $$;
    `);
    // partner_name surfaces in the settlement widget + transaction-row UI so
    // amounts say "Sarah owes you $X" rather than "Partner owes you $X".
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS partner_name TEXT");
    // Monthly AI budget cap, user-tunable from Settings (cents; NULL = fall
    // back to the INSIGHTS_MONTHLY_BUDGET_CENTS env var, then 50). Resolved
    // by getAiBudgetCents() in routes/insights.js — the single read path
    // shared by insights, categorize, and rebuild.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_monthly_budget_cents INT");
    // Critical-alert emails (budget exceeded / anomaly charges) — opt-in.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS critical_alert_emails_enabled BOOLEAN NOT NULL DEFAULT false");
    // Insight emails (cycle-7 F81): every insight run emails the report
    // (insights_generated). On by default — the old behaviour — and switchable
    // off in Settings → AI Insights.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insight_emails_enabled BOOLEAN NOT NULL DEFAULT true");
    // Cycle-7 G1 / ST4: the set of failing operator checks last notified, so a
    // persistent problem (no backups, a disabled backstop) notifies once.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS operator_checks_signature TEXT");
    // VPS move: deploy/vps/backup.sh stamps each verified nightly backup here;
    // with SERVER_BACKUPS=true Operator Checks reads it (services/hosting.js).
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_backup_at TIMESTAMPTZ");
    // Roadmap T2.2 L2: the low projected cash alert (services/cash-alerts.js) —
    // off by default; the alert's dedup state and the last evaluation time.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS cash_alert_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS cash_alert_threshold NUMERIC(12,2) NOT NULL DEFAULT 500");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS cash_alert_horizon_days INT NOT NULL DEFAULT 14");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS cash_alert_state JSONB");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS cash_alerts_checked_at TIMESTAMPTZ");
    // Roadmap T2.2 L3: payday alerts (services/payday-alerts.js) — off by
    // default; the "Paycheck landed" watermark over transactions.created_at.
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS payday_alerts_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_income_alert_at TIMESTAMPTZ");
    // Roadmap T2.4 X2a: linked tasks — Perfin items kept as Per-sistant tasks
    // (services/linked-tasks.js). Off by default; which sources (decision 5 —
    // manual bills off); how many days before a manual bill its task opens;
    // the last run's record (written by the runner, X2b).
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS linked_tasks_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS linked_tasks_sources JSONB NOT NULL DEFAULT '{"still_charging": true, "housing": true, "utility_amount": true, "bills": false}'::jsonb`);
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS linked_tasks_bill_lead_days INT NOT NULL DEFAULT 3");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS linked_tasks_state JSONB");
    // FIRE / runway projection assumptions (Goals page card). NULLs fall back
    // to defaults in GET /api/fire-projection (return 5%, withdrawal 4%,
    // spending derived from trailing months).
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS fire_expected_return_pct NUMERIC(5,2)");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS fire_withdrawal_rate_pct NUMERIC(5,2)");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS fire_monthly_spending_override NUMERIC(12,2)");

    // ---- Watchlist ----
    // User-curated list of merchants / categories / keywords to monitor.
    // Rendered into the Watchlist sheet tab on each Sheets sync, with the
    // last 90 days of matching transactions. type is a 3-value enum;
    // value is the literal merchant name, category name, or keyword to
    // ILIKE-match against transactions.
    await client.query(`CREATE TABLE IF NOT EXISTS watchlist_items (
      id         SERIAL PRIMARY KEY,
      type       TEXT NOT NULL CHECK (type IN ('merchant','category','keyword')),
      value      TEXT NOT NULL,
      notes      TEXT,
      is_active  BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(type, value)
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_watchlist_active ON watchlist_items (is_active, type)");

    // ---- Credit score tracking (manual entry) ----
    // Users log their credit score periodically (e.g. once a month from
    // their bank/card app). The app stores history, trends it on the
    // dashboard, syncs to Sheets, and feeds the trajectory into AI
    // insights so Claude can correlate score changes with spending behavior.
    await client.query(`CREATE TABLE IF NOT EXISTS credit_scores (
      id          SERIAL PRIMARY KEY,
      score       INT NOT NULL CHECK (score >= 300 AND score <= 850),
      score_type  TEXT NOT NULL DEFAULT 'vantagescore' CHECK (score_type IN ('fico','vantagescore','other')),
      source      TEXT,
      notes       TEXT,
      checked_at  DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(checked_at, score_type)
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_credit_scores_date ON credit_scores (checked_at DESC)");

    // ---- Rent & Utilities payee ledger ----------------------------------
    // A single-payee accounts-payable ledger: rent + per-utility obligations
    // accumulate monthly (utilities start as `pending_amount` until the bill
    // arrives and the amount is entered), settled by `payee_payments` that can
    // cover several months at once with a memo. Config (payee, rent, due day,
    // utilities, reminder lead) lives in user_settings.housing_config (below).
    // payee_obligations.paid_payment_id is an FK-by-convention (like
    // bill_payments) — the route reverts status on payment delete, so no
    // DB-level cascade/constraint-existence migration is needed.
    await client.query(`CREATE TABLE IF NOT EXISTS payee_obligations (
      id              SERIAL PRIMARY KEY,
      payee           TEXT NOT NULL,
      category        TEXT NOT NULL DEFAULT 'rent' CHECK (category IN ('rent','utility','other')),
      label           TEXT NOT NULL,
      period          TEXT NOT NULL,
      amount          NUMERIC(12,2),
      due_day         INT NOT NULL DEFAULT 1 CHECK (due_day BETWEEN 1 AND 31),
      status          TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('pending_amount','unpaid','paid')),
      paid_payment_id INT,
      notes           TEXT,
      auto_generated  BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(payee, period, category, label)
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_payee_obligations_status ON payee_obligations (status, period)");
    // Cycle-7 F33: an auto-generated obligation the user removes (a utility
    // bill that won't come, a month with no rent) is remembered here, so the
    // 6-hourly generation doesn't put it straight back. Keyed like the
    // generation's own existence check (period + category + label, any payee).
    await client.query(`CREATE TABLE IF NOT EXISTS payee_obligation_skips (
      period     TEXT NOT NULL,
      category   TEXT NOT NULL,
      label      TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (period, category, label)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS payee_payments (
      id          SERIAL PRIMARY KEY,
      payee       TEXT NOT NULL,
      paid_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      amount      NUMERIC(12,2) NOT NULL,
      memo        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS housing_config JSONB NOT NULL DEFAULT '{}'::jsonb");

    // ---- Plaid item re-auth signal (BSI-10). A Plaid ITEM_* error that needs
    // the user to re-authenticate (ITEM_LOGIN_REQUIRED, …) is recorded here and
    // cleared on the next successful sync / re-link. Deliberately a separate
    // column rather than a new `status` value: every sync path filters
    // status = 'GOOD', so flipping status would STOP retrying the item and it
    // could never self-clear. status stays 'GOOD' | 'CSV'. ----
    await client.query("ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS last_error_code TEXT");
    // When the item's transaction walk last reached the end of its cursor —
    // the per-connection freshness a webhook-triggered sync advances without
    // touching the global last_txn_sync_at (roadmap T2.1 W3).
    await client.query("ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ");
    // The webhook URL each Plaid item was last registered with (link token or
    // POST /api/plaid/webhooks/register — roadmap T2.1 W4); NULL = none known.
    await client.query("ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS webhook_url TEXT");
    await client.query("ALTER TABLE plaid_investment_items ADD COLUMN IF NOT EXISTS webhook_url TEXT");
    // When a Teller enrollment last synced every account and row — the
    // per-connection freshness a webhook sync advances (roadmap T2.1 W5).
    await client.query("ALTER TABLE teller_enrollments ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ");

    // ---- Settle-up log: one row per month the user marks squared with the
    // partner (combined shared-card + housing even-up). UNIQUE(period) so
    // re-marking a month updates rather than duplicates. ----
    await client.query(`CREATE TABLE IF NOT EXISTS settlements (
      id          SERIAL PRIMARY KEY,
      period      TEXT NOT NULL,
      net_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
      direction   TEXT,
      note        TEXT,
      settled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(period)
    )`);

    // ---- Add 'investments' to dashboard_widgets default for new users ----
    // For existing rows: merge the new key into the JSONB without overwriting
    // user customizations to other keys. jsonb concat (||) is right-precedence,
    // so we put the existing JSON on the right to preserve user-set values.
    await client.query(`
      UPDATE user_settings
      SET dashboard_widgets = '{"investments":true}'::jsonb || dashboard_widgets
      WHERE NOT (dashboard_widgets ? 'investments')
    `);
    await client.query(`
      UPDATE user_settings
      SET dashboard_widgets = '{"reviewQueue":true}'::jsonb || dashboard_widgets
      WHERE NOT (dashboard_widgets ? 'reviewQueue')
    `);
    await client.query(`
      UPDATE user_settings
      SET dashboard_widgets = '{"aiMemory":true}'::jsonb || dashboard_widgets
      WHERE NOT (dashboard_widgets ? 'aiMemory')
    `);
    await client.query(`
      UPDATE user_settings
      SET dashboard_widgets = '{"whatsNew":true,"investmentReturns":true,"creditScore":true}'::jsonb || dashboard_widgets
      WHERE NOT (dashboard_widgets ? 'whatsNew') OR NOT (dashboard_widgets ? 'investmentReturns') OR NOT (dashboard_widgets ? 'creditScore')
    `);

    // Benchmark close cache (investment performance vs S&P 500). Filled
    // lazily by services/benchmarks.js ensureBenchmark() — at most one Stooq
    // fetch per day, only the missing date range. Read by
    // GET /api/investments/performance-history.
    await client.query(`CREATE TABLE IF NOT EXISTS benchmark_prices (
      symbol     TEXT NOT NULL,
      price_date DATE NOT NULL,
      close      NUMERIC(14,4) NOT NULL,
      PRIMARY KEY (symbol, price_date)
    )`);

    // External cash flows for investment accounts (TWR/XIRR). Plaid rows come
    // from investmentsTransactionsGet (deposits/withdrawals/in-kind transfers
    // — dividends and buy/sell churn are RETURN, not flows, and are never
    // inserted here); manual rows from POST /api/investment-flows for
    // accounts Plaid can't see (Teller-linked, manual). `amount` is signed:
    // positive = money INTO the portfolio, negative = out. Polymorphic
    // (source, source_id) reference, same convention as
    // account_balance_snapshots.
    await client.query(`CREATE TABLE IF NOT EXISTS investment_flows (
      id          SERIAL PRIMARY KEY,
      source      TEXT NOT NULL DEFAULT 'investment' CHECK (source IN ('linked', 'investment')),
      source_id   INT NOT NULL,
      flow_date   DATE NOT NULL,
      amount      NUMERIC(14,2) NOT NULL,
      flow_type   TEXT NOT NULL CHECK (flow_type IN ('contribution', 'withdrawal', 'transfer_in', 'transfer_out')),
      provenance  TEXT NOT NULL DEFAULT 'manual' CHECK (provenance IN ('plaid', 'manual')),
      plaid_investment_transaction_id TEXT UNIQUE,
      name        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_flows_src_date ON investment_flows (source, source_id, flow_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_flows_date ON investment_flows (flow_date)`);
    // Cycle-7 F24: when a Plaid account's external flows last synced
    // completely. TWR/XIRR count a Plaid account as flow-covered only once
    // this is set — before, every Plaid account counted as covered even if
    // its flows never synced, so its deposits read as market return.
    await client.query("ALTER TABLE investment_accounts ADD COLUMN IF NOT EXISTS flows_synced_at TIMESTAMPTZ");
    // Cycle-7 G3: a Plaid investment account's mask (last digits), written by
    // the holdings sync + both exchange paths, so the investments-only link
    // can refuse a duplicate of an earlier investments-only Item (F18 guard).
    await client.query("ALTER TABLE investment_accounts ADD COLUMN IF NOT EXISTS mask TEXT");
    // Roadmap T3.3 K1: every Plaid investment transaction (buys, sells,
    // dividends, interest, fees, corporate actions — investment_flows keeps only
    // the external cash flows), written by the same investmentsTransactionsGet
    // pages the flow sync reads. Kept beyond Plaid's 24-month window, so the
    // lot history behind realized gains grows from here on. No FK to
    // investment_accounts (like investment_flows): reset-fresh truncates both.
    await client.query(`CREATE TABLE IF NOT EXISTS investment_transactions (
      id SERIAL PRIMARY KEY,
      plaid_investment_transaction_id TEXT NOT NULL UNIQUE,
      investment_account_id INT NOT NULL,
      txn_date DATE NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      security_id TEXT,
      ticker TEXT,
      security_name TEXT,
      security_type TEXT,
      quantity NUMERIC(24,8),
      price NUMERIC(24,8),
      amount NUMERIC(18,4),
      fees NUMERIC(18,4),
      name TEXT,
      cancel_transaction_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_txn_account_date
      ON investment_transactions (investment_account_id, txn_date)`);

    // Scheduled-job heartbeat table (F4 — missed-job detection). One row per
    // background job in teller/startup.js, UPSERTed by services/job-health.js
    // when ticks are flushed. The `_watchdog` row stores the last-notified
    // missed-job signature in last_error so a persistent outage alerts once,
    // not on every watchdog pass.
    await client.query(`CREATE TABLE IF NOT EXISTS job_runs (
      job_name    TEXT PRIMARY KEY,
      last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_status TEXT,
      last_error  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    // In-app error log (roadmap T1.4): server errors grouped by fingerprint,
    // written by services/error-log.js (the shell's console.error wrapper) and
    // shown in Settings → Sync Health. A resolved row reopens when the error
    // happens again; notified_at caps the notifications.
    await client.query(`CREATE TABLE IF NOT EXISTS app_errors (
      fingerprint TEXT PRIMARY KEY,
      source      TEXT NOT NULL DEFAULT 'app',
      message     TEXT NOT NULL,
      sample      TEXT,
      count       INT NOT NULL DEFAULT 1,
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      notified_at TIMESTAMPTZ
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_app_errors_last_seen ON app_errors (last_seen DESC)");

    // Bank webhook event log (roadmap T2.1, W1): one row per VERIFIED Plaid /
    // Teller delivery, written by routes/webhooks.js before it answers 200.
    // dedupe_key is provider-supplied (Teller's event id; Plaid's signed
    // verification header) so a replayed or re-delivered request is recorded
    // and processed once. The request body is never stored. Pruned after 30
    // days.
    await client.query(`CREATE TABLE IF NOT EXISTS webhook_events (
      id           BIGSERIAL PRIMARY KEY,
      provider     TEXT NOT NULL CHECK (provider IN ('plaid', 'teller')),
      event_type   TEXT,
      event_code   TEXT,
      subject      TEXT,
      dedupe_key   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received', 'processing', 'done', 'failed', 'ignored')),
      error        TEXT,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      UNIQUE (provider, dedupe_key)
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events (received_at DESC)");

    // One-shot cleanup: detection-key migration orphans (PSA1 — now genuinely
    // one-shot, gated on the schema version so it doesn't re-run every boot).
    // When detection started keying on COALESCE(user_merchant_name, merchant_name, name)
    // instead of raw merchant_name, pre-existing detected_subscriptions /
    // recurring_transfers rows keyed by the raw merchant_name were left active
    // alongside the new rows keyed by the user-overridden name. Both UPDATEs are
    // idempotent, but the predicate (`t.merchant_name = merchant_key AND a
    // differing user override exists`) can deactivate an unrelated active row if
    // two distinct merchants share a raw name and one is renamed — so we run it
    // exactly once during the v3 upgrade rather than on every restart. Existing
    // deploys retired their orphans long ago; this just stops the recurring
    // re-exposure.
    if (currentVersion < 3) {
      await client.query(`
        UPDATE detected_subscriptions ds
        SET is_active = false, updated_at = now()
        WHERE ds.is_active = true
          AND EXISTS (
            SELECT 1 FROM transactions t
            WHERE t.merchant_name = ds.merchant_key
              AND t.user_merchant_name IS NOT NULL
              AND t.user_merchant_name != ds.merchant_key
          )
      `);
      await client.query(`
        UPDATE recurring_transfers rt
        SET is_active = false, updated_at = now()
        WHERE rt.is_active = true
          AND EXISTS (
            SELECT 1 FROM transactions t
            WHERE t.merchant_name = rt.merchant_key
              AND t.user_merchant_name IS NOT NULL
              AND t.user_merchant_name != rt.merchant_key
          )
      `);
    }

    // Record schema version
    if (currentVersion < SCHEMA_VERSION) {
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [SCHEMA_VERSION]
      );
    }
    await client.query("COMMIT");
    console.log("Migrations complete.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, ENCRYPTION_PASSPHRASE, runMigrations, MIGRATION_LOCK_KEY };
