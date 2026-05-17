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

// #9: sheet protection. Adds a warning-only protection over the entire
// sheet so the user gets a confirmation prompt before editing (and isn't
// permanently locked out). Idempotent: removes any prior protection with
// the same marker description before adding fresh, so repeated syncs
// don't stack up duplicates.
const PROTECTION_DESCRIPTION = "Perfin sync — edits overwritten on next sync";
async function applyProtection(sheets, sheetId) {
  if (sheetId === null) return;
  // Find existing protections matching our description
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets(properties(sheetId),protectedRanges(protectedRangeId,description))",
  });
  const targetSheet = meta.data.sheets.find(s => s.properties.sheetId === sheetId);
  const existing = (targetSheet?.protectedRanges || [])
    .filter(p => p.description === PROTECTION_DESCRIPTION);
  const requests = [];
  for (const p of existing) {
    requests.push({ deleteProtectedRange: { protectedRangeId: p.protectedRangeId } });
  }
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId },
        description: PROTECTION_DESCRIPTION,
        warningOnly: true,
      },
    },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });
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

  // Transactions + their splits in one ordered set. Parent rows show normally;
  // child split rows are interleaved right after their parent with "↳ " prefix
  // on the merchant column. Sort key: (date DESC, parent_id, sort_within ASC)
  // so splits land immediately below their parent.
  const { rows } = await pool.query(`
    WITH base AS (
      SELECT
        t.date, t.transaction_id, t.amount,
        COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
        la.name AS account_name,
        la.type AS account_type,
        COALESCE(pi.institution_name, te.institution_name, 'CSV Import') AS institution_name,
        COALESCE(t.user_category, t.category[1]) AS category,
        t.user_category IS NOT NULL AS user_categorized,
        COALESCE(t.is_reimbursed, false) AS is_reimbursed,
        t.reimbursed_at,
        t.personal_finance_category->>'detailed' AS pfc_detailed
      FROM transactions t
      JOIN linked_accounts la ON la.account_id = t.account_id
      LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
      LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
      WHERE t.pending = false
    ),
    parents AS (
      SELECT
        date AS sort_date, transaction_id AS group_key, 0 AS sort_within,
        'parent' AS row_type, date, transaction_id, amount, merchant,
        account_name, account_type, institution_name, category, pfc_detailed,
        user_categorized, is_reimbursed, reimbursed_at
      FROM base
    ),
    split_rows AS (
      SELECT
        b.date AS sort_date, b.transaction_id AS group_key,
        ROW_NUMBER() OVER (PARTITION BY ts.parent_transaction_id ORDER BY ts.id) AS sort_within,
        'split' AS row_type, b.date, b.transaction_id, ts.amount,
        COALESCE(ts.merchant_name, b.merchant) AS merchant,
        b.account_name, b.account_type, b.institution_name,
        ts.category, NULL::text AS pfc_detailed,
        false AS user_categorized,
        b.is_reimbursed, b.reimbursed_at
      FROM transaction_splits ts
      JOIN base b ON b.transaction_id = ts.parent_transaction_id
    )
    SELECT * FROM parents
    UNION ALL
    SELECT * FROM split_rows
    ORDER BY sort_date DESC, group_key, sort_within
  `);

  await ensureSheet(sheets, SHEET_TRANSACTIONS);

  const headers = [
    "Date", "Merchant", "Amount", "Account", "Account Type",
    "Institution", "Category", "Category (Detailed)", "Source",
    "Reimbursed", "Reimbursed At", "Month",
  ];

  const data = rows.map((r) => [
    fmtDate(r.date),
    r.row_type === "split" ? "  ↳ " + (r.merchant || "") : (r.merchant || ""),
    fmtCurrency(r.amount),
    r.row_type === "split" ? "" : (r.account_name || ""),
    r.row_type === "split" ? "" : (r.account_type || ""),
    r.row_type === "split" ? "" : (r.institution_name || ""),
    r.category || "",
    r.pfc_detailed || "",
    r.row_type === "split" ? "split" : (r.user_categorized ? "user" : "auto"),
    r.is_reimbursed ? "Yes" : "",
    r.reimbursed_at ? fmtDate(r.reimbursed_at) : "",
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
    const requests = [
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
      // Auto-resize columns (12 columns)
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 12 },
        },
      },
      // Alternating row colors
      {
        addBanding: {
          bandedRange: {
            range: { sheetId, startRowIndex: 0, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 12 },
            rowProperties: {
              headerColor: { red: 0.2, green: 0.3, blue: 0.55 },
              firstBandColor: { red: 1, green: 1, blue: 1 },
              secondBandColor: { red: 0.94, green: 0.95, blue: 0.97 },
            },
          },
        },
      },
    ];

    // Conditional: shade split rows so the parent→child visual hierarchy
    // is obvious without indentation alone carrying the weight.
    if (data.length > 0) {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 12 }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$I2="split"` }] },
              format: {
                backgroundColor: { red: 0.97, green: 0.94, blue: 0.88 },
                textFormat: { italic: true, foregroundColor: { red: 0.35, green: 0.35, blue: 0.35 } },
              },
            },
          },
          index: 0,
        },
      });
      // Reimbursed rows get a green tint so "you got paid back for this"
      // pops in the historic view.
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 12 }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$J2="Yes"` }] },
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

  console.log(`  ${rows.length} transaction rows (incl. splits) written.`);
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
    "First Seen", "Last Charged", "Next Charge", "Days Until", "Status", "Source", "Notes",
  ];

  const data = rows.map((r, idx) => {
    let status = "Active";
    if (r.is_cancelled) status = "Cancelled";
    else if (r.is_dismissed) status = "Dismissed";
    else if (!r.is_active) status = "Inactive";

    // Days Until = Sheets formula referencing the Next Charge cell. Avoids
    // a server-side computation that would drift as soon as the user opens
    // the sheet on a different day. row index is 1-based in Sheets and we
    // need +2 (1 for the header row, 1 for 1-based indexing).
    const sheetRow = idx + 2;
    // Empty when Next Charge is blank (e.g. cancelled subs).
    const daysFormula = `=IF(H${sheetRow}="","", IFERROR(DATEVALUE(H${sheetRow}) - TODAY(),""))`;

    return [
      r.display_name,
      fmtCurrency(r.amount),
      r.cycle,
      fmtCurrency(r.monthly_cost),
      fmtCurrency(r.yearly_cost),
      fmtDate(r.first_seen),
      fmtDate(r.last_charged),
      fmtDate(r.next_expected),
      daysFormula,
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
      // Auto-resize (12 cols now — Days Until column inserted at idx 8)
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 12 },
        },
      },
      // Alternating rows
      {
        addBanding: {
          bandedRange: {
            range: { sheetId, startRowIndex: 0, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 12 },
            rowProperties: {
              headerColor: { red: 0.17, green: 0.37, blue: 0.27 },
              firstBandColor: { red: 1, green: 1, blue: 1 },
              secondBandColor: { red: 0.91, green: 0.96, blue: 0.92 },
            },
          },
        },
      },
    ];

    // Conditional formatting: red bg for "Cancelled", yellow for "Dismissed".
    // Status is now col J (idx 9) — was col I before Days Until was inserted.
    if (data.length > 0) {
      requests.push(
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 12 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$J2="Cancelled"` }] },
                format: { backgroundColor: { red: 0.96, green: 0.87, blue: 0.87 } },
              },
            },
            index: 0,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 12 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$J2="Dismissed"` }] },
                format: { backgroundColor: { red: 1, green: 0.96, blue: 0.87 } },
              },
            },
            index: 1,
          },
        },
        // Highlight imminent charges (next 7 days). Days Until = col I (idx 8).
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 8, endColumnIndex: 9 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=AND(ISNUMBER($I2), $I2>=0, $I2<=7)` }] },
                format: { backgroundColor: { red: 1, green: 0.93, blue: 0.78 }, textFormat: { bold: true } },
              },
            },
            index: 2,
          },
        }
      );
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
    // #9: warn-only protection on this sheet so accidental edits prompt
    // a confirmation. Sync still overwrites on next run.
    await applyProtection(sheets, sheetId);
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
      COALESCE(user_category, personal_finance_category->>'primary', category[1], 'Uncategorized') AS category,
      SUM(amount) AS total,
      COUNT(*) AS txn_count
    FROM transactions
    WHERE pending = false AND amount > 0
      AND date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY category
    ORDER BY total DESC
    LIMIT 15
  `);

  // Category × month pivot for sparklines + heatmap (#6, #7). One SUM
  // per (category, month) over the same 6-month window so the visible
  // category list's "Trend" column has data to graph.
  const { rows: categoryByMonth } = await pool.query(`
    SELECT
      COALESCE(user_category, personal_finance_category->>'primary', category[1], 'Uncategorized') AS category,
      TO_CHAR(date, 'YYYY-MM') AS month,
      SUM(amount) AS total
    FROM transactions
    WHERE pending = false AND amount > 0
      AND date >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY 1, 2
  `);
  // Build a {category: {month: total}} map for fast lookup, and the list
  // of months oldest-to-newest matching what we'll show as columns.
  const catMonthMap = {};
  for (const r of categoryByMonth) {
    if (!catMonthMap[r.category]) catMonthMap[r.category] = {};
    catMonthMap[r.category][r.month] = parseFloat(r.total);
  }
  const sparklineMonths = (monthlySummary || []).map(m => m.month).slice().reverse();

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
    LEFT JOIN transactions t ON COALESCE(t.user_category, t.category[1], 'Uncategorized') = b.category
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
  const now = new Date();
  const nowStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  // Day-of-week + relative phrasing make the freshness immediately
  // glanceable ("Synced Mon, May 17 at 8:42 AM"). Sheets users open the
  // dashboard sometimes hours/days after the last sync, so the absolute
  // timestamp is the most useful signal — a relative-time string would
  // drift the moment they open it.
  const friendlyTime = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const rows = [];

  // Title
  rows.push(["PERSONAL FINANCE DASHBOARD", "", "", "", "", ""]);
  rows.push([`Synced ${friendlyTime}  (server time: ${nowStr})`, "", "", "", "", ""]);
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

  // Category breakdown — now with per-month columns + sparkline trend.
  // Layout: Category | Total | Transactions | M-5 | M-4 | M-3 | M-2 | M-1 | M | Trend
  // sparklineMonths is oldest-to-newest so the trend reads left-to-right.
  const catStartRow = rows.length;
  const monthHeaderCols = sparklineMonths.length;       // typically 6
  const firstMonthCol = 3;                              // Category=0, Total=1, Txns=2, M-5=3
  const lastMonthCol  = firstMonthCol + monthHeaderCols - 1;
  const trendCol      = lastMonthCol + 1;
  rows.push(["SPENDING BY CATEGORY", ...Array(2 + monthHeaderCols).fill("")]);
  rows.push([
    "Category", "Total", "Transactions",
    ...sparklineMonths,
    "Trend",
  ]);
  const totalCatSpend = categorySummary.reduce((s, c) => s + parseFloat(c.total), 0);
  const catHeaderSheetRow = catStartRow + 2;            // 1-based sheet row of header
  for (let i = 0; i < categorySummary.length; i++) {
    const c = categorySummary[i];
    const sheetRow = catHeaderSheetRow + 1 + i;         // 1-based row of this data row
    const monthCells = sparklineMonths.map(m => {
      const v = catMonthMap[c.category]?.[m];
      return v === undefined ? 0 : v;
    });
    // Sparkline references the same row's month columns. We can compute
    // the column-letter range from indexes (firstMonthCol..lastMonthCol).
    const colLetter = (n) => String.fromCharCode(65 + n);  // 0->A, 3->D, etc.
    const sparkRange = `${colLetter(firstMonthCol)}${sheetRow}:${colLetter(lastMonthCol)}${sheetRow}`;
    const sparkline = `=SPARKLINE(${sparkRange}, {"charttype","line"; "linewidth",2; "color","#5a8f8f"})`;
    rows.push([
      c.category,
      fmtCurrency(c.total),
      parseInt(c.txn_count),
      ...monthCells,
      sparkline,
    ]);
  }
  // Record the data range so the formatting pass below can apply
  // currency formatting + heatmap conditional formatting to it.
  const catDataStartSheetRow = catHeaderSheetRow + 1;      // 1-based
  const catDataEndSheetRow   = catHeaderSheetRow + categorySummary.length;
  const catHeatmapFirstColIdx = firstMonthCol;             // 0-based
  const catHeatmapLastColIdx  = lastMonthCol;
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
              // #11: Last-synced line is now slightly more prominent
              // (sized up + teal) so freshness is glanceable.
              textFormat: {
                bold: true, italic: false, fontSize: 11,
                foregroundColor: { red: 0.16, green: 0.42, blue: 0.42 },
              },
              backgroundColor: { red: 0.94, green: 0.97, blue: 0.97 },
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
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

    // Category × month heatmap (#7): green-to-red color scale across the
    // per-month spending cells so high-spend cells visually pop. Skips
    // when no category data.
    if (categorySummary.length > 0 && monthHeaderCols > 0) {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{
              sheetId,
              // catDataStartSheetRow is 1-based; conditional ranges are 0-based
              startRowIndex: catDataStartSheetRow - 1,
              endRowIndex: catDataEndSheetRow,
              startColumnIndex: catHeatmapFirstColIdx,
              endColumnIndex: catHeatmapLastColIdx + 1,
            }],
            gradientRule: {
              minpoint: { color: { red: 0.91, green: 0.96, blue: 0.92 }, type: "MIN" },
              midpoint: { color: { red: 1.0,  green: 0.97, blue: 0.78 }, type: "PERCENTILE", value: "50" },
              maxpoint: { color: { red: 0.96, green: 0.80, blue: 0.78 }, type: "MAX" },
            },
          },
          index: 0,
        },
      });
      // Currency format on month columns
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: catDataStartSheetRow - 1,
            endRowIndex: catDataEndSheetRow,
            startColumnIndex: catHeatmapFirstColIdx,
            endColumnIndex: catHeatmapLastColIdx + 1,
          },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
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

  // Pull the structured running summary (S5: JSONB on user_settings) in
  // parallel with the insight rows. Both render into the AI Insights tab —
  // the summary as section sub-tables, insights as the main grid.
  const [insightsRes, settingsRes] = await Promise.all([
    pool.query(`
      SELECT id, insight_text, model_used, tokens_used, created_at,
             user_feedback, user_feedback_text, user_feedback_at
      FROM financial_insights
      WHERE entry_type = 'insight'
      ORDER BY created_at DESC
      LIMIT 20
    `),
    pool.query("SELECT insights_running_summary_json FROM user_settings WHERE id = 1"),
  ]);
  const rows = insightsRes.rows;
  let summary = settingsRes.rows[0]?.insights_running_summary_json;
  if (typeof summary === "string") {
    try { summary = JSON.parse(summary); } catch { summary = null; }
  }
  summary = summary || { trends: [], pending_actions: [], alerts: [], completed_goals: [] };

  const SHEET_INSIGHTS = "AI Insights";
  await ensureSheet(sheets, SHEET_INSIGHTS);

  const headers = ["Date", "Model", "Tokens", "Feedback", "Feedback Note", "Insight"];
  const data = rows.map(r => [
    fmtDate(r.created_at),
    r.model_used || "",
    r.tokens_used || 0,
    r.user_feedback || "",
    r.user_feedback_text || "",
    (r.insight_text || "").substring(0, 5000),
  ]);

  // Append the structured running summary as sub-tables AFTER the main grid.
  // Each section's data block is preceded by a section title + headers row.
  const allRows = [headers, ...data];
  allRows.push([]);
  allRows.push(["RUNNING SUMMARY (cumulative AI memory)", "", "", "", "", ""]);
  allRows.push([]);

  function section(title, columns, items, formatItem) {
    allRows.push([title, ...Array(columns.length - 1).fill("")]);
    allRows.push(columns);
    if (!items || items.length === 0) {
      allRows.push(["(none)", ...Array(columns.length - 1).fill("")]);
    } else {
      for (const it of items) allRows.push(formatItem(it));
    }
    allRows.push([]);
  }

  section("Trends", ["Category", "Direction", "Magnitude", "Since", "", ""],
    summary.trends || [],
    t => [t.category || "", t.direction || "", t.magnitude || "", t.since_when || "", "", ""]);

  section("Pending Actions", ["Description", "Urgency", "", "", "", ""],
    summary.pending_actions || [],
    a => [a.description || "", a.urgency || "", "", "", "", ""]);

  section("Active Alerts", ["Message", "Severity", "", "", "", ""],
    summary.alerts || [],
    a => [a.message || "", a.severity || "", "", "", "", ""]);

  section("Completed Goals", ["Goal", "Completed", "", "", "", ""],
    summary.completed_goals || [],
    g => [g.goal_name || "", g.completed_date || "", "", "", "", ""]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_INSIGHTS}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_INSIGHTS}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: allRows },
  });

  const sheetId = await getSheetId(sheets, SHEET_INSIGHTS);
  if (sheetId !== null) {
    const requests = [
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
      // Wrap text in Feedback Note (col E = idx 4) + Insight (col F = idx 5)
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 4, endColumnIndex: 6 },
          cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
          fields: "userEnteredFormat.wrapStrategy",
        },
      },
      // Insight column width
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 },
          properties: { pixelSize: 600 },
          fields: "pixelSize",
        },
      },
      // Feedback Note width
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 },
          properties: { pixelSize: 280 },
          fields: "pixelSize",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 4 },
        },
      },
    ];

    // Feedback row coloring (only over the insight grid, not the summary
    // section). Insight grid spans rows 1..data.length.
    if (data.length > 0) {
      for (const [fb, color] of [
        ["positive", { red: 0.88, green: 0.95, blue: 0.88 }],
        ["negative", { red: 0.95, green: 0.85, blue: 0.85 }],
        ["mixed",    { red: 0.98, green: 0.93, blue: 0.78 }],
      ]) {
        requests.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 0, endColumnIndex: 6 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$D2="${fb}"` }] },
                format: { backgroundColor: color },
              },
            },
            index: 0,
          },
        });
      }
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  console.log(`  ${rows.length} insights + structured running summary written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Utilities — dedicated tab consolidating auto-detected utility
// subscriptions AND user-entered manual_bills with category='utility'.
// Modeled after syncSubscriptions but narrower to the utility category so
// the user has a single sheet to consult for "what utility bills are
// coming up." Both sources land in one table with a `Source` column.
// ---------------------------------------------------------------------------
async function syncUtilities(sheets, pool) {
  console.log("Syncing utilities to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT
      'auto' AS source,
      display_name AS name,
      amount,
      CASE
        WHEN cadence_days <= 35 THEN 'Monthly'
        WHEN cadence_days <= 65 THEN 'Bi-monthly'
        WHEN cadence_days <= 95 THEN 'Quarterly'
        WHEN cadence_days <= 370 THEN 'Yearly'
        ELSE cadence_days || ' days'
      END AS cycle,
      CASE
        WHEN cadence_days > 0 THEN ROUND(amount * (30.0 / cadence_days), 2)
        ELSE amount
      END AS monthly_cost,
      CASE
        WHEN cadence_days > 0 THEN ROUND(amount * (365.0 / cadence_days), 2)
        ELSE amount * 12
      END AS yearly_cost,
      next_expected AS next_due,
      CASE
        WHEN cancelled_at IS NOT NULL THEN 'Cancelled'
        WHEN is_dismissed THEN 'Dismissed'
        WHEN NOT is_active THEN 'Inactive'
        ELSE 'Active'
      END AS status,
      notes
    FROM detected_subscriptions
    WHERE category = 'utility'

    UNION ALL

    SELECT
      'manual' AS source,
      name,
      amount,
      CASE cadence
        WHEN 'monthly' THEN 'Monthly'
        WHEN 'quarterly' THEN 'Quarterly'
        WHEN 'yearly' THEN 'Yearly'
        ELSE cadence
      END AS cycle,
      CASE cadence
        WHEN 'monthly' THEN amount
        WHEN 'quarterly' THEN ROUND(amount / 3.0, 2)
        WHEN 'yearly' THEN ROUND(amount / 12.0, 2)
        ELSE amount
      END AS monthly_cost,
      CASE cadence
        WHEN 'monthly' THEN amount * 12
        WHEN 'quarterly' THEN amount * 4
        WHEN 'yearly' THEN amount
        ELSE amount * 12
      END AS yearly_cost,
      -- next_due for manual bills: due_day in the current or next month based
      -- on whether today has passed the due_day. Sheets users want a date,
      -- not just a day number.
      CASE
        WHEN due_day >= EXTRACT(DAY FROM CURRENT_DATE)::int THEN
          make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, EXTRACT(MONTH FROM CURRENT_DATE)::int,
                    LEAST(due_day, EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'))::int))
        ELSE
          make_date(
            EXTRACT(YEAR FROM CURRENT_DATE + INTERVAL '1 month')::int,
            EXTRACT(MONTH FROM CURRENT_DATE + INTERVAL '1 month')::int,
            LEAST(due_day, EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE + INTERVAL '1 month') + INTERVAL '1 month - 1 day'))::int)
          )
      END AS next_due,
      CASE WHEN is_active THEN 'Active' ELSE 'Inactive' END AS status,
      notes
    FROM manual_bills
    WHERE category = 'utility'

    ORDER BY
      CASE WHEN status = 'Active' THEN 0 ELSE 1 END,
      next_due NULLS LAST
  `);

  const SHEET_UTILITIES = "Utilities";
  await ensureSheet(sheets, SHEET_UTILITIES);

  const headers = [
    "Name", "Amount", "Cycle", "Monthly Cost", "Yearly Cost",
    "Next Due", "Source", "Status", "Notes",
  ];

  const data = rows.map((r) => [
    r.name,
    fmtCurrency(r.amount),
    r.cycle,
    fmtCurrency(r.monthly_cost),
    fmtCurrency(r.yearly_cost),
    fmtDate(r.next_due),
    r.source === "auto" ? "Auto-detected" : "Manual",
    r.status,
    r.notes || "",
  ]);

  // Roll-up summary row at the bottom for at-a-glance totals.
  let monthlyTotal = 0, yearlyTotal = 0;
  for (const r of rows) {
    if (r.status === "Active") {
      monthlyTotal += parseFloat(r.monthly_cost) || 0;
      yearlyTotal += parseFloat(r.yearly_cost) || 0;
    }
  }
  if (data.length > 0) {
    data.push([]);
    data.push([
      "TOTAL (Active)",
      "",
      "",
      fmtCurrency(monthlyTotal),
      fmtCurrency(yearlyTotal),
      "",
      "",
      `${rows.filter(r => r.status === "Active").length} active`,
      "",
    ]);
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_UTILITIES}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_UTILITIES}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_UTILITIES);
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
                  backgroundColor: { red: 0.32, green: 0.55, blue: 0.55 },
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
          // Currency formatting for Amount, Monthly Cost, Yearly Cost columns
          ...[1, 3, 4].map(col => ({
            repeatCell: {
              range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          })),
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 9 },
            },
          },
        ],
      },
    });
  }

  console.log(`Synced ${rows.length} utilities to Google Sheets`);
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
    // #9: warn-only protection
    await applyProtection(sheets, sheetId);
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
    // #9: warn-only protection
    await applyProtection(sheets, sheetId);
  }

  console.log(`  ${rows.length} tax deductions written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Investments — Plaid holdings (qty, cost basis, current value, return)
// ---------------------------------------------------------------------------
// Joins investment_holdings to investment_accounts so each row shows which
// account holds the security. Computes return $ and return % per row.
// Only Plaid-linked holdings have cost basis; Teller-linked investment
// accounts (brokerage / IRA at the account level) don't expose per-security
// data via the Teller API and don't appear here.
async function syncInvestments(sheets, pool) {
  console.log("Syncing investments to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT h.ticker, h.name, h.security_type, h.quantity, h.cost_basis,
           h.current_value, ia.name AS account_name, ia.institution
    FROM investment_holdings h
    LEFT JOIN investment_accounts ia ON ia.plaid_account_id = h.plaid_account_id
    WHERE COALESCE(ia.is_active, true) = true
    ORDER BY h.current_value DESC
  `);

  const SHEET_INVESTMENTS = "Investments";
  await ensureSheet(sheets, SHEET_INVESTMENTS);

  const headers = [
    "Ticker", "Name", "Type", "Account", "Institution",
    "Quantity", "Cost Basis", "Current Value", "Return $", "Return %",
  ];

  let totalValue = 0, totalCost = 0;
  const data = rows.map(r => {
    const value = parseFloat(r.current_value || 0);
    const cost = parseFloat(r.cost_basis || 0);
    const ret = value - cost;
    const retPct = cost > 0 ? (ret / cost) * 100 : null;
    totalValue += value;
    totalCost += cost;
    return [
      r.ticker || "",
      r.name || "",
      r.security_type || "",
      r.account_name || "",
      r.institution || "",
      parseFloat(r.quantity || 0),
      fmtCurrency(cost),
      fmtCurrency(value),
      fmtCurrency(ret),
      retPct === null ? "" : retPct.toFixed(2) + "%",
    ];
  });

  // Total row
  const totalRet = totalValue - totalCost;
  const totalRetPct = totalCost > 0 ? (totalRet / totalCost) * 100 : null;
  data.push([]);
  data.push([
    "TOTAL", "", "", "", "", "",
    fmtCurrency(totalCost),
    fmtCurrency(totalValue),
    fmtCurrency(totalRet),
    totalRetPct === null ? "" : totalRetPct.toFixed(2) + "%",
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_INVESTMENTS}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_INVESTMENTS}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_INVESTMENTS);
  if (sheetId !== null) {
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.13, green: 0.40, blue: 0.40 },
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
      // Cost / Value / Return $ columns (G-I = 6-8) as currency
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 6, endColumnIndex: 9 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 10 },
        },
      },
    ];
    // Color returns: green positive, red negative (Return $ column = col I = index 8)
    if (rows.length > 0) {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 8, endColumnIndex: 9 }],
            booleanRule: {
              condition: { type: "NUMBER_GREATER", values: [{ userEnteredValue: "0" }] },
              format: { textFormat: { foregroundColor: { red: 0.0, green: 0.5, blue: 0.0 } } },
            },
          },
          index: 0,
        },
      });
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 8, endColumnIndex: 9 }],
            booleanRule: {
              condition: { type: "NUMBER_LESS", values: [{ userEnteredValue: "0" }] },
              format: { textFormat: { foregroundColor: { red: 0.7, green: 0.0, blue: 0.0 } } },
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

  console.log(`  ${rows.length} holdings written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Net Worth History (monthly aggregation)
// ---------------------------------------------------------------------------
// One row per month showing the last snapshot of that month — gives a clean
// monthly trajectory without daily noise. The dashboard already has its own
// daily-grain history chart, so this complements rather than duplicates.
async function syncNetWorthHistory(sheets, pool) {
  console.log("Syncing net worth history to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT TO_CHAR(snapshot_date, 'YYYY-MM') AS month,
           total_assets, total_liabilities, net_worth, snapshot_date
    FROM (
      SELECT DISTINCT ON (TO_CHAR(snapshot_date, 'YYYY-MM'))
             snapshot_date, total_assets, total_liabilities, net_worth
      FROM net_worth_snapshots
      ORDER BY TO_CHAR(snapshot_date, 'YYYY-MM'), snapshot_date DESC
    ) latest_per_month
    ORDER BY snapshot_date DESC
  `);

  const SHEET_NWH = "Net Worth History";
  await ensureSheet(sheets, SHEET_NWH);

  const headers = ["Month", "Net Worth", "Total Assets", "Total Liabilities", "Snapshot Date", "Change vs Prior Month"];

  // Build rows oldest-to-newest first so we can compute month-over-month delta,
  // then reverse for display so the latest month is at the top.
  const oldestFirst = rows.slice().reverse();
  const enriched = oldestFirst.map((r, i) => {
    const prior = oldestFirst[i - 1];
    const delta = prior ? parseFloat(r.net_worth) - parseFloat(prior.net_worth) : null;
    return {
      month: r.month,
      net_worth: parseFloat(r.net_worth),
      total_assets: parseFloat(r.total_assets),
      total_liabilities: parseFloat(r.total_liabilities),
      snapshot_date: r.snapshot_date,
      delta,
    };
  }).reverse();

  const data = enriched.map(r => [
    r.month,
    fmtCurrency(r.net_worth),
    fmtCurrency(r.total_assets),
    fmtCurrency(r.total_liabilities),
    fmtDate(r.snapshot_date),
    r.delta === null ? "" : fmtCurrency(r.delta),
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NWH}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NWH}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_NWH);
  if (sheetId !== null) {
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.20, green: 0.40, blue: 0.30 },
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
          range: { sheetId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 4 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00;[Red]-$#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 6 },
        },
      },
    ];
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  console.log(`  ${rows.length} months of net worth history written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Income — monthly aggregate using the canonical INCOME_PREDICATE
// ---------------------------------------------------------------------------
// Uses the same income-detection rules the dashboard / savings-rate /
// cash-flow surfaces use (services/financial-queries.js). Inlines the
// predicate so this script stays a pure script (doesn't pull in the
// teller route layer).
async function syncIncome(sheets, pool) {
  console.log("Syncing income summary to Google Sheets...");

  const INCOME_PREDICATE = `
    (
      (COALESCE(merchant_name, name, '') ~* '\\y(payroll|direct dep|direct deposit|dir dep|salary|employer|deposit|ach credit)\\y'
        AND COALESCE(merchant_name, name, '') !~* '\\y(payment|transfer|pymt|zelle|venmo|paypal|cash app|refund|reversal|atm|withdrawal|bill pay)\\y')
      OR (
        COALESCE(merchant_name, name, '') ~* 'funds transfer from brokerage'
        AND NOT EXISTS (
          SELECT 1 FROM transactions __t2
          WHERE __t2.account_id <> account_id
            AND __t2.amount = ABS(amount)
            AND __t2.pending = false
            AND __t2.date BETWEEN date - INTERVAL '2 days' AND date + INTERVAL '2 days'
        )
      )
      OR COALESCE(user_category, category[1]) = 'Income'
    )
  `;

  // Monthly totals (last 24 months)
  const monthly = await pool.query(`
    SELECT TO_CHAR(date, 'YYYY-MM') AS month,
           SUM(ABS(amount)) AS total,
           COUNT(*) AS deposits
    FROM transactions
    WHERE pending = false
      AND date >= CURRENT_DATE - INTERVAL '24 months'
      AND amount < 0
      AND ${INCOME_PREDICATE}
    GROUP BY TO_CHAR(date, 'YYYY-MM')
    ORDER BY month DESC
  `);

  // Top sources (last 12 months) — group by merchant
  const sources = await pool.query(`
    SELECT COALESCE(merchant_name, name) AS source,
           SUM(ABS(amount)) AS total,
           COUNT(*) AS deposits,
           MAX(date) AS most_recent
    FROM transactions
    WHERE pending = false
      AND date >= CURRENT_DATE - INTERVAL '12 months'
      AND amount < 0
      AND ${INCOME_PREDICATE}
    GROUP BY COALESCE(merchant_name, name)
    ORDER BY total DESC
    LIMIT 50
  `);

  const SHEET_INCOME = "Income";
  await ensureSheet(sheets, SHEET_INCOME);

  // Layout: monthly table on top, then a blank row, then top-sources table.
  const headers1 = ["Month", "Total Income", "# Deposits"];
  const monthlyData = monthly.rows.map(r => [
    r.month, fmtCurrency(r.total), parseInt(r.deposits, 10),
  ]);
  // Section break
  const sep = ["", "", ""];
  const sectionTitle = ["TOP SOURCES (LAST 12 MONTHS)", "", ""];
  const headers2 = ["Source", "Total", "# Deposits"];
  const sourcesData = sources.rows.map(r => [
    r.source || "(unknown)",
    fmtCurrency(r.total),
    parseInt(r.deposits, 10),
  ]);

  const allRows = [
    headers1,
    ...monthlyData,
    sep,
    sectionTitle,
    headers2,
    ...sourcesData,
  ];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_INCOME}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_INCOME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: allRows },
  });

  const sheetId = await getSheetId(sheets, SHEET_INCOME);
  if (sheetId !== null) {
    const sourcesHeaderRow = 1 + monthlyData.length + 2 + 1;  // 1-indexed display row of headers2
    const requests = [
      // Monthly header (row 0)
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.27, green: 0.56, blue: 0.36 },
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
      // Sources header
      {
        repeatCell: {
          range: { sheetId, startRowIndex: sourcesHeaderRow - 1, endRowIndex: sourcesHeaderRow },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.27, green: 0.56, blue: 0.36 },
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
      // Section title row (bold but no fill)
      {
        repeatCell: {
          range: { sheetId, startRowIndex: sourcesHeaderRow - 2, endRowIndex: sourcesHeaderRow - 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } },
          fields: "userEnteredFormat.textFormat",
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      // Currency formatting for Total columns (col B = idx 1) across both tables
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 3 },
        },
      },
    ];
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  console.log(`  ${monthly.rows.length} months + ${sources.rows.length} sources written.`);
  return monthly.rows.length + sources.rows.length;
}

// ---------------------------------------------------------------------------
// Sync AI Trust Signals — audit findings + user feedback ratings
// ---------------------------------------------------------------------------
// Two tables in one sheet: most-recent audit findings (with severity / claim /
// expected / actual), and per-insight user feedback ratings + notes.
async function syncAiTrust(sheets, pool) {
  console.log("Syncing AI trust signals to Google Sheets...");

  const [findings, ratings] = await Promise.all([
    pool.query(`
      SELECT al.created_at, al.severity, al.module, al.check_type,
             al.claim_text, al.expected_value, al.actual_value,
             fi.created_at AS insight_date
      FROM ai_audit_log al
      LEFT JOIN financial_insights fi ON fi.id = al.insight_id
      ORDER BY al.created_at DESC
      LIMIT 100
    `),
    pool.query(`
      SELECT id, created_at, user_feedback, user_feedback_text, user_feedback_at,
             SUBSTRING(insight_text, 1, 200) AS preview
      FROM financial_insights
      WHERE entry_type = 'insight' AND user_feedback IS NOT NULL
      ORDER BY user_feedback_at DESC NULLS LAST
      LIMIT 50
    `),
  ]);

  const SHEET_TRUST = "AI Trust";
  await ensureSheet(sheets, SHEET_TRUST);

  const findingsHeaders = ["Audit Date", "Severity", "Module", "Check Type", "Claim", "Expected", "Actual", "Insight Date"];
  const findingsRows = findings.rows.map(r => [
    fmtDate(r.created_at),
    r.severity || "",
    r.module || "",
    r.check_type || "",
    r.claim_text || "",
    r.expected_value || "",
    r.actual_value || "",
    r.insight_date ? fmtDate(r.insight_date) : "",
  ]);

  const ratingsHeaders = ["Rated At", "Feedback", "Note", "Insight Preview"];
  const ratingsRows = ratings.rows.map(r => [
    fmtDate(r.user_feedback_at || r.created_at),
    r.user_feedback || "",
    r.user_feedback_text || "",
    (r.preview || "").replace(/\n/g, " ") + (r.preview && r.preview.length === 200 ? "…" : ""),
  ]);

  const sep = ["", "", "", "", "", "", "", ""];
  const sectionTitle = ["USER FEEDBACK ON INSIGHTS", "", "", "", "", "", "", ""];

  const allRows = [
    findingsHeaders,
    ...findingsRows,
    sep,
    sectionTitle,
    ratingsHeaders.concat(["", "", "", ""]),
    ...ratingsRows.map(r => r.concat(["", "", "", ""])),
  ];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TRUST}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TRUST}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: allRows },
  });

  const sheetId = await getSheetId(sheets, SHEET_TRUST);
  if (sheetId !== null) {
    const ratingsHeaderRow = 1 + findingsRows.length + 2 + 1;
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.45, green: 0.30, blue: 0.55 },
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: ratingsHeaderRow - 1, endRowIndex: ratingsHeaderRow },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.45, green: 0.30, blue: 0.55 },
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: ratingsHeaderRow - 2, endRowIndex: ratingsHeaderRow - 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } },
          fields: "userEnteredFormat.textFormat",
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 8 },
        },
      },
    ];

    // Color severity rows
    if (findingsRows.length > 0) {
      for (const [sev, color] of [
        ["critical", { red: 0.95, green: 0.85, blue: 0.85 }],
        ["warning",  { red: 0.98, green: 0.93, blue: 0.78 }],
        ["info",     { red: 0.88, green: 0.92, blue: 0.95 }],
      ]) {
        requests.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: findingsRows.length + 1, startColumnIndex: 0, endColumnIndex: 8 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$B2="${sev}"` }] },
                format: { backgroundColor: color },
              },
            },
            index: 0,
          },
        });
      }
    }
    // Color feedback rows
    if (ratingsRows.length > 0) {
      for (const [fb, color] of [
        ["positive", { red: 0.88, green: 0.95, blue: 0.88 }],
        ["negative", { red: 0.95, green: 0.85, blue: 0.85 }],
        ["mixed",    { red: 0.98, green: 0.93, blue: 0.78 }],
      ]) {
        requests.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: ratingsHeaderRow, endRowIndex: ratingsHeaderRow + ratingsRows.length, startColumnIndex: 0, endColumnIndex: 4 }],
              booleanRule: {
                condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$B${ratingsHeaderRow + 1}="${fb}"` }] },
                format: { backgroundColor: color },
              },
            },
            index: 0,
          },
        });
      }
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  console.log(`  ${findings.rows.length} findings + ${ratings.rows.length} ratings written.`);
  return findings.rows.length + ratings.rows.length;
}

