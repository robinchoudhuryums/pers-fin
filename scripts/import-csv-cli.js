#!/usr/bin/env node
// ============================================================================
// CSV Import CLI — Standalone script for importing CSV bank exports
// ============================================================================
// Processes all CSV files in a directory (default: csv-uploads/) and imports
// transactions into the Neon Postgres database.
//
// Usage:
//   node scripts/import-csv-cli.js                     # process csv-uploads/
//   node scripts/import-csv-cli.js path/to/dir         # process custom dir
//   node scripts/import-csv-cli.js path/to/file.csv    # process single file
//
// Bank is auto-detected from filename prefix or CSV content:
//   chase_march2025.csv       → Chase format
//   capitalone_checking.csv   → Capital One format
//   wellsfargo_2025.csv       → Wells Fargo format
//   anything_else.csv         → auto-detect from headers
//
// Environment variables (loaded from .env automatically):
//   NEON_DATABASE_URL, TOKEN_ENCRYPTION_PASSPHRASE
// ============================================================================

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { parse } = require("csv-parse/sync");

// CSV_FORMATS is the single source of truth in teller/data/csv-formats.js;
// this CLI used to redefine it inline (and drift). We now import it so any
// future bank-format change propagates to both the API route and the CLI.
const { CSV_FORMATS, INSTITUTION_LABELS, detectCsvFormat, parseDate, csvTransactionId } = require("../teller/data/csv-formats");

const ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE;
const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 2,
  connectionTimeoutMillis: 10000,
});

// Format is detected from CSV CONTENT only (see importCsvFile), matching the
// API route. Filename-prefix detection was removed (F31) because it could
// force the wrong parser for a misnamed file and made the CLI and the route
// disagree on the same file. INSTITUTION_LABELS is imported from the shared
// csv-formats module so the CLI and the route derive identical default account
// labels (and thus identical dedup IDs) from a file's content (F2).

// ---------------------------------------------------------------------------
// Import a single CSV file
// ---------------------------------------------------------------------------
async function importCsvFile(filePath) {
  const filename = path.basename(filePath);
  const content = fs.readFileSync(filePath, "utf-8");

  // Initial parse with columns:true to read headers (or to let the headerless
  // detector below infer the format from row count + absence of expected names).
  let records;
  try {
    records = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (e2) {
    console.error(`  ✗ Could not parse ${filename}: ${e2.message}`);
    return null;
  }

  if (!records.length) {
    console.error(`  ✗ ${filename} is empty`);
    return null;
  }

  // Detect format from CSV CONTENT only — matching the API route
  // (teller/routes/subscriptions.js detectCsvFormat). The previous filename-hint
  // precedence could force the wrong parser for a misnamed file (F31).
  const headers = Object.keys(records[0]);
  const format = detectCsvFormat(headers);
  let fmt = CSV_FORMATS[format];

  // Headerless formats (e.g., Wells Fargo) ship without a header row. When detected,
  // re-parse with the format's `columns` definition so each record is keyed by the
  // declared column names. Without this, fmt.parse would receive the wrong shape and
  // every row would silently fail validation.
  if (fmt && fmt.headerless && fmt.columns) {
    try {
      records = parse(content, { columns: fmt.columns, skip_empty_lines: true, trim: true, bom: true });
    } catch (e2) {
      console.error(`  ✗ Could not re-parse ${filename} as headerless ${format}: ${e2.message}`);
      return null;
    }
  }

  const institution = INSTITUTION_LABELS[format] || "CSV Import";
  const accountLabel = `${institution} Account`;

  const institutionSlug = institution.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const accountSlug = accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const virtualItemId = `csv_${institutionSlug}`;
  const virtualAccountId = `csv_${accountSlug}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const itemResult = await client.query(
      `INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status)
       VALUES ($1, $2, pgp_sym_encrypt('csv_import', $3), 'CSV')
       ON CONFLICT (item_id)
       DO UPDATE SET institution_name = EXCLUDED.institution_name, updated_at = now()
       RETURNING id`,
      [virtualItemId, institution, ENCRYPTION_PASSPHRASE]
    );
    const plaidItemId = itemResult.rows[0].id;

    await client.query(
      `INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype)
       VALUES ($1, $2, $3, 'csv_import', 'csv')
       ON CONFLICT (account_id)
       DO UPDATE SET name = EXCLUDED.name`,
      [plaidItemId, virtualAccountId, accountLabel]
    );

    let imported = 0;
    let skipped = 0;

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      let parsed;
      try {
        // The teller/data/csv-formats.js parsers all share the (row, headers)
        // signature; for headerless formats, headers === fmt.columns.
        parsed = fmt.parse(row, fmt.headerless ? fmt.columns : Object.keys(row));
      } catch {
        skipped++;
        continue;
      }

      const date = parseDate(parsed.date);
      if (!date || isNaN(parsed.amount) || parsed.amount === 0) {
        skipped++;
        continue;
      }

      // Use the SHARED dedup-ID helper so the CLI and the API route generate
      // identical transaction IDs for the same row (F29). The old scheme hashed
      // virtualAccountId (route hashes accountLabel), truncated to 24 chars, AND
      // folded in the row index `i` — so re-importing the same file produced
      // brand-new IDs and never deduped against itself.
      const transactionId = csvTransactionId(accountLabel, date, parsed.amount, parsed.merchant_name);

      try {
        const ins = await client.query(
          `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, pending)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false)
           ON CONFLICT (transaction_id) DO NOTHING`,
          [virtualAccountId, transactionId, parsed.amount, date, parsed.merchant_name, parsed.merchant_name, parsed.category ? [parsed.category] : null]
        );
        // ON CONFLICT DO NOTHING → rowCount 1 on a real insert, 0 on a dup.
        // Count dups as skipped, not imported (F30).
        if (ins.rowCount > 0) imported++;
        else skipped++;
      } catch {
        skipped++;
      }
    }

    await client.query(
      `INSERT INTO csv_imports (filename, institution, account_label, rows_imported, rows_skipped)
       VALUES ($1, $2, $3, $4, $5)`,
      [filename, institution, accountLabel, imported, skipped]
    );

    await client.query("COMMIT");
    console.log(`  ✓ ${filename} → ${format} format | ${imported} imported, ${skipped} skipped`);
    return { filename, format, institution, imported, skipped };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`  ✗ ${filename}: ${err.message}`);
    return null;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const target = process.argv[2] || path.resolve(__dirname, "../csv-uploads");
  const stat = fs.statSync(target, { throwIfNoEntry: false });

  if (!stat) {
    console.error(`Path not found: ${target}`);
    process.exit(1);
  }

  const files = stat.isDirectory()
    ? fs.readdirSync(target).filter(f => f.endsWith(".csv")).map(f => path.join(target, f))
    : [target];

  if (files.length === 0) {
    console.log("No CSV files found.");
    process.exit(0);
  }

  console.log(`\nImporting ${files.length} CSV file(s)...\n`);

  const results = [];
  for (const file of files) {
    const result = await importCsvFile(file);
    if (result) results.push(result);
  }

  console.log(`\nDone: ${results.length}/${files.length} files imported successfully.`);

  // Run subscription detection
  if (results.length > 0) {
    console.log("\nRunning subscription detection...");
    try {
      const { detectSubscriptions } = require("./detect-subscriptions");
      const count = await detectSubscriptions();
      console.log(`Detected ${count} subscription(s).`);
    } catch (err) {
      console.error("Detection error:", err.message);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
