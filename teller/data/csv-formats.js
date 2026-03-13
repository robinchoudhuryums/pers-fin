// ============================================================================
// CSV Format Definitions — bank-specific CSV parsers
// ============================================================================

const crypto = require("crypto");

const CSV_FORMATS = {
  chase: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Post Date") && headers.includes("Description"),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: -parseFloat(row["Amount"]),
      category: row["Category"] || "",
    }),
  },
  capitalone: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Posted Date") && (headers.includes("Debit") || headers.includes("Credit")),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: parseFloat(row["Debit"] || "0") || -(parseFloat(row["Credit"] || "0")),
      category: row["Category"] || "",
    }),
  },
  discover: {
    detect: (headers) => headers.includes("Trans. Date") && headers.includes("Description") && headers.includes("Amount"),
    parse: (row) => ({
      date: row["Trans. Date"],
      merchant_name: row["Description"],
      amount: Math.abs(parseFloat(row["Amount"])),
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
      amount: -parseFloat(row[cols[1]]),
      category: "",
    }),
  },
  schwab: {
    detect: (headers) => headers.includes("Date") && headers.includes("Description") && (headers.includes("Withdrawal") || headers.includes("Amount")),
    parse: (row) => ({
      date: row["Date"],
      merchant_name: row["Description"],
      amount: Math.abs(parseFloat(row["Withdrawal"] || row["Amount"] || "0")),
      category: row["Type"] || "",
    }),
  },
  generic: {
    detect: () => true,
    parse: (row) => {
      const date = row["Date"] || row["Transaction Date"] || Object.values(row)[0];
      const merchant = row["Description"] || row["Merchant"] || row["Name"] || Object.values(row)[1];
      const amount = parseFloat(row["Amount"] || row["Debit"] || Object.values(row)[2] || 0);
      const category = row["Category"] || "";
      return { date, merchant_name: merchant, amount: Math.abs(amount), category };
    },
  },
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
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const isoMatch = trimmed.match(/^\d{4}-\d{2}-\d{2}$/);
  if (isoMatch) return trimmed;
  const parsed = new Date(trimmed);
  return isNaN(parsed) ? null : parsed.toISOString().split("T")[0];
}

function csvTransactionId(accountLabel, date, amount, merchant, rowIdx) {
  const raw = `${accountLabel}|${date}|${amount}|${merchant || ""}|${rowIdx}`;
  return "csv_" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

module.exports = {
  CSV_FORMATS,
  detectCsvFormat,
  parseDate,
  csvTransactionId,
};