// ---------------------------------------------------------------------------
// Sync Categorization Rules — user-curated merchant→category map
// ---------------------------------------------------------------------------
async function syncCategorizationRules(sheets, pool) {
  console.log("Syncing categorization rules to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT merchant_pattern, category, match_type, is_active, times_applied, created_at
    FROM categorization_rules
    ORDER BY times_applied DESC, merchant_pattern
  `);

  const SHEET_RULES = "Categorization Rules";
  await ensureSheet(sheets, SHEET_RULES);

  const headers = ["Merchant Pattern", "Category", "Match Type", "Active", "Times Applied", "Created"];
  const data = rows.map(r => [
    r.merchant_pattern || "",
    r.category || "",
    r.match_type || "",
    r.is_active ? "Yes" : "No",
    parseInt(r.times_applied || 0, 10),
    fmtDate(r.created_at),
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_RULES}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_RULES}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_RULES);
  if (sheetId !== null) {
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.42, green: 0.35, blue: 0.20 },
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
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 6 },
        },
      },
    ];
    if (rows.length > 0) {
      // Grey out inactive rules
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 0, endColumnIndex: 6 }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$D2="No"` }] },
              format: { backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 }, textFormat: { foregroundColor: { red: 0.5, green: 0.5, blue: 0.5 } } },
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

  console.log(`  ${rows.length} categorization rules written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Manual Bills — all categories (Utilities tab only shows utility ones)
// ---------------------------------------------------------------------------
async function syncManualBills(sheets, pool) {
  console.log("Syncing manual bills to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT name, amount, due_day, cadence, category, is_active, notes, created_at
    FROM manual_bills
    ORDER BY is_active DESC, category, amount DESC
  `);

  const SHEET_BILLS = "Manual Bills";
  await ensureSheet(sheets, SHEET_BILLS);

  const headers = ["Name", "Amount", "Cadence", "Due Day", "Category", "Active", "Notes", "Created"];
  const data = rows.map(r => [
    r.name || "",
    fmtCurrency(r.amount),
    r.cadence || "",
    parseInt(r.due_day || 1, 10),
    r.category || "",
    r.is_active ? "Yes" : "No",
    r.notes || "",
    fmtDate(r.created_at),
  ]);

  // Monthly-equivalent total row (treats quarterly as /3, yearly as /12)
  let monthlyEq = 0;
  for (const r of rows) {
    if (!r.is_active) continue;
    const amt = parseFloat(r.amount || 0);
    if (r.cadence === "monthly") monthlyEq += amt;
    else if (r.cadence === "quarterly") monthlyEq += amt / 3;
    else if (r.cadence === "yearly") monthlyEq += amt / 12;
  }
  data.push([]);
  data.push(["TOTAL active (monthly equivalent)", monthlyEq, "", "", "", "", "", ""]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_BILLS}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_BILLS}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_BILLS);
  if (sheetId !== null) {
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.30, green: 0.35, blue: 0.55 },
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
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 8 },
        },
      },
    ];
    if (rows.length > 0) {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 0, endColumnIndex: 8 }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$F2="No"` }] },
              format: { backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 }, textFormat: { foregroundColor: { red: 0.5, green: 0.5, blue: 0.5 } } },
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

  console.log(`  ${rows.length} manual bills written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Bill Payments Log — audit trail of every paid bill
