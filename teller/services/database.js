// ============================================================================
// Database — Pool setup and auto-migrations
// ============================================================================

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 5,
  connectionTimeoutMillis: 10000,
});

const ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE;

async function runMigrations() {
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    // 005_settings.sql
    await pool.query(`
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
    await pool.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    await pool.query("CREATE TABLE IF NOT EXISTS financial_insights (id SERIAL PRIMARY KEY, insight_text TEXT NOT NULL, period_start DATE, period_end DATE, model_used TEXT, tokens_used INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    // 006_insights_memory.sql
    await pool.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_running_summary TEXT DEFAULT NULL");
    await pool.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_model TEXT NOT NULL DEFAULT 'sonnet'");
    await pool.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insights_cadence_days INT NOT NULL DEFAULT 30");
    await pool.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS zip_code TEXT DEFAULT NULL");
    await pool.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS insight_modules JSONB NOT NULL DEFAULT '{\"utility_comparison\":true,\"spending_benchmarks\":true,\"savings_suggestions\":true,\"subscription_audit\":true,\"anomaly_detection\":true,\"seasonal_forecast\":true,\"debt_optimizer\":true,\"bill_negotiation\":true,\"income_savings\":true,\"tax_deductions\":true,\"goal_tracking\":true}'::jsonb");
    // 003_dashboard_features.sql
    await pool.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS is_dismissed BOOLEAN NOT NULL DEFAULT false");
    await pool.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'detected'");
    await pool.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS cancel_confirmed BOOLEAN NOT NULL DEFAULT false");
    await pool.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS notes TEXT");
    await pool.query("ALTER TABLE detected_subscriptions ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'subscription'");
    // 004_balances.sql
    await pool.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS available_balance NUMERIC(12,2)");
    await pool.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS current_balance NUMERIC(12,2)");
    await pool.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS balance_currency TEXT DEFAULT 'USD'");
    await pool.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS balance_updated_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS apr NUMERIC(5,2)");
    // keep-alive settings
    await pool.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_enabled BOOLEAN NOT NULL DEFAULT false");
    await pool.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_start INT NOT NULL DEFAULT 6");
    await pool.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_end INT NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_timezone TEXT NOT NULL DEFAULT 'America/New_York'");
    // 002_csv_import.sql
    await pool.query("CREATE TABLE IF NOT EXISTS csv_imports (id SERIAL PRIMARY KEY, filename TEXT NOT NULL, institution TEXT NOT NULL, account_label TEXT, rows_imported INT NOT NULL DEFAULT 0, rows_skipped INT NOT NULL DEFAULT 0, imported_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    // Financial goals
    await pool.query(`CREATE TABLE IF NOT EXISTS financial_goals (
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
    await pool.query(`CREATE TABLE IF NOT EXISTS net_worth_snapshots (
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
    await pool.query(`CREATE TABLE IF NOT EXISTS tax_deductions (
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
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_deductions_merchant_year
      ON tax_deductions (merchant, tax_year) WHERE transaction_id IS NULL`);
    // Investment / manual accounts (brokerage, retirement, etc.)
    await pool.query(`CREATE TABLE IF NOT EXISTS investment_accounts (
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
    await pool.query(`CREATE TABLE IF NOT EXISTS budgets (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL UNIQUE,
      monthly_limit NUMERIC(12,2) NOT NULL,
      is_ai_suggested BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Push notification subscriptions
    await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      keys JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    console.log("Migrations complete.");
  } catch (err) {
    console.error("Migration error (non-fatal):", err.message);
  }
}

module.exports = { pool, ENCRYPTION_PASSPHRASE, runMigrations };
