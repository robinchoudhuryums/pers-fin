// ============================================================================
// CSV Format Definitions — bank-specific CSV parsers
// ============================================================================

const crypto = require("crypto");

// Parse a monetary string into a number, tolerating the formatting real bank
// CSVs ship: thousands separators ("1,234.56"), a leading currency symbol
// ("$1,234.56"), parenthesized negatives ("(45.00)"), and surrounding
// whitespace. Returns NaN for blank/unparseable input so callers (and the
// import route's `isNaN(parsed.amount)` guard) skip the row rather than
// inserting a corrupt amount. Previously chase/capitalone/discover/wellsfargo
// called parseFloat directly, so "1,234.56" silently became 1.
function parseMoney(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (s === "") return NaN;
  let sign = 1;
  // Accounting-style parenthesized negatives, e.g. "(45.00)".
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, "");
  if (s === "") return NaN;
  const n = parseFloat(s);
  return isNaN(n) ? NaN : sign * n;
}

const CSV_FORMATS = {
  chase: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Post Date") && headers.includes("Description"),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: -parseMoney(row["Amount"]),
      category: row["Category"] || "",
    }),
  },
  capitalone: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Posted Date") && (headers.includes("Debit") || headers.includes("Credit")),
    parse: (row) => {
      // Capital One uses separate Debit/Credit columns; Debit = positive spending, Credit = negative (payment/refund)
      const debit = parseMoney(row["Debit"]);
      const credit = parseMoney(row["Credit"]);
      const amount = !isNaN(debit) ? debit : -(isNaN(credit) ? 0 : credit);
      return {
        date: row["Transaction Date"],
        merchant_name: row["Description"],
        amount,
        category: row["Category"] || "",
      };
    },
  },
  discover: {
    detect: (headers) => headers.includes("Trans. Date") && headers.includes("Description") && headers.includes("Amount"),
    parse: (row) => ({
      date: row["Trans. Date"],
      merchant_name: row["Description"],
      // Discover: positive amounts are debits (purchases), negative are credits (payments)
      amount: parseMoney(row["Amount"]),
      category: row["Category"] || "",
    }),
  },
  wellsfargo: {
    detect: (headers) => headers.length === 5 && !headers.includes("Transaction Date"),
    headerless: true,
    columns: ["date", "amount", "ignore1", "ignore2", "merchant_name"],
    parse: (row, cols) => ({
      date: row[cols[0]],
      merchant_name: (row[cols[4]] || row[cols[3]] || "").trim(),
      amount: -parseMoney(row[cols[1]]),
      category: "",
    }),
  },
  schwab: {
    detect: (headers) => headers.includes("Date") && headers.includes("Description") && (headers.includes("Withdrawal") || (headers.includes("Amount") && headers.includes("Type"))),
    parse: (row) => {
      // Use the shared parseMoney (F6) so parenthesized negatives, currency
      // symbols, and thousands separators are handled like every other format.
      const withdrawal = parseMoney(row["Withdrawal"]);
      const deposit = parseMoney(row["Deposit"]);
      const rawAmount = parseMoney(row["Amount"]);
      // Withdrawals are debits (positive), deposits are credits (negative)
      const amount = withdrawal > 0 ? withdrawal
        : deposit > 0 ? -deposit
        : Math.abs(isNaN(rawAmount) ? 0 : rawAmount);
      return {
        date: row["Date"],
        merchant_name: row["Description"],
        amount,
        category: row["Type"] || "",
      };
    },
  },
  generic: {
    detect: () => true,
    parse: (row) => {
      const date = row["Date"] || row["Transaction Date"] || Object.values(row)[0];
      const merchant = row["Description"] || row["Merchant"] || row["Name"] || Object.values(row)[1];
      // Shared parseMoney (F6) — handles "(45.00)" parenthesized negatives,
      // "$", and thousands separators, where the old parseFloat returned NaN.
      const amount = parseMoney(row["Amount"] || row["Debit"] || Object.values(row)[2] || "0");
      const category = row["Category"] || "";
      return { date, merchant_name: merchant, amount, category };
    },
  },
};

// Canonical institution display name per detected format. Shared by the CLI
// (scripts/import-csv-cli.js) and the /api/import-csv route so both derive the
// SAME default account label ("<institution> Account") from a file's content
// when the caller doesn't supply one — making their `csvTransactionId`s match
// for the same row instead of double-importing (F2).
const INSTITUTION_LABELS = {
  chase: "Chase",
  wellsfargo: "Wells Fargo",
  capitalone: "Capital One",
  discover: "Discover",
  schwab: "Charles Schwab",
  generic: "CSV Import",
};

function detectCsvFormat(headers) {
  for (const [name, fmt] of Object.entries(CSV_FORMATS)) {
    if (name === "generic") continue;
    if (fmt.detect(headers)) return name;
  }
  return "generic";
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  let isoDate;
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    isoDate = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  } else {
    const isoMatch = trimmed.match(/^\d{4}-\d{2}-\d{2}$/);
    if (isoMatch) {
      isoDate = trimmed;
    } else {
      const parsed = new Date(trimmed);
      if (isNaN(parsed)) return null;
      isoDate = parsed.toISOString().split("T")[0];
    }
  }
  // Validate the date is real (rejects Feb 30, month 13, etc.)
  const check = new Date(isoDate + "T00:00:00Z");
  if (isNaN(check) || check.toISOString().split("T")[0] !== isoDate) return null;
  return isoDate;
}

// Build the dedup hash from (accountLabel, date, amount, merchant). Fields
// are joined with `|`, so any `|` inside a field would shift downstream
// boundaries and let two distinct tuples hash to the same value (e.g.
// accountLabel="X|Y", date="Z" vs accountLabel="X", date="Y|Z"). We escape
// literal pipes in each field before joining so the delimiter is
// unambiguous. Fields without `|` produce the same hash as before — that's
// the typical case, so existing csv_* IDs in the database remain stable
// and dedup against re-imports of the same rows continues to work. Only
// rows containing `|` (rare, but the bug class) get a different hash;
// those rows were collision-prone under the old scheme anyway.
function csvTransactionId(accountLabel, date, amount, merchant) {
  const esc = (v) => String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  const raw = `${esc(accountLabel)}|${esc(date)}|${esc(amount)}|${esc(merchant)}`;
  return "csv_" + crypto.createHash("sha256").update(raw).digest("hex");
}

module.exports = {
  CSV_FORMATS,
  INSTITUTION_LABELS,
  detectCsvFormat,
  parseDate,
  csvTransactionId,
  parseMoney,
};