// ---------------------------------------------------------------------------
// `bill_payments.bill_source` is 'subscription' or 'manual'; join to whichever
// applies so the log shows the bill's display name regardless of source.
async function syncBillPayments(sheets, pool) {
  console.log("Syncing bill payments log to Google Sheets...");

  const { rows } = await pool.query(`
    SELECT bp.bill_source,
           bp.bill_id,
           bp.paid_date,
           bp.paid_amount,
           bp.notes,
           bp.created_at,
           COALESCE(ds.display_name, mb.name) AS bill_name,
           COALESCE(ds.amount,       mb.amount) AS expected_amount,
           COALESCE(ds.category,     mb.category) AS category
    FROM bill_payments bp
    LEFT JOIN detected_subscriptions ds ON bp.bill_source = 'subscription' AND ds.id = bp.bill_id
    LEFT JOIN manual_bills           mb ON bp.bill_source = 'manual'       AND mb.id = bp.bill_id
    ORDER BY bp.paid_date DESC, bp.created_at DESC
  `);

  const SHEET_PAYMENTS = "Bill Payments Log";
  await ensureSheet(sheets, SHEET_PAYMENTS);

  const headers = ["Paid Date", "Bill", "Source", "Category", "Paid Amount", "Expected Amount", "Variance", "Notes", "Logged"];
  const data = rows.map(r => {
    const paid = parseFloat(r.paid_amount || 0);
    const expected = parseFloat(r.expected_amount || 0);
    const variance = paid - expected;
    return [
      fmtDate(r.paid_date),
      r.bill_name || "(unknown bill)",
      r.bill_source || "",
      r.category || "",
      fmtCurrency(paid),
      expected > 0 ? fmtCurrency(expected) : "",
      expected > 0 ? fmtCurrency(variance) : "",
      r.notes || "",
      fmtDate(r.created_at),
    ];
  });

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_PAYMENTS}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_PAYMENTS}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_PAYMENTS);
  if (sheetId !== null) {
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.35, green: 0.50, blue: 0.30 },
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
      // Currency columns (Paid E=4, Expected F=5, Variance G=6)
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 4, endColumnIndex: 7 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00;[Red]-$#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 9 },
        },
      },
    ];
    // Highlight large variances (>10% of expected)
    if (rows.length > 0) {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 6, endColumnIndex: 7 }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=AND(ISNUMBER($F2), $F2>0, ABS($G2/$F2)>0.10)` }] },
              format: { backgroundColor: { red: 0.98, green: 0.93, blue: 0.78 } },
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

  console.log(`  ${rows.length} bill payments written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Important Dates — combined upcoming-events view
