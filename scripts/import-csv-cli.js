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
const crypto = require("crypto");
const { Pool } = require("pg");
const { parse } = require("csv-parse/sync");

const ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE;
const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 10000,
});

// ---------------------------------------------------------------------------
// CSV format definitions (same as server.js)
// ---------------------------------------------------------------------------
const CSV_FORMATS = {
  chase: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Post Date") && headers.includes("Description"),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: -parseFloat(row["Amount"]),
      category: row["Category"] || null,
    }),
  },
  wellsfargo: {
    detect: (headers) => headers.length >= 5 && !headers.includes("Transaction Date") && !headers.includes("Category"),
    parseHeaderless: true,
    parse: (row, columns) => ({
      date: columns[0],
      merchant_name: columns[4] || columns[3] || null,
      amount: -parseFloat(columns[1]),
      category: null,
    }),
  },
  capitalone: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Posted Date") && (headers.includes("Debit") || headers.includes("Credit")),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: parseFloat(row["Debit"] || "0") || -(parseFloat(row["Credit"] || "0")),
      category: row["Category"] || null,
    }),
  },
  discover: {
    detect: (headers) => headers.includes("Trans. Date") && headers.includes("Post Date") && headers.includes("Description") && headers.includes("Amount"),
    parse: (row) => ({
      date: row["Trans. Date"],
      merchant_name: row["Description"],
      amount: Math.abs(parseFloat(row["Amount"])),
      category: row["Category"] || null,
    }),
  },
  schwab: {
    detect: (headers) => headers.includes("Date") && headers.includes("Description") && (headers.includes("Withdrawal") || headers.includes("Amount")),
    parse: (row) => ({
      date: row["Date"],
      merchant_name: row["Description"],
      amount: Math.abs(parseFloat(row["Withdrawal"] || row["Amount"] || "0")),
      category: row["Type"] || null,
    }),
  },
  generic: {
    detect: () => true,
    parse: (row) => {
      const date = row["Date"] || row["Transaction Date"] || row["date"] || Object.values(row)[0];
      const desc = row["Description"] || row["Merchant"] || row["Name"] || row["description"] || Object.values(row).find(v => typeof v === "string" && v.length > 3 && isNaN(v));
      const amtStr = row["Amount"] || row["Debit"] || row["amount"] || Object.values(row).find(v => !isNaN(parseFloat(v)));
      return {
        date,
        merchant_name: desc || null,
        amount: Math.abs(parseFloat(amtStr) || 0),
        category: row["Category"] || row["category"] || null,
      };
    },
  },
};

function detectCsvFormat(headers) {
  for (const [name, fmt] of Object.entries(CSV_FORMATS)) {
    if (name !== "generic" && fmt.detect(headers)) return name;
  }
  return "generic";
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();
  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) return `${slashMatch[3]}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// ---------------------------------------------------------------------------
// Detect institution from filename prefix
// ---------------------------------------------------------------------------
const FILENAME_PATTERNS = {
  chase: /^chase/i,
  wellsfargo: /^(wellsfargo|wells_fargo|wf)/i,
  capitalone: /^(capitalone|capital_one|capone)/i,
  discover: /^discover/i,
  schwab: /^(schwab|charles_schwab)/i,
};

function institutionFromFilename(filename) {
  for (const [bank, pattern] of Object.entries(FILENAME_PATTERNS)) {
    if (pattern.test(filename)) return bank;
  }
  return null;
}

const INSTITUTION_LABELS = {
  chase: "Chase",
  wellsfargo: "Wells Fargo",
  capitalone: "Capital One",
  discover: "Discover",
  schwab: "Charles Schwab",
  generic: "CSV Import",
};

// ---------------------------------------------------------------------------
// Import a single CSV file
// ---------------------------------------------------------------------------
async function importCsvFile(filePath) {
  const filename = path.basename(filePath);
  const content = fs.readFileSync(filePath, "utf-8");

  let records;
  try {
    records = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch {
    try {
      records = parse(content, { columns: false, skip_empty_lines: true, trim: true, bom: true });
    } catch (e2) {
      console.error(`  ✗ Could not parse ${filename}: ${e2.message}`);
      return null;
    }
  }

  if (!records.length) {
    console.error(`  ✗ ${filename} is empty`);
    return null;
  }

  // Detect format
  const hasHeaders = !Array.isArray(records[0]);
  const headers = hasHeaders ? Object.keys(records[0]) : [];

  // Try filename first, then content-based detection
  const filenameBank = institutionFromFilename(filename);
  const format = filenameBank || (hasHeaders ? detectCsvFormat(headers) : "wellsfargo");
  const fmt = CSV_FORMATS[format];

  const institution = INSTITUTION_LABELS[format] || INSTITUTION_LABELS[filenameBank] || "CSV Import";
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
        parsed = hasHeaders ? fmt.parse(row) : fmt.parse(row, row);
      } catch {
        skipped++;
        continue;
      }

      const date = parseDate(parsed.date);
      if (!date || isNaN(parsed.amount) || parsed.amount === 0) {
        skipped++;
        continue;
      }

      const txnHash = crypto
        .createHash("sha256")
        .update(`${virtualAccountId}|${date}|${parsed.amount}|${parsed.merchant_name || ""}|${i}`)
        .digest("hex")
        .slice(0, 24);
      const transactionId = `csv_${txnHash}`;

      try {
        await client.query(
          `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, pending)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false)
           ON CONFLICT (transaction_id) DO NOTHING`,
          [virtualAccountId, transactionId, parsed.amount, date, parsed.merchant_name, parsed.merchant_name, parsed.category ? [parsed.category] : null]
        );
        imported++;
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
