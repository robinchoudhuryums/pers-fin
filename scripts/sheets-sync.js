// ============================================================================
// Google Sheets Sync — Personal Finance Dashboard
// ============================================================================
// Syncs Plaid transactions and detected subscriptions to Google Sheets,
// then builds a polished dashboard sheet with summaries and formatting.
//
// Setup:
//   1. Create a Google Cloud project, enable Sheets API
//   2. Create a Service Account, download the JSON key
//   3. Share your spreadsheet with the service account email
//   4. Set GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_KEY in .env
//
// Usage:
//   node scripts/sheets-sync.js              # full sync
//   node scripts/sheets-sync.js --dashboard  # rebuild dashboard only
// ============================================================================

const { google } = require("googleapis");
const { Pool } = require("pg");
const path = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SERVICE_ACCOUNT_KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

const SHEET_TRANSACTIONS = "Transactions";
const SHEET_SUBSCRIPTIONS = "Subscriptions";
const SHEET_DASHBOARD = "Dashboard";

// ---------------------------------------------------------------------------
// Auth + Sheets client
// ---------------------------------------------------------------------------
async function getSheetsClient() {
  const keyPath = path.resolve(SERVICE_ACCOUNT_KEY_PATH);
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------
function getPool() {
  return new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 10000,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function ensureSheet(sheets, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(
    (s) => s.properties.title === title
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
  }
}

async function getSheetId(sheets, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find((s) => s.properties.title === title);
  return sheet ? sheet.properties.sheetId : null;
}

function fmtCurrency(val) {
  return typeof val === "number" ? val : parseFloat(val) || 0;
}

function fmtDate(d) {
  if (!d) return "";
  const date = new Date(d);
  return date.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Sync Transactions
// ---------------------------------------------------------------------------
async function syncTransactions(sheets, pool) {
  console.log("Syncing transactions to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT
      t.date,
      COALESCE(t.merchant_name, t.name) AS merchant,
      t.amount,
      la.name AS account_name,
      la.type AS account_type,
      COALESCE(pi.institution_name, te.institution_name, 'CSV Import') AS institution_name,
      t.category[1] AS category,
      t.personal_finance_category->>'primary' AS pfc_primary,
      t.personal_finance_category->>'detailed' AS pfc_detailed
    FROM transactions t
    JOIN linked_accounts la ON la.account_id = t.account_id
    LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
    LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
    WHERE t.pending = false
    ORDER BY t.date DESC
  `);

  await ensureSheet(sheets, SHEET_TRANSACTIONS);

  const headers = [
    "Date", "Merchant", "Amount", "Account", "Account Type",
    "Institution", "Category", "Category (Detailed)", "Month",
  ];

  const data = rows.map((r) => [
    fmtDate(r.date),
    r.merchant || "",
    fmtCurrency(r.amount),
    r.account_name || "",
    r.account_type || "",
    r.institution_name || "",
    r.pfc_primary || r.category || "",
    r.pfc_detailed || "",
    fmtDate(r.date).slice(0, 7), // YYYY-MM for pivot/grouping
  ]);

  // Clear and write
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TRANSACTIONS}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TRANSACTIONS}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  // Format headers
  const sheetId = await getSheetId(sheets, SHEET_TRANSACTIONS);
  if (sheetId !== null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          // Bold headers
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.2, green: 0.3, blue: 0.55 },
                  textFormat: { bold: true, fontSize: 11, foregroundColor: { red: 1, green: 1, blue: 1 } },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          },
          // Freeze header row
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
          // Amount column currency format (col C = index 2)
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" },
                },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          },
          // Auto-resize columns
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 9 },
            },
          },
          // Alternating row colors
          {
            addBanding: {
              bandedRange: {
                range: { sheetId, startRowIndex: 0, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 9 },
                rowProperties: {
                  headerColor: { red: 0.2, green: 0.3, blue: 0.55 },
                  firstBandColor: { red: 1, green: 1, blue: 1 },
                  secondBandColor: { red: 0.94, green: 0.95, blue: 0.97 },
                },
              },
            },
          },
        ],
      },
    });
  }

  console.log(`  ${rows.length} transactions written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Subscriptions
// ---------------------------------------------------------------------------
async function syncSubscriptions(sheets, pool) {
  console.log("Syncing subscriptions to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT
      display_name,
      amount,
      cadence_days,
      CASE
        WHEN cadence_days > 0 THEN ROUND(amount * (30.0 / cadence_days), 2)
        ELSE amount
      END AS monthly_cost,
      CASE
        WHEN cadence_days > 0 THEN ROUND(amount * (365.0 / cadence_days), 2)
        ELSE amount * 12
      END AS yearly_cost,
      CASE
        WHEN cadence_days <= 35 THEN 'Monthly'
        WHEN cadence_days <= 65 THEN 'Bi-monthly'
        WHEN cadence_days <= 95 THEN 'Quarterly'
        WHEN cadence_days <= 370 THEN 'Yearly'
        ELSE cadence_days || ' days'
      END AS cycle,
      first_seen,
      last_charged,
      next_expected,
      is_active,
      is_dismissed,
      cancelled_at IS NOT NULL AS is_cancelled,
      source,
      notes
    FROM detected_subscriptions
    ORDER BY
      CASE WHEN is_active AND NOT is_dismissed AND cancelled_at IS NULL THEN 0 ELSE 1 END,
      amount DESC
  `);

  await ensureSheet(sheets, SHEET_SUBSCRIPTIONS);

  const headers = [
    "Service", "Amount", "Cycle", "Monthly Cost", "Yearly Cost",
    "First Seen", "Last Charged", "Next Charge", "Status", "Source", "Notes",
  ];

  const data = rows.map((r) => {
    let status = "Active";
    if (r.is_cancelled) status = "Cancelled";
    else if (r.is_dismissed) status = "Dismissed";
    else if (!r.is_active) status = "Inactive";

    return [
      r.display_name,
      fmtCurrency(r.amount),
      r.cycle,
      fmtCurrency(r.monthly_cost),
      fmtCurrency(r.yearly_cost),
      fmtDate(r.first_seen),
      fmtDate(r.last_charged),
      fmtDate(r.next_expected),
      status,
      r.source || "detected",
      r.notes || "",
    ];
  });

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_SUBSCRIPTIONS}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_SUBSCRIPTIONS}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_SUBSCRIPTIONS);
  if (sheetId !== null) {
    const requests = [
      // Bold white headers on dark bg
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.17, green: 0.37, blue: 0.27 },
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
      // Freeze header
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      // Currency format for Amount, Monthly Cost, Yearly Cost (cols B, D, E = indices 1, 3, 4)
      ...[1, 3, 4].map((col) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      })),
      // Auto-resize
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 11 },
        },
      },
      // Alternating rows
      {
        addBanding: {
          bandedRange: {
            range: { sheetId, startRowIndex: 0, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 11 },
            rowProperties: {
              headerColor: { red: 0.17, green: 0.37, blue: 0.27 },
              firstBandColor: { red: 1, green: 1, blue: 1 },
              secondBandColor: { red: 0.91, green: 0.96, blue: 0.92 },
            },
          },
        },
      },
    ];

    // Conditional formatting: red bg for "Cancelled", yellow for "Dismissed"
    if (data.length > 0) {
      requests.push(
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$I2="Cancelled"` }] },
                format: { backgroundColor: { red: 0.96, green: 0.87, blue: 0.87 } },
              },
            },
            index: 0,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$I2="Dismissed"` }] },
                format: { backgroundColor: { red: 1, green: 0.96, blue: 0.87 } },
              },
            },
            index: 1,
          },
        }
      );
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  console.log(`  ${rows.length} subscriptions written.`);
  return rows;
}

// ---------------------------------------------------------------------------
// Build Dashboard
// ---------------------------------------------------------------------------
async function buildDashboard(sheets, pool) {
  console.log("Building dashboard...");

  // Fetch summary data from DB
  const { rows: monthlySummary } = await pool.query(`
    SELECT
      TO_CHAR(date, 'YYYY-MM') AS month,
      COUNT(*) AS txn_count,
      SUM(amount) AS total_spend,
      ROUND(AVG(amount), 2) AS avg_transaction
    FROM transactions
    WHERE pending = false AND amount > 0
      AND date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY TO_CHAR(date, 'YYYY-MM')
    ORDER BY month DESC
  `);

  const { rows: categorySummary } = await pool.query(`
    SELECT
      COALESCE(personal_finance_category->>'primary', category[1], 'Uncategorized') AS category,
      SUM(amount) AS total,
      COUNT(*) AS txn_count
    FROM transactions
    WHERE pending = false AND amount > 0
      AND date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY category
    ORDER BY total DESC
    LIMIT 15
  `);

  const { rows: topMerchants } = await pool.query(`
    SELECT
      COALESCE(merchant_name, name) AS merchant,
      SUM(amount) AS total,
      COUNT(*) AS txn_count
    FROM transactions
    WHERE pending = false AND amount > 0
      AND date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY merchant
    ORDER BY total DESC
    LIMIT 10
  `);

  const { rows: activeSubs } = await pool.query(`
    SELECT display_name, amount, cadence_days, next_expected,
      CASE
        WHEN cadence_days > 0 THEN ROUND(amount * (30.0 / cadence_days), 2)
        ELSE amount
      END AS monthly_cost
    FROM detected_subscriptions
    WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
    ORDER BY next_expected ASC
  `);

  const { rows: totals } = await pool.query(`
    SELECT
      COALESCE(SUM(amount), 0) AS total_6mo,
      COALESCE(AVG(amount), 0) AS avg_txn,
      COUNT(*) AS txn_count
    FROM transactions
    WHERE pending = false AND amount > 0
      AND date >= CURRENT_DATE - INTERVAL '6 months'
  `);

  // Net worth history
  const { rows: netWorthHistory } = await pool.query(`
    SELECT snapshot_date, total_assets, total_liabilities, net_worth
    FROM net_worth_snapshots
    ORDER BY snapshot_date DESC
    LIMIT 6
  `);

  // Budget status
  const { rows: budgetData } = await pool.query(`
    SELECT b.category, b.monthly_limit,
           COALESCE(SUM(t.amount), 0) AS spent
    FROM budgets b
    LEFT JOIN transactions t ON COALESCE(t.category[1], 'Uncategorized') = b.category
      AND t.amount > 0 AND t.pending = false
      AND t.date >= date_trunc('month', CURRENT_DATE)
      AND t.date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
    GROUP BY b.category, b.monthly_limit
    ORDER BY b.monthly_limit DESC
  `);

  // Financial goals
  const { rows: goalsData } = await pool.query(`
    SELECT name, type, target_amount, current_amount, monthly_contribution, target_date
    FROM financial_goals
    WHERE is_active = true
    ORDER BY target_amount DESC
  `);

  // Recurring transfers summary
  const { rows: transferSummary } = await pool.query(`
    SELECT transfer_type, direction,
           COUNT(*) AS count,
           ROUND(SUM(amount * (30.0 / GREATEST(cadence_days, 1))), 2) AS monthly_total
    FROM recurring_transfers
    WHERE is_active = true AND is_dismissed = false
    GROUP BY transfer_type, direction
    ORDER BY monthly_total DESC
  `);

  const totalMonthly = activeSubs.reduce(
    (sum, s) => sum + parseFloat(s.monthly_cost || 0),
    0
  );
  const totalYearly = totalMonthly * 12;
  const total6mo = parseFloat(totals[0]?.total_6mo || 0);
  const avgMonthlySpend = total6mo / 6;
  const avgDailySpend = total6mo / 180;

  await ensureSheet(sheets, SHEET_DASHBOARD);

  // Build dashboard rows
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const rows = [];

  // Title
  rows.push(["PERSONAL FINANCE DASHBOARD", "", "", "", "", ""]);
  rows.push([`Last updated: ${now}`, "", "", "", "", ""]);
  rows.push([]);

  // Summary cards row
  rows.push(["Avg Monthly Spend", "Subscriptions /mo", "Subscriptions /yr", "Active Subscriptions", "Avg Daily Spend", "6-Month Total"]);
  rows.push([
    avgMonthlySpend,
    totalMonthly,
    totalYearly,
    activeSubs.length,
    avgDailySpend,
    total6mo,
  ]);
  rows.push([]);

  // Monthly trend
  rows.push(["MONTHLY SPENDING TREND", "", "", ""]);
  rows.push(["Month", "Total Spend", "Transactions", "Avg Transaction"]);
  for (const m of monthlySummary) {
    rows.push([m.month, fmtCurrency(m.total_spend), parseInt(m.txn_count), fmtCurrency(m.avg_transaction)]);
  }
  rows.push([]);

  // Category breakdown
  const catStartRow = rows.length;
  rows.push(["SPENDING BY CATEGORY", "", ""]);
  rows.push(["Category", "Total", "Transactions"]);
  const totalCatSpend = categorySummary.reduce((s, c) => s + parseFloat(c.total), 0);
  for (const c of categorySummary) {
    rows.push([c.category, fmtCurrency(c.total), parseInt(c.txn_count)]);
  }
  rows.push([]);

  // Top merchants
  rows.push(["TOP MERCHANTS", "", ""]);
  rows.push(["Merchant", "Total Spent", "Transactions"]);
  for (const m of topMerchants) {
    rows.push([m.merchant || "Unknown", fmtCurrency(m.total), parseInt(m.txn_count)]);
  }
  rows.push([]);

  // Upcoming subscription charges
  rows.push(["UPCOMING SUBSCRIPTION CHARGES", "", "", ""]);
  rows.push(["Service", "Amount", "Next Charge", "Monthly Cost"]);
  for (const s of activeSubs) {
    rows.push([
      s.display_name,
      fmtCurrency(s.amount),
      fmtDate(s.next_expected),
      fmtCurrency(s.monthly_cost),
    ]);
  }

  // Net worth history
  if (netWorthHistory.length > 0) {
    rows.push([]);
    rows.push(["NET WORTH HISTORY", "", "", ""]);
    rows.push(["Date", "Assets", "Liabilities", "Net Worth"]);
    for (const nw of netWorthHistory) {
      rows.push([
        fmtDate(nw.snapshot_date),
        fmtCurrency(nw.total_assets),
        fmtCurrency(nw.total_liabilities),
        fmtCurrency(nw.net_worth),
      ]);
    }
  }

  // Budget status
  let budgetStartRow = -1;
  if (budgetData.length > 0) {
    rows.push([]);
    rows.push(["BUDGET STATUS (Current Month)", "", "", ""]);
    rows.push(["Category", "Spent", "Budget", "% Used"]);
    budgetStartRow = rows.length; // first data row (after header)
    for (const b of budgetData) {
      const spent = parseFloat(b.spent);
      const limit = parseFloat(b.monthly_limit);
      const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
      rows.push([b.category, spent, limit, pct + "%"]);
    }
  }

  // Recurring transfers summary
  if (transferSummary.length > 0) {
    rows.push([]);
    rows.push(["RECURRING TRANSFERS SUMMARY", "", "", ""]);
    rows.push(["Type", "Direction", "Count", "Monthly Total"]);
    for (const t of transferSummary) {
      rows.push([
        t.transfer_type,
        t.direction,
        parseInt(t.count),
        fmtCurrency(t.monthly_total),
      ]);
    }
  }

  // Financial goals
  if (goalsData.length > 0) {
    rows.push([]);
    rows.push(["FINANCIAL GOALS", "", "", "", ""]);
    rows.push(["Goal", "Current", "Target", "% Complete", "Monthly Contribution"]);
    for (const g of goalsData) {
      const current = parseFloat(g.current_amount);
      const target = parseFloat(g.target_amount);
      const pct = target > 0 ? Math.round((current / target) * 100) : 0;
      rows.push([
        g.name,
        current,
        target,
        pct + "%",
        parseFloat(g.monthly_contribution || 0),
      ]);
    }
  }

  // Write dashboard
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DASHBOARD}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DASHBOARD}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  // Apply formatting
  const sheetId = await getSheetId(sheets, SHEET_DASHBOARD);
  if (sheetId !== null) {
    const requests = [
      // Title — large bold font, merged
      {
        mergeCells: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
          mergeType: "MERGE_ALL",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, fontSize: 18, foregroundColor: { red: 0.15, green: 0.25, blue: 0.45 } },
            },
          },
          fields: "userEnteredFormat.textFormat",
        },
      },
      // Subtitle
      {
        mergeCells: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 6 },
          mergeType: "MERGE_ALL",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
          cell: {
            userEnteredFormat: {
              textFormat: { italic: true, fontSize: 10, foregroundColor: { red: 0.5, green: 0.5, blue: 0.5 } },
            },
          },
          fields: "userEnteredFormat.textFormat",
        },
      },
      // Summary card labels (row 4) — bold, dark bg
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 6 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
              backgroundColor: { red: 0.2, green: 0.3, blue: 0.5 },
              horizontalAlignment: "CENTER",
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)",
        },
      },
      // Summary card values (row 5) — large bold, light bg
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 6 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, fontSize: 16 },
              backgroundColor: { red: 0.93, green: 0.94, blue: 0.97 },
              numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" },
              horizontalAlignment: "CENTER",
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor,numberFormat,horizontalAlignment)",
        },
      },
      // Active subs count (col D, row 5) — number format, not currency
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 3, endColumnIndex: 4 },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: "NUMBER", pattern: "0" },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      // Column widths
      ...[180, 140, 140, 160, 140, 140].map((px, i) => ({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: px },
          fields: "pixelSize",
        },
      })),
    ];

    // Style section headers (find rows starting with all-caps labels)
    const sectionHeaderKeywords = [
      "MONTHLY SPENDING TREND",
      "SPENDING BY CATEGORY",
      "TOP MERCHANTS",
      "UPCOMING SUBSCRIPTION CHARGES",
      "NET WORTH HISTORY",
      "BUDGET STATUS (Current Month)",
      "RECURRING TRANSFERS SUMMARY",
      "FINANCIAL GOALS",
    ];
    for (let r = 0; r < rows.length; r++) {
      if (rows[r][0] && sectionHeaderKeywords.includes(rows[r][0])) {
        // Section title
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: 6 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, fontSize: 13, foregroundColor: { red: 0.15, green: 0.25, blue: 0.45 } },
                borders: {
                  bottom: { style: "SOLID", width: 2, color: { red: 0.2, green: 0.3, blue: 0.5 } },
                },
              },
            },
            fields: "userEnteredFormat(textFormat,borders)",
          },
        });
        // Column headers (row after section title)
        if (r + 1 < rows.length && rows[r + 1].length > 0) {
          requests.push({
            repeatCell: {
              range: { sheetId, startRowIndex: r + 1, endRowIndex: r + 2, startColumnIndex: 0, endColumnIndex: 6 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true, fontSize: 10 },
                  backgroundColor: { red: 0.9, green: 0.91, blue: 0.93 },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          });
        }
      }
    }

    // Currency formatting for all numerical data columns
    // Find rows with currency data and format column B
    for (let r = 0; r < rows.length; r++) {
      if (typeof rows[r][1] === "number") {
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 1, endColumnIndex: 2 },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" },
              },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        });
      }
      if (typeof rows[r][3] === "number") {
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 3, endColumnIndex: 4 },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" },
              },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        });
      }
    }

    // Budget conditional formatting: red for over-budget, yellow for 80%+
    if (budgetStartRow >= 0 && budgetData.length > 0) {
      requests.push(
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: budgetStartRow, endRowIndex: budgetStartRow + budgetData.length, startColumnIndex: 0, endColumnIndex: 4 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$B${budgetStartRow + 1}>=$C${budgetStartRow + 1}` }] },
                format: { backgroundColor: { red: 0.96, green: 0.85, blue: 0.85 } },
              },
            },
            index: 0,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: budgetStartRow, endRowIndex: budgetStartRow + budgetData.length, startColumnIndex: 0, endColumnIndex: 4 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=AND($B${budgetStartRow + 1}>=$C${budgetStartRow + 1}*0.8,$B${budgetStartRow + 1}<$C${budgetStartRow + 1})` }] },
                format: { backgroundColor: { red: 1, green: 0.96, blue: 0.85 } },
              },
            },
            index: 1,
          },
        }
      );
    }

    // Hide gridlines for cleaner look
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { hideGridlines: true } },
        fields: "gridProperties.hideGridlines",
      },
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  console.log("  Dashboard built.");
}

// ---------------------------------------------------------------------------
// Sync AI Insights History
// ---------------------------------------------------------------------------
async function syncInsights(sheets, pool) {
  console.log("Syncing AI insights to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT insight_text, model_used, tokens_used, created_at,
           input_tokens, output_tokens, cache_read_tokens
    FROM financial_insights
    WHERE insight_text NOT LIKE '[ML Categorization]%'
    ORDER BY created_at DESC
    LIMIT 20
  `);

  const SHEET_INSIGHTS = "AI Insights";
  await ensureSheet(sheets, SHEET_INSIGHTS);

  const headers = ["Date", "Model", "Tokens", "Insights"];
  const data = rows.map(r => [
    fmtDate(r.created_at),
    r.model_used || "",
    r.tokens_used || 0,
    (r.insight_text || "").substring(0, 5000),
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_INSIGHTS}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_INSIGHTS}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_INSIGHTS);
  if (sheetId !== null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
                  backgroundColor: { red: 0.35, green: 0.2, blue: 0.5 },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
          // Wrap text in insights column
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
              cell: {
                userEnteredFormat: { wrapStrategy: "WRAP" },
              },
              fields: "userEnteredFormat.wrapStrategy",
            },
          },
          // Set insights column width
          {
            updateDimensionProperties: {
              range: { sheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 },
              properties: { pixelSize: 600 },
              fields: "pixelSize",
            },
          },
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 3 },
            },
          },
        ],
      },
    });
  }

  console.log(`  ${rows.length} insights written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Recurring Transfers
// ---------------------------------------------------------------------------
async function syncRecurringTransfers(sheets, pool) {
  console.log("Syncing recurring transfers to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT display_name, amount, cadence_days,
           CASE
             WHEN cadence_days <= 10 THEN 'Weekly'
             WHEN cadence_days <= 20 THEN 'Bi-weekly'
             WHEN cadence_days <= 35 THEN 'Monthly'
             WHEN cadence_days <= 65 THEN 'Bi-monthly'
             WHEN cadence_days <= 95 THEN 'Quarterly'
             WHEN cadence_days <= 370 THEN 'Yearly'
             ELSE cadence_days || ' days'
           END AS cycle,
           ROUND(amount * (30.0 / GREATEST(cadence_days, 1)), 2) AS monthly_equivalent,
           transfer_type, direction, first_seen, last_transferred, next_expected,
           is_active, is_dismissed, notes
    FROM recurring_transfers
    ORDER BY
      CASE WHEN is_active AND NOT is_dismissed THEN 0 ELSE 1 END,
      amount DESC
  `);

  const SHEET_TRANSFERS = "Recurring Transfers";
  await ensureSheet(sheets, SHEET_TRANSFERS);

  const headers = [
    "Name", "Amount", "Cycle", "Monthly Equiv.", "Type", "Direction",
    "First Seen", "Last Transfer", "Next Expected", "Status", "Notes",
  ];

  const data = rows.map(r => {
    let status = "Active";
    if (r.is_dismissed) status = "Dismissed";
    else if (!r.is_active) status = "Inactive";
    return [
      r.display_name, fmtCurrency(r.amount), r.cycle,
      fmtCurrency(r.monthly_equivalent), r.transfer_type || "other",
      r.direction || "outgoing", fmtDate(r.first_seen),
      fmtDate(r.last_transferred), fmtDate(r.next_expected),
      status, r.notes || "",
    ];
  });

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TRANSFERS}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TRANSFERS}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_TRANSFERS);
  if (sheetId !== null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
                  backgroundColor: { red: 0.2, green: 0.35, blue: 0.45 },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
          ...[1, 3].map(col => ({
            repeatCell: {
              range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          })),
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 11 },
            },
          },
        ],
      },
    });
  }

  console.log(`  ${rows.length} recurring transfers written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Tax Deductions
// ---------------------------------------------------------------------------
async function syncTaxDeductions(sheets, pool) {
  console.log("Syncing tax deductions to Google Sheets...");

  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT merchant, amount, category, deduction_type, is_confirmed, notes, flagged_at
     FROM tax_deductions
     WHERE tax_year = $1
     ORDER BY amount DESC`,
    [year]
  );

  const SHEET_TAX = "Tax Deductions " + year;
  await ensureSheet(sheets, SHEET_TAX);

  const headers = ["Merchant", "Amount", "Category", "Type", "Confirmed", "Notes", "Flagged"];
  const total = rows.reduce((s, r) => s + parseFloat(r.amount), 0);
  const confirmed = rows.filter(r => r.is_confirmed);
  const confirmedTotal = confirmed.reduce((s, r) => s + parseFloat(r.amount), 0);

  const data = rows.map(r => [
    r.merchant, fmtCurrency(r.amount), r.category || "",
    r.deduction_type || "", r.is_confirmed ? "Yes" : "No",
    r.notes || "", fmtDate(r.flagged_at),
  ]);

  // Add summary row
  data.push([]);
  data.push(["TOTAL (all flagged)", total, "", "", "", "", ""]);
  data.push(["TOTAL (confirmed)", confirmedTotal, "", "", confirmed.length + " items", "", ""]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAX}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAX}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_TAX);
  if (sheetId !== null) {
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.4, green: 0.27, blue: 0.17 },
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 7 },
        },
      },
    ];

    // Highlight confirmed rows green
    if (rows.length > 0) {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 0, endColumnIndex: 7 }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$E2="Yes"` }] },
              format: { backgroundColor: { red: 0.88, green: 0.95, blue: 0.88 } },
            },
          },
          index: 0,
        },
      });
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  console.log(`  ${rows.length} tax deductions written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// API endpoint handler (called from server.js)
// ---------------------------------------------------------------------------
async function syncAll() {
  const sheets = await getSheetsClient();
  const pool = getPool();

  try {
    const txnCount = await syncTransactions(sheets, pool);
    const subs = await syncSubscriptions(sheets, pool);
    const insightsCount = await syncInsights(sheets, pool);
    const transfersCount = await syncRecurringTransfers(sheets, pool);
    const taxCount = await syncTaxDeductions(sheets, pool);
    await buildDashboard(sheets, pool);

    return {
      transactions_synced: txnCount,
      subscriptions_synced: subs.length,
      insights_synced: insightsCount,
      transfers_synced: transfersCount,
      tax_deductions_synced: taxCount,
      timestamp: new Date().toISOString(),
    };
  } finally {
    await pool.end();
  }
}

async function syncDashboardOnly() {
  const sheets = await getSheetsClient();
  const pool = getPool();

  try {
    await buildDashboard(sheets, pool);
    return { dashboard_rebuilt: true, timestamp: new Date().toISOString() };
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

  if (!SPREADSHEET_ID || !SERVICE_ACCOUNT_KEY_PATH) {
    console.error("Error: Set GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_KEY in .env");
    process.exit(1);
  }

  const dashboardOnly = process.argv.includes("--dashboard");
  const fn = dashboardOnly ? syncDashboardOnly : syncAll;

  fn()
    .then((result) => {
      console.log("Sync complete:", result);
    })
    .catch((err) => {
      console.error("Sync failed:", err);
      process.exit(1);
    });
}

module.exports = { syncAll, syncDashboardOnly };