// ---------------------------------------------------------------------------
// UNIONs four sources of upcoming dates into one sortable tab:
//   - detected_subscriptions.next_expected
//   - manual_bills (computed next-due from due_day + cadence)
//   - recurring_transfers (last_seen + cadence_days)
//   - financial_goals.target_date
// Scoped to the next 90 days so the tab stays glanceable. Sorted by date
// ASC so the top of the sheet shows what's happening soonest.
async function syncImportantDates(sheets, pool) {
  console.log("Syncing important dates to Google Sheets...");

  const { rows } = await pool.query(`
    WITH subs AS (
      SELECT next_expected AS event_date,
             'Subscription' AS event_type,
             display_name AS name,
             amount,
             cadence_days || '-day cycle' AS notes
      FROM detected_subscriptions
      WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
        AND next_expected IS NOT NULL
        AND next_expected <= CURRENT_DATE + INTERVAL '90 days'
    ),
    manual AS (
      SELECT
        make_date(
          CASE WHEN EXTRACT(DAY FROM CURRENT_DATE)::int > LEAST(due_day, 28)
               THEN EXTRACT(YEAR FROM (CURRENT_DATE + INTERVAL '1 month'))::int
               ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int END,
          CASE WHEN EXTRACT(DAY FROM CURRENT_DATE)::int > LEAST(due_day, 28)
               THEN EXTRACT(MONTH FROM (CURRENT_DATE + INTERVAL '1 month'))::int
               ELSE EXTRACT(MONTH FROM CURRENT_DATE)::int END,
          LEAST(due_day, 28)
        ) AS event_date,
        'Manual Bill (' || category || ')' AS event_type,
        name,
        amount,
        cadence AS notes
      FROM manual_bills
      WHERE is_active = true
    ),
    transfers AS (
      SELECT
        (last_seen + (cadence_days || ' days')::interval)::date AS event_date,
        'Transfer (' || transfer_type || ')' AS event_type,
        display_name AS name,
        amount,
        direction AS notes
      FROM recurring_transfers
      WHERE is_active = true AND is_dismissed = false
        AND last_seen IS NOT NULL
        AND (last_seen + (cadence_days || ' days')::interval)::date <= CURRENT_DATE + INTERVAL '90 days'
        AND (last_seen + (cadence_days || ' days')::interval)::date >= CURRENT_DATE
    ),
    goals AS (
      SELECT target_date AS event_date,
             'Goal Target' AS event_type,
             name,
             target_amount AS amount,
             type AS notes
      FROM financial_goals
      WHERE is_active = true
        AND target_date IS NOT NULL
        AND target_date <= CURRENT_DATE + INTERVAL '90 days'
        AND target_date >= CURRENT_DATE
    )
    SELECT * FROM subs
    UNION ALL SELECT * FROM manual
    UNION ALL SELECT * FROM transfers
    UNION ALL SELECT * FROM goals
    ORDER BY event_date ASC, event_type, name
  `);

  const SHEET_DATES = "Important Dates";
  await ensureSheet(sheets, SHEET_DATES);

  const headers = ["Date", "Days Away", "Type", "Name", "Amount", "Notes"];
  const data = rows.map((r, i) => {
    const sheetRow = i + 2;
    // Days Away = formula so the countdown stays current when the user
    // opens the sheet on a later date.
    const daysFormula = `=IF(A${sheetRow}="","", IFERROR(DATEVALUE(A${sheetRow}) - TODAY(),""))`;
    return [
      fmtDate(r.event_date),
      daysFormula,
      r.event_type,
      r.name,
      fmtCurrency(r.amount),
      r.notes || "",
    ];
  });

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DATES}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_DATES}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...data] },
  });

  const sheetId = await getSheetId(sheets, SHEET_DATES);
  if (sheetId !== null) {
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.55, green: 0.35, blue: 0.20 },
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
      // Currency on Amount (col E = idx 4)
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 4, endColumnIndex: 5 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 6 },
        },
      },
    ];
    if (data.length > 0) {
      // Highlight imminent events (next 7 days) amber; today red.
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 1, endColumnIndex: 2 }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=AND(ISNUMBER($B2), $B2=0)` }] },
              format: { backgroundColor: { red: 0.96, green: 0.80, blue: 0.78 }, textFormat: { bold: true } },
            },
          },
          index: 0,
        },
      });
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: data.length + 1, startColumnIndex: 1, endColumnIndex: 2 }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=AND(ISNUMBER($B2), $B2>0, $B2<=7)` }] },
              format: { backgroundColor: { red: 1, green: 0.93, blue: 0.78 }, textFormat: { bold: true } },
            },
          },
          index: 1,
        },
      });
    }
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  console.log(`  ${rows.length} important dates written.`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync Per-Month Archive — immutable monthly snapshots of transactions
// ---------------------------------------------------------------------------
// Once a month is complete (not the current month), copy its transactions
// into a dedicated tab named "YYYY-MM Transactions" that subsequent syncs
// never touch. Provides a permanent audit trail per month: useful for
// disputes, taxes, or "what was this charge in March 2024?" lookups.
// Idempotent: checks for existing tab before creating.
async function syncMonthArchives(sheets, pool) {
  console.log("Checking month archives...");

  // List months with transactions, excluding the current month (still
  // in flight). Older-first so newer archives appear leftmost in the
  // sheet tab bar.
  const { rows: months } = await pool.query(`
    SELECT DISTINCT TO_CHAR(date, 'YYYY-MM') AS month
    FROM transactions
    WHERE pending = false
      AND TO_CHAR(date, 'YYYY-MM') < TO_CHAR(CURRENT_DATE, 'YYYY-MM')
    ORDER BY month ASC
  `);

  if (months.length === 0) {
    console.log("  no archivable months yet.");
    return 0;
  }

  // Read existing tab names once so we don't `spreadsheets.get` per month.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets(properties(title))",
  });
  const existingTitles = new Set(meta.data.sheets.map(s => s.properties.title));

  let archivesCreated = 0;
  for (const { month } of months) {
    const title = `${month} Transactions`;
    if (existingTitles.has(title)) continue;

    const { rows } = await pool.query(`
      SELECT
        t.date,
        COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
        t.amount,
        la.name AS account_name,
        COALESCE(pi.institution_name, te.institution_name, 'CSV Import') AS institution_name,
        COALESCE(t.user_category, t.category[1]) AS category,
        COALESCE(t.is_reimbursed, false) AS is_reimbursed,
        t.user_notes,
        t.transaction_id
      FROM transactions t
      JOIN linked_accounts la ON la.account_id = t.account_id
      LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
      LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
      WHERE t.pending = false AND TO_CHAR(t.date, 'YYYY-MM') = $1
      ORDER BY t.date DESC, t.merchant_name
    `, [month]);

    if (rows.length === 0) continue;

    await ensureSheet(sheets, title);
    const sheetId = await getSheetId(sheets, title);

    const headers = ["Date", "Merchant", "Amount", "Account", "Institution", "Category", "Reimbursed", "Notes", "Transaction ID"];
    const data = rows.map(r => [
      fmtDate(r.date),
      r.merchant || "",
      fmtCurrency(r.amount),
      r.account_name || "",
      r.institution_name || "",
      r.category || "",
      r.is_reimbursed ? "Yes" : "",
      r.user_notes || "",
      r.transaction_id || "",
    ]);
    const total = rows.reduce((s, r) => s + parseFloat(r.amount), 0);
    data.push([]);
    data.push(["TOTAL", "", total, "", "", "", "", "", ""]);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${title}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [headers, ...data] },
    });

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
                    backgroundColor: { red: 0.30, green: 0.30, blue: 0.30 },
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
                range: { sheetId, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 },
                cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
                fields: "userEnteredFormat.numberFormat",
              },
            },
            {
              autoResizeDimensions: {
                dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 9 },
              },
            },
          ],
        },
      });
      // Archive tabs are immutable — protect them with the marker
      // description so a subsequent month doesn't accidentally pick the
      // wrong tab to overwrite.
      await applyProtection(sheets, sheetId);
    }

    console.log(`  created archive '${title}' with ${rows.length} transactions.`);
    archivesCreated++;
  }

  if (archivesCreated === 0) console.log("  all months already archived.");
  return archivesCreated;
}

