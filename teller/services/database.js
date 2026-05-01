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
  ssl: { rejectUnauthorized: true },
  max: 5,
  connectionTimeoutMillis: 10000,
});

// Log pool errors to prevent unhandled rejections
pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err.message);
});

const ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE;
if (!ENCRYPTION_PASSPHRASE) {
  console.warn("WARNING: TOKEN_ENCRYPTION_PASSPHRASE is not set. Token encryption will fail.");
}

// Current schema version — increment when adding new migration steps
const SCHEMA_VERSION = 2;

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");

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
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_model TEXT NOT NULL DEFAULT 'sonnet'");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_cadence_days INT NOT NULL DEFAULT 30");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS zip_code TEXT DEFAULT NULL");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insight_modules JSONB NOT NULL DEFAULT '{\"utility_comparison\":true,\"spending_benchmarks\":true,\"savings_suggestions\":true,\"subscription_audit\":true,\"anomaly_detection\":true,\"seasonal_forecast\":true,\"debt_optimizer\":true,\"bill_negotiation\":true,\"income_savings\":true,\"tax_deductions\":true,\"goal_tracking\":true,\"recurring_transfers\":true}'::jsonb");
    // 003_dashboard_features.sql
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS is_dismissed BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'detected'");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS cancel_confirmed BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS notes TEXT");
    await client.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'subscription'");
    // 004_balances.sql
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS available_balance NUMERIC(12,2)");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS current_balance NUMERIC(12,2)");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS balance_currency TEXT DEFAULT 'USD'");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS balance_updated_at TIMESTAMPTZ");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS apr NUMERIC(5,2)");
    // keep-alive settings
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_start INT NOT NULL DEFAULT 6");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_end INT NOT NULL DEFAULT 0");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_timezone TEXT NOT NULL DEFAULT 'America/New_York'");
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
    // Shared/joint account support — spending_split_pct controls what fraction of spending counts as yours (default 100)
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS spending_split_pct INT NOT NULL DEFAULT 100");
    await client.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false");
    // Fix check constraint to allow manual accounts (no plaid/teller enrollment)
    await client.query("ALTER TABLE linked_accounts DROP CONSTRAINT IF EXISTS chk_account_source");
    await client.query("ALTER TABLE linked_accounts ADD CONSTRAINT chk_account_source CHECK (plaid_item_id IS NOT NULL OR teller_enrollment_id IS NOT NULL OR is_manual = true)");
    // Dashboard widget order/visibility
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dashboard_widgets JSONB NOT NULL DEFAULT '{"pyramid":true,"accounts":true,"recentTxns":true,"monthlySpend":true,"categories":true,"merchants":true,"upcoming":true,"forecast":true,"charts":true,"calendar":true,"cashFlow":true,"savingsRate":true,"yoy":true}'::jsonb`);
    // Sheets auto-sync
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sheets_auto_sync_enabled BOOLEAN NOT NULL DEFAULT false");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sheets_auto_sync_interval TEXT NOT NULL DEFAULT 'weekly'");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sheets_last_auto_sync TIMESTAMPTZ DEFAULT NULL");
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
    console.error("FATAL: Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, ENCRYPTION_PASSPHRASE, runMigrations };
