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
    detect: (headers) => headers.includes("Date") && headers.includes("Description") && (headers.includes("Withdrawal") || (headers.includes("Amount") && headers.includes("Type"))),
    parse: (row) => {
      const rawWithdrawal = (row["Withdrawal"] || "").replace(/[$,]/g, "").trim();
      const rawDeposit = (row["Deposit"] || "").replace(/[$,]/g, "").trim();
      const rawAmount = (row["Amount"] || "").replace(/[$,]/g, "").trim();
      const withdrawal = parseFloat(rawWithdrawal) || 0;
      const deposit = parseFloat(rawDeposit) || 0;
      // Withdrawals are debits (positive), deposits are credits (negative)
      const amount = withdrawal > 0 ? withdrawal : deposit > 0 ? -deposit : Math.abs(parseFloat(rawAmount) || 0);
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
      const rawAmt = (row["Amount"] || row["Debit"] || Object.values(row)[2] || "0").toString().replace(/[$,]/g, "");
      const amount = parseFloat(rawAmt);
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

function csvTransactionId(accountLabel, date, amount, merchant) {
  const raw = `${accountLabel}|${date}|${amount}|${merchant || ""}`;
  return "csv_" + crypto.createHash("sha256").update(raw).digest("hex");
}

module.exports = {
  CSV_FORMATS,
  detectCsvFormat,
  parseDate,
  csvTransactionId,
};