// ---------------------------------------------------------------------------
// Sync Watchlist — user-curated merchant/category/keyword monitoring
// ---------------------------------------------------------------------------
// Pulls watchlist_items (the user adds entries via Settings → Watchlist)
// and renders one row per matching transaction in the last 90 days,
// grouped by watchlist item. The tab is read-only for review; edits to
// the watchlist itself happen in the app.
async function syncWatchlist(sheets, pool) {
  console.log("Syncing watchlist to Google Sheets...");

  const { rows: items } = await pool.query(`
    SELECT id, type, value, notes, created_at
    FROM watchlist_items
    WHERE is_active = true
    ORDER BY type, value
  `);

  const SHEET_WATCH = "Watchlist";
  await ensureSheet(sheets, SHEET_WATCH);

  if (items.length === 0) {
    // Empty state — clear and write a guidance row so the tab isn't confusing
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_WATCH}!A:Z`,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_WATCH}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["No watchlist items configured. Add merchants, categories, or keywords to monitor via Perfin → Settings → Watchlist."]] },
    });
    console.log("  watchlist empty — wrote guidance.");
    return 0;
  }

  // For each item, look up recent matching transactions
  const sections = [];
  for (const item of items) {
    let where, params;
    if (item.type === "merchant") {
      where = `COALESCE(t.user_merchant_name, t.merchant_name, t.name) ILIKE $1`;
      params = ["%" + item.value + "%"];
    } else if (item.type === "category") {
      where = `COALESCE(t.user_category, t.category[1]) = $1`;
      params = [item.value];
    } else { // keyword
      where = `COALESCE(t.user_merchant_name, t.merchant_name, t.name) ILIKE $1 OR COALESCE(t.user_category, t.category[1]) ILIKE $1`;
      params = ["%" + item.value + "%"];
    }
    const { rows: matches } = await pool.query(
      `SELECT t.date, COALESCE(t.user_merchant_name, t.merchant_name, t.name) AS merchant,
              t.amount, la.name AS account_name,
              COALESCE(t.user_category, t.category[1]) AS category
       FROM transactions t
       JOIN linked_accounts la ON la.account_id = t.account_id
       WHERE t.pending = false
         AND t.date >= CURRENT_DATE - INTERVAL '90 days'
         AND (${where})
       ORDER BY t.date DESC
       LIMIT 100`,
      params
    );
    const total = matches.reduce((s, r) => s + parseFloat(r.amount), 0);
    sections.push({ item, matches, total });
  }

  const allRows = [["Watchlist Item", "Type", "Match Count", "90-Day Total", "Notes"]];
  for (const s of sections) {
    allRows.push([s.item.value, s.item.type, s.matches.length, fmtCurrency(s.total), s.item.notes || ""]);
  }
  allRows.push([]);
  allRows.push(["RECENT MATCHES (last 90 days)", "", "", "", ""]);
  allRows.push(["Watchlist Item", "Date", "Merchant", "Amount", "Account / Category"]);
  for (const s of sections) {
    for (const m of s.matches) {
      allRows.push([
        s.item.value,
        fmtDate(m.date),
        m.merchant,
        fmtCurrency(m.amount),
        (m.account_name || "") + (m.category ? " — " + m.category : ""),
      ]);
    }
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_WATCH}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_WATCH}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: allRows },
  });

  const sheetId = await getSheetId(sheets, SHEET_WATCH);
  if (sheetId !== null) {
    const sectionHeaderRow = 1 + sections.length + 2 + 1; // 1-based
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.20, green: 0.40, blue: 0.55 },
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: sectionHeaderRow - 1, endRowIndex: sectionHeaderRow },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
              backgroundColor: { red: 0.20, green: 0.40, blue: 0.55 },
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
          range: { sheetId, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 5 },
        },
      },
    ];
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
    await applyProtection(sheets, sheetId);
  }

  const totalMatches = sections.reduce((s, sec) => s + sec.matches.length, 0);
  console.log(`  ${items.length} watchlist items, ${totalMatches} matches written.`);
  return items.length;
}

// ---------------------------------------------------------------------------
// Append Transactions — partial update for CSV-uploaded transactions
// ---------------------------------------------------------------------------
// Used by POST /api/sheets/sync-transactions for faster feedback after a
// CSV upload (vs running a full syncAll). Only re-runs syncTransactions,
// which is the only tab affected by a CSV import.
async function syncTransactionsOnly() {
  const sheets = await getSheetsClient();
  const pool = getPool();
  try {
    const count = await syncTransactions(sheets, pool);
    return { transactions_synced: count, timestamp: new Date().toISOString() };
  } finally {
    await pool.end();
  }
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
    const utilCount = await syncUtilities(sheets, pool);
    const insightsCount = await syncInsights(sheets, pool);
    const transfersCount = await syncRecurringTransfers(sheets, pool);
    const taxCount = await syncTaxDeductions(sheets, pool);
    const investmentsCount = await syncInvestments(sheets, pool);
    const nwhCount = await syncNetWorthHistory(sheets, pool);
    const incomeCount = await syncIncome(sheets, pool);
    const trustCount = await syncAiTrust(sheets, pool);
    const rulesCount = await syncCategorizationRules(sheets, pool);
    const manualBillsCount = await syncManualBills(sheets, pool);
    const billPaymentsCount = await syncBillPayments(sheets, pool);
    const datesCount = await syncImportantDates(sheets, pool);
    const watchlistCount = await syncWatchlist(sheets, pool);
    const archivesCreated = await syncMonthArchives(sheets, pool);
    await buildDashboard(sheets, pool);

    return {
      transactions_synced: txnCount,
      subscriptions_synced: subs.length,
      utilities_synced: utilCount,
      insights_synced: insightsCount,
      transfers_synced: transfersCount,
      tax_deductions_synced: taxCount,
      investments_synced: investmentsCount,
      net_worth_months_synced: nwhCount,
      income_rows_synced: incomeCount,
      ai_trust_rows_synced: trustCount,
      categorization_rules_synced: rulesCount,
      manual_bills_synced: manualBillsCount,
      bill_payments_synced: billPaymentsCount,
      important_dates_synced: datesCount,
      watchlist_items_synced: watchlistCount,
      month_archives_created: archivesCreated,
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

module.exports = { syncAll, syncDashboardOnly, syncTransactionsOnly };
