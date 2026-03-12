// ============================================================================
// Subscription Tracker — Google Apps Script
// ============================================================================
// Personal finance subscription tracker for Google Sheets.
// Works both standalone (CSV imports) and synced with the Teller server.
//
// Setup:
//   1. Open your Google Sheet
//   2. Extensions > Apps Script
//   3. Paste this entire file into Code.gs
//   4. Run setupTracker() once from the script editor (or use the menu)
//   5. Drop CSV files into the "CSV Uploads" folder created in your Drive
//   — OR —
//   6. Set SERVER_URL in the Config section below and use "Sync from Server"
//      to pull transactions + subscriptions from your Teller server
//
// Sheets created:
//   - Transactions: all imported transactions (deduplicated)
//   - Subscriptions: detected recurring charges
//   - Dashboard: summary with monthly costs, trends, upcoming charges
//   - Import Log: history of CSV imports
//   - Sync Log: history of server syncs
//
// Triggers:
//   - Custom menu: Subscription Tracker > Import CSVs / Detect / Refresh
//   - Time-driven (optional): auto-checks the Drive folder every hour
// ============================================================================

// ---------------------------------------------------------------------------
// Config — reads from Script Properties with hardcoded defaults
// ---------------------------------------------------------------------------
// To configure: Run "Settings" from the Subscription Tracker menu, or set
// Script Properties manually (File > Project properties > Script properties):
//   SERVER_URL   — your Teller server URL (e.g. "https://pers-fin-tracker.onrender.com")
//   API_KEY      — API key for server authentication
// ---------------------------------------------------------------------------
function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    SERVER_URL: props.getProperty("SERVER_URL") || "",
    API_KEY: props.getProperty("API_KEY") || "",
    CSV_FOLDER_NAME: "CSV Uploads",
    PROCESSED_FOLDER_NAME: "CSV Uploads/Processed",
    SHEET_TRANSACTIONS: "Transactions",
    SHEET_SUBSCRIPTIONS: "Subscriptions",
    SHEET_DASHBOARD: "Dashboard",
    SHEET_IMPORT_LOG: "Import Log",
    SHEET_SYNC_LOG: "Sync Log",
    CADENCES: [30, 60, 90, 365],
    TOLERANCE: 0.25,
    AMOUNT_TOLERANCE: 0.10,
    MIN_OCCURRENCES: 3,
    MIN_OCCURRENCES_YEARLY: 2,
  };
}
// Cached config for the current execution
const CONFIG = getConfig_();

// ---------------------------------------------------------------------------
// CSV Format Definitions
// ---------------------------------------------------------------------------
const CSV_FORMATS = {
  chase: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Post Date") && headers.includes("Description"),
    parse: (row, headers) => ({
      date: row[headers.indexOf("Transaction Date")],
      merchant: row[headers.indexOf("Description")],
      amount: -parseFloat(row[headers.indexOf("Amount")]),
      category: row[headers.indexOf("Category")] || "",
    }),
  },
  wellsfargo: {
    detect: (headers) => headers.length >= 5 && !headers.includes("Transaction Date") && !headers.includes("Category"),
    headerless: true,
    parse: (row) => ({
      date: row[0],
      merchant: row[4] || row[3] || "",
      amount: -parseFloat(row[1]),
      category: "",
    }),
  },
  capitalone: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Posted Date") && (headers.includes("Debit") || headers.includes("Credit")),
    parse: (row, headers) => ({
      date: row[headers.indexOf("Transaction Date")],
      merchant: row[headers.indexOf("Description")],
      amount: parseFloat(row[headers.indexOf("Debit")] || "0") || -(parseFloat(row[headers.indexOf("Credit")] || "0")),
      category: row[headers.indexOf("Category")] || "",
    }),
  },
  discover: {
    detect: (headers) => headers.includes("Trans. Date") && headers.includes("Post Date") && headers.includes("Description") && headers.includes("Amount"),
    parse: (row, headers) => ({
      date: row[headers.indexOf("Trans. Date")],
      merchant: row[headers.indexOf("Description")],
      amount: Math.abs(parseFloat(row[headers.indexOf("Amount")])),
      category: row[headers.indexOf("Category")] || "",
    }),
  },
  schwab: {
    detect: (headers) => headers.includes("Date") && headers.includes("Description") && (headers.includes("Withdrawal") || headers.includes("Amount")),
    parse: (row, headers) => ({
      date: row[headers.indexOf("Date")],
      merchant: row[headers.indexOf("Description")],
      amount: Math.abs(parseFloat(row[headers.indexOf("Withdrawal")] || row[headers.indexOf("Amount")] || "0")),
      category: row[headers.indexOf("Type")] || "",
    }),
  },
  generic: {
    detect: () => true,
    parse: (row, headers) => {
      const dateIdx = headers.indexOf("Date") >= 0 ? headers.indexOf("Date") :
                      headers.indexOf("Transaction Date") >= 0 ? headers.indexOf("Transaction Date") : 0;
      const descIdx = headers.indexOf("Description") >= 0 ? headers.indexOf("Description") :
                      headers.indexOf("Merchant") >= 0 ? headers.indexOf("Merchant") :
                      headers.indexOf("Name") >= 0 ? headers.indexOf("Name") : 1;
      const amtIdx = headers.indexOf("Amount") >= 0 ? headers.indexOf("Amount") :
                     headers.indexOf("Debit") >= 0 ? headers.indexOf("Debit") : 2;
      const catIdx = headers.indexOf("Category") >= 0 ? headers.indexOf("Category") : -1;
      return {
        date: row[dateIdx] || "",
        merchant: row[descIdx] || "",
        amount: Math.abs(parseFloat(row[amtIdx]) || 0),
        category: catIdx >= 0 ? (row[catIdx] || "") : "",
      };
    },
  },
};

// Filename-based bank detection
const FILENAME_PATTERNS = {
  chase: /^chase/i,
  wellsfargo: /^(wellsfargo|wells_fargo|wf)/i,
  capitalone: /^(capitalone|capital_one|capone)/i,
  discover: /^discover/i,
  schwab: /^(schwab|charles_schwab)/i,
};

// Cancellation URLs
const CANCEL_URLS = {
  "netflix": "https://www.netflix.com/cancelplan",
  "spotify": "https://www.spotify.com/account/subscription/",
  "hulu": "https://secure.hulu.com/account",
  "disney": "https://www.disneyplus.com/account",
  "hbo": "https://www.max.com/account",
  "max": "https://www.max.com/account",
  "amazon prime": "https://www.amazon.com/mc/pipelines/cancelPrime",
  "prime video": "https://www.amazon.com/mc/pipelines/cancelPrime",
  "apple": "https://support.apple.com/en-us/HT202039",
  "icloud": "https://support.apple.com/en-us/HT202039",
  "youtube": "https://www.youtube.com/paid_memberships",
  "google one": "https://one.google.com/settings",
  "adobe": "https://account.adobe.com/plans",
  "microsoft": "https://account.microsoft.com/services/",
  "xbox": "https://account.microsoft.com/services/",
  "playstation": "https://store.playstation.com/subscriptions",
  "dropbox": "https://www.dropbox.com/account/plan",
  "chatgpt": "https://chat.openai.com/settings/subscription",
  "openai": "https://chat.openai.com/settings/subscription",
  "slack": "https://slack.com/account/settings",
  "zoom": "https://zoom.us/account",
  "nordvpn": "https://my.nordaccount.com/dashboard/nordvpn/",
  "paramount": "https://www.paramountplus.com/account/",
  "peacock": "https://www.peacocktv.com/account/subscription",
  "crunchyroll": "https://www.crunchyroll.com/account/subscription",
  "audible": "https://www.audible.com/account/prefs",
  "kindle": "https://www.amazon.com/kindle-dbs/hz/subscribe/ku",
  "nytimes": "https://myaccount.nytimes.com/seg/subscription",
  "wsj": "https://customercenter.wsj.com/",
  "linkedin": "https://www.linkedin.com/mypreferences/d/manage-subscription",
  "grammarly": "https://account.grammarly.com/subscription",
  "github": "https://github.com/settings/billing",
  "notion": "https://www.notion.so/my-account",
  "figma": "https://www.figma.com/settings",
  "canva": "https://www.canva.com/settings/billing-and-plans",
};

// ---------------------------------------------------------------------------
// Server fetch helper — includes API key in all requests
// ---------------------------------------------------------------------------
function fetchFromServer_(endpoint, options) {
  const url = CONFIG.SERVER_URL + endpoint;
  const opts = options || {};
  opts.muteHttpExceptions = true;
  if (CONFIG.API_KEY) {
    opts.headers = opts.headers || {};
    opts.headers["x-api-key"] = CONFIG.API_KEY;
  }
  return UrlFetchApp.fetch(url, opts);
}

// ============================================================================
// SETUP
// ============================================================================

/**
 * Run once to set up the spreadsheet and Drive folder.
 */
function setupTracker() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create sheets if they don't exist
  ensureSheet_(ss, CONFIG.SHEET_TRANSACTIONS, ["Date", "Merchant", "Amount", "Category", "Institution", "Account", "Import ID", "Transaction ID"]);
  ensureSheet_(ss, CONFIG.SHEET_SUBSCRIPTIONS, ["Service", "Amount", "Cycle Days", "Monthly Cost", "Yearly Cost", "First Seen", "Last Charged", "Next Charge", "Status", "Source", "Cancel URL", "Notes"]);
  ensureSheet_(ss, CONFIG.SHEET_DASHBOARD, []);
  ensureSheet_(ss, CONFIG.SHEET_IMPORT_LOG, ["Timestamp", "Filename", "Institution", "Format", "Rows Imported", "Rows Skipped"]);
  ensureSheet_(ss, CONFIG.SHEET_SYNC_LOG, ["Timestamp", "Source", "Transactions Synced", "Subscriptions Synced", "Status"]);

  // Create CSV upload folder in Drive
  const folder = getOrCreateFolder_(CONFIG.CSV_FOLDER_NAME);
  getOrCreateSubfolder_(folder, "Processed");

  // Set up triggers (if not already set)
  const triggers = ScriptApp.getProjectTriggers();
  const hasHourly = triggers.some(t => t.getHandlerFunction() === "autoImportFromDrive");
  if (!hasHourly) {
    ScriptApp.newTrigger("autoImportFromDrive")
      .timeBased()
      .everyHours(1)
      .create();
  }
  // Daily server sync trigger (runs at 7 AM)
  const hasDailySync = triggers.some(t => t.getHandlerFunction() === "dailyAutoSync");
  if (!hasDailySync) {
    ScriptApp.newTrigger("dailyAutoSync")
      .timeBased()
      .atHour(7)
      .everyDays(1)
      .create();
  }

  SpreadsheetApp.getUi().alert(
    "Setup Complete",
    'Created sheets and Drive folder "' + CONFIG.CSV_FOLDER_NAME + '".\n\n' +
    "Drop your bank CSV files into that folder.\n" +
    "Use the Subscription Tracker menu to import and detect.",
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ============================================================================
// CUSTOM MENU
// ============================================================================

function onOpen() {
  const menu = SpreadsheetApp.getUi().createMenu("Subscription Tracker")
    .addItem("Import CSVs from Drive", "importCsvsFromDrive")
    .addItem("Detect Subscriptions", "detectSubscriptions")
    .addItem("Refresh Dashboard", "buildDashboard")
    .addSeparator()
    .addItem("Run All (Import + Detect + Dashboard)", "runAll")
    .addSeparator();

  if (CONFIG.SERVER_URL) {
    menu.addItem("Sync from Server", "syncFromServer")
      .addItem("Sync Subscriptions from Server", "syncSubscriptionsFromServer")
      .addSeparator();
  }

  menu.addItem("Settings", "showSettings")
    .addItem("Initial Setup", "setupTracker")
    .addToUi();
}

/**
 * Show a dialog to configure SERVER_URL and API_KEY.
 */
function showSettings() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const currentUrl = props.getProperty("SERVER_URL") || "";
  const urlResult = ui.prompt("Settings (1/2)", "Server URL (e.g. https://pers-fin-tracker.onrender.com):\n\nCurrent: " + (currentUrl || "(not set)"), ui.ButtonSet.OK_CANCEL);
  if (urlResult.getSelectedButton() === ui.Button.OK) {
    props.setProperty("SERVER_URL", urlResult.getResponseText().trim());
  }

  const currentKey = props.getProperty("API_KEY") || "";
  const keyResult = ui.prompt("Settings (2/2)", "API Key for server authentication:\n\nCurrent: " + (currentKey ? "(set)" : "(not set)"), ui.ButtonSet.OK_CANCEL);
  if (keyResult.getSelectedButton() === ui.Button.OK) {
    props.setProperty("API_KEY", keyResult.getResponseText().trim());
  }

  ui.alert("Settings saved. Reload the spreadsheet for changes to take effect.");
}

// ============================================================================
// CSV IMPORT
// ============================================================================

/**
 * Import all CSV files from the Drive folder.
 */
function importCsvsFromDrive() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const folder = getOrCreateFolder_(CONFIG.CSV_FOLDER_NAME);
  const processedFolder = getOrCreateSubfolder_(folder, "Processed");
  const files = folder.getFilesByType(MimeType.CSV);

  const txnSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS) || ensureSheet_(ss, CONFIG.SHEET_TRANSACTIONS, ["Date", "Merchant", "Amount", "Category", "Institution", "Account", "Import ID", "Transaction ID"]);
  const logSheet = ss.getSheetByName(CONFIG.SHEET_IMPORT_LOG) || ensureSheet_(ss, CONFIG.SHEET_IMPORT_LOG, ["Timestamp", "Filename", "Institution", "Format", "Rows Imported", "Rows Skipped"]);

  // Load existing transaction IDs for deduplication
  const existingIds = new Set();
  const txnData = txnSheet.getDataRange().getValues();
  const txnIdCol = 7; // Column H (0-indexed)
  for (let i = 1; i < txnData.length; i++) {
    if (txnData[i][txnIdCol]) existingIds.add(txnData[i][txnIdCol]);
  }

  let totalImported = 0;
  let totalSkipped = 0;
  let fileCount = 0;

  while (files.hasNext()) {
    const file = files.next();
    const filename = file.getName();
    const content = file.getBlob().getDataAsString();
    const importId = Utilities.getUuid().slice(0, 8);

    const result = parseCsvFile_(content, filename, importId, existingIds);

    if (result.rows.length > 0) {
      txnSheet.getRange(txnSheet.getLastRow() + 1, 1, result.rows.length, 8).setValues(result.rows);
      // Add new IDs to the set
      result.rows.forEach(r => existingIds.add(r[7]));
    }

    // Log the import
    logSheet.appendRow([
      new Date(),
      filename,
      result.institution,
      result.format,
      result.imported,
      result.skipped,
    ]);

    totalImported += result.imported;
    totalSkipped += result.skipped;
    fileCount++;

    // Move to processed folder
    file.moveTo(processedFolder);
  }

  if (fileCount === 0) {
    SpreadsheetApp.getUi().alert("No CSV files found in the '" + CONFIG.CSV_FOLDER_NAME + "' folder.");
    return;
  }

  // Sort transactions by date descending
  if (txnSheet.getLastRow() > 1) {
    txnSheet.getRange(2, 1, txnSheet.getLastRow() - 1, 8).sort({ column: 1, ascending: false });
  }

  SpreadsheetApp.getUi().alert(
    "Import Complete",
    fileCount + " file(s) processed.\n" +
    totalImported + " transactions imported, " + totalSkipped + " skipped (duplicates/invalid).",
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/**
 * Auto-import triggered hourly (no UI alerts).
 */
function autoImportFromDrive() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const folder = getOrCreateFolder_(CONFIG.CSV_FOLDER_NAME);
  const files = folder.getFilesByType(MimeType.CSV);
  if (!files.hasNext()) return; // Nothing to do

  const processedFolder = getOrCreateSubfolder_(folder, "Processed");
  const txnSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);
  const logSheet = ss.getSheetByName(CONFIG.SHEET_IMPORT_LOG);
  if (!txnSheet || !logSheet) return;

  const existingIds = new Set();
  const txnData = txnSheet.getDataRange().getValues();
  for (let i = 1; i < txnData.length; i++) {
    if (txnData[i][7]) existingIds.add(txnData[i][7]);
  }

  let anyImported = false;

  while (files.hasNext()) {
    const file = files.next();
    const content = file.getBlob().getDataAsString();
    const importId = Utilities.getUuid().slice(0, 8);
    const result = parseCsvFile_(content, file.getName(), importId, existingIds);

    if (result.rows.length > 0) {
      txnSheet.getRange(txnSheet.getLastRow() + 1, 1, result.rows.length, 8).setValues(result.rows);
      result.rows.forEach(r => existingIds.add(r[7]));
      anyImported = true;
    }

    logSheet.appendRow([new Date(), file.getName(), result.institution, result.format, result.imported, result.skipped]);
    file.moveTo(processedFolder);
  }

  // If we imported anything, run detection and refresh dashboard
  if (anyImported) {
    if (txnSheet.getLastRow() > 1) {
      txnSheet.getRange(2, 1, txnSheet.getLastRow() - 1, 8).sort({ column: 1, ascending: false });
    }
    detectSubscriptions();
    buildDashboard();
  }
}

/**
 * Parse a CSV file and return rows ready for the Transactions sheet.
 */
function parseCsvFile_(content, filename, importId, existingIds) {
  const lines = Utilities.parseCsv(content);
  if (lines.length < 2) return { rows: [], format: "empty", institution: "", imported: 0, skipped: 0 };

  // Detect institution from filename
  let filenameBank = null;
  for (const [bank, pattern] of Object.entries(FILENAME_PATTERNS)) {
    if (pattern.test(filename)) { filenameBank = bank; break; }
  }

  const headers = lines[0].map(h => h.trim());
  let format = null;
  let fmt = null;

  // Try filename-based detection first, then content-based
  if (filenameBank && CSV_FORMATS[filenameBank]) {
    format = filenameBank;
    fmt = CSV_FORMATS[filenameBank];
  } else {
    for (const [name, f] of Object.entries(CSV_FORMATS)) {
      if (name !== "generic" && f.detect(headers)) {
        format = name;
        fmt = f;
        break;
      }
    }
    if (!fmt) {
      format = "generic";
      fmt = CSV_FORMATS.generic;
    }
  }

  const institution = {
    chase: "Chase", wellsfargo: "Wells Fargo", capitalone: "Capital One",
    discover: "Discover", schwab: "Charles Schwab", generic: "CSV Import",
  }[format] || "CSV Import";

  const accountLabel = institution + " Account";
  const startRow = fmt.headerless ? 0 : 1;
  const rows = [];
  let imported = 0;
  let skipped = 0;

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 2 || line.every(c => !c.trim())) { skipped++; continue; }

    let parsed;
    try {
      parsed = fmt.headerless ? fmt.parse(line) : fmt.parse(line, headers);
    } catch { skipped++; continue; }

    const date = parseDate_(parsed.date);
    if (!date || isNaN(parsed.amount) || parsed.amount === 0) { skipped++; continue; }

    // Deterministic transaction ID for deduplication
    const txnId = generateTxnId_(accountLabel, date, parsed.amount, parsed.merchant, i);
    if (existingIds.has(txnId)) { skipped++; continue; }

    rows.push([
      date,                    // A: Date
      parsed.merchant || "",   // B: Merchant
      parsed.amount,           // C: Amount
      parsed.category || "",   // D: Category
      institution,             // E: Institution
      accountLabel,            // F: Account
      importId,                // G: Import ID
      txnId,                   // H: Transaction ID
    ]);
    imported++;
  }

  return { rows, format, institution, imported, skipped };
}

// ============================================================================
// SUBSCRIPTION DETECTION
// ============================================================================

/**
 * Analyze transactions for recurring patterns and update Subscriptions sheet.
 */
function detectSubscriptions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txnSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);
  if (!txnSheet || txnSheet.getLastRow() < 2) return;

  const txnData = txnSheet.getDataRange().getValues();
  const headers = txnData[0];

  // Build transaction list from last 36 months (needed for yearly cadence detection)
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 36);

  const txns = [];
  for (let i = 1; i < txnData.length; i++) {
    const row = txnData[i];
    const date = row[0] instanceof Date ? row[0] : new Date(row[0]);
    const amount = parseFloat(row[2]);
    if (isNaN(date.getTime()) || isNaN(amount) || amount <= 0) continue;
    if (date < cutoff) continue;

    const merchant = (row[1] || "").toString().trim();
    if (!merchant) continue;

    txns.push({
      date: date,
      merchant: merchant,
      merchantKey: merchant.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim(),
      amount: amount,
    });
  }

  // Group by merchant key
  const groups = {};
  for (const txn of txns) {
    if (!groups[txn.merchantKey]) groups[txn.merchantKey] = [];
    groups[txn.merchantKey].push(txn);
  }

  // Analyze each group
  const detected = [];

  for (const [merchantKey, merchantTxns] of Object.entries(groups)) {
    if (merchantTxns.length < CONFIG.MIN_OCCURRENCES_YEARLY) continue;

    merchantTxns.sort((a, b) => a.date - b.date);

    for (const targetCadence of CONFIG.CADENCES) {
      const minOcc = targetCadence >= 365 ? CONFIG.MIN_OCCURRENCES_YEARLY : CONFIG.MIN_OCCURRENCES;
      const minGap = targetCadence * (1 - CONFIG.TOLERANCE);
      const maxGap = targetCadence * (1 + CONFIG.TOLERANCE);

      // Find dominant amount
      const amounts = merchantTxns.map(t => t.amount);
      const modeAmount = findModeAmount_(amounts);
      if (modeAmount === null) continue;

      // Filter to similar amounts
      const filtered = merchantTxns.filter(t =>
        Math.abs(t.amount - modeAmount) / Math.max(modeAmount, 0.01) <= CONFIG.AMOUNT_TOLERANCE
      );
      if (filtered.length < minOcc) continue;

      // Compute inter-charge gaps
      const gaps = [];
      for (let i = 1; i < filtered.length; i++) {
        const daysDiff = (filtered[i].date - filtered[i - 1].date) / (1000 * 60 * 60 * 24);
        gaps.push(daysDiff);
      }

      const matchingGaps = gaps.filter(g => g >= minGap && g <= maxGap);

      // For yearly cadence, a single matching gap (2 charges ~365 days apart) is sufficient
      const minMatchingGaps = targetCadence >= 365 ? 1 : 2;
      if (matchingGaps.length >= Math.floor(gaps.length * 0.5) && matchingGaps.length >= minMatchingGaps) {
        const lastTxn = filtered[filtered.length - 1];
        const firstTxn = filtered[0];
        const latestAmount = lastTxn.amount;
        const priorAmount = filtered.length >= 2 ? filtered[filtered.length - 2].amount : null;

        const nextExpected = new Date(lastTxn.date);
        nextExpected.setDate(nextExpected.getDate() + targetCadence);

        const monthlyCost = Math.round(latestAmount * (30 / targetCadence) * 100) / 100;
        const yearlyCost = Math.round(monthlyCost * 12 * 100) / 100;

        const cancelUrl = findCancelUrl_(lastTxn.merchant);

        let status = "Active";
        if ((new Date() - lastTxn.date) / (1000 * 60 * 60 * 24) > 120) {
          status = "Inactive";
        }

        detected.push({
          service: lastTxn.merchant,
          amount: latestAmount,
          cadenceDays: targetCadence,
          monthlyCost: monthlyCost,
          yearlyCost: yearlyCost,
          firstSeen: firstTxn.date,
          lastCharged: lastTxn.date,
          nextExpected: nextExpected,
          status: status,
          source: "detected",
          cancelUrl: cancelUrl || "",
          notes: priorAmount !== null && Math.abs(latestAmount - priorAmount) > 0.01
            ? "Price changed from $" + priorAmount.toFixed(2)
            : "",
          merchantKey: merchantKey,
        });

        break; // Prefer shorter cadence
      }
    }
  }

  // Write to Subscriptions sheet
  const subSheet = ss.getSheetByName(CONFIG.SHEET_SUBSCRIPTIONS) || ensureSheet_(ss, CONFIG.SHEET_SUBSCRIPTIONS, ["Service", "Amount", "Cycle Days", "Monthly Cost", "Yearly Cost", "First Seen", "Last Charged", "Next Charge", "Status", "Source", "Cancel URL", "Notes"]);

  // Preserve manually added subscriptions and dismissed/cancelled status
  const existingSubs = {};
  if (subSheet.getLastRow() > 1) {
    const existing = subSheet.getRange(2, 1, subSheet.getLastRow() - 1, 12).getValues();
    for (const row of existing) {
      const key = (row[0] || "").toString().toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
      existingSubs[key] = {
        status: row[8],
        source: row[9],
        notes: row[11],
      };
    }
  }

  // Merge: keep manual entries, update detected ones, preserve dismissed/cancelled
  const finalRows = [];

  for (const sub of detected) {
    const existing = existingSubs[sub.merchantKey];
    let status = sub.status;
    let notes = sub.notes;

    if (existing) {
      // Preserve user overrides
      if (existing.status === "Dismissed" || existing.status === "Cancelled") {
        status = existing.status;
      }
      if (existing.notes && !notes) {
        notes = existing.notes;
      }
      delete existingSubs[sub.merchantKey]; // Mark as processed
    }

    finalRows.push([
      sub.service,
      sub.amount,
      sub.cadenceDays,
      sub.monthlyCost,
      sub.yearlyCost,
      sub.firstSeen,
      sub.lastCharged,
      sub.nextExpected,
      status,
      "detected",
      sub.cancelUrl,
      notes,
    ]);
  }

  // Re-add manual entries and unmatched dismissed/cancelled entries
  if (subSheet.getLastRow() > 1) {
    const existing = subSheet.getRange(2, 1, subSheet.getLastRow() - 1, 12).getValues();
    for (const row of existing) {
      const key = (row[0] || "").toString().toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
      if (existingSubs[key]) {
        // This entry wasn't matched by detection — keep it if manual or user-modified
        if (row[9] === "manual" || row[8] === "Dismissed" || row[8] === "Cancelled") {
          finalRows.push(row);
        }
      }
    }
  }

  // Sort: Active first, then by amount descending
  finalRows.sort((a, b) => {
    const statusOrder = { "Active": 0, "Inactive": 1, "Dismissed": 2, "Cancelled": 3 };
    const sa = statusOrder[a[8]] || 0;
    const sb = statusOrder[b[8]] || 0;
    if (sa !== sb) return sa - sb;
    return (b[1] || 0) - (a[1] || 0);
  });

  // Clear and rewrite
  if (subSheet.getLastRow() > 1) {
    subSheet.getRange(2, 1, subSheet.getLastRow() - 1, 12).clearContent();
  }
  if (finalRows.length > 0) {
    subSheet.getRange(2, 1, finalRows.length, 12).setValues(finalRows);
  }

  // Format
  formatSubscriptionsSheet_(subSheet, finalRows.length);

  const activeCount = finalRows.filter(r => r[8] === "Active").length;

  // Only show alert if called from menu (not from auto-import)
  try {
    SpreadsheetApp.getUi().alert(
      "Detection Complete",
      "Found " + activeCount + " active subscription(s) out of " + finalRows.length + " total.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    // Running from trigger, no UI available
  }
}

// ============================================================================
// DASHBOARD
// ============================================================================

function buildDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txnSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);
  const subSheet = ss.getSheetByName(CONFIG.SHEET_SUBSCRIPTIONS);
  let dashSheet = ss.getSheetByName(CONFIG.SHEET_DASHBOARD);

  if (!dashSheet) {
    dashSheet = ensureSheet_(ss, CONFIG.SHEET_DASHBOARD, []);
  }

  // Clear dashboard
  dashSheet.clear();

  // Load transactions
  const txns = [];
  if (txnSheet && txnSheet.getLastRow() > 1) {
    const data = txnSheet.getRange(2, 1, txnSheet.getLastRow() - 1, 8).getValues();
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    for (const row of data) {
      const date = row[0] instanceof Date ? row[0] : new Date(row[0]);
      const amount = parseFloat(row[2]);
      if (isNaN(date.getTime()) || isNaN(amount) || amount <= 0) continue;
      if (date < twelveMonthsAgo) continue;
      txns.push({ date, merchant: row[1], amount, category: row[3] });
    }
  }

  // Load subscriptions
  const subs = [];
  if (subSheet && subSheet.getLastRow() > 1) {
    const data = subSheet.getRange(2, 1, subSheet.getLastRow() - 1, 12).getValues();
    for (const row of data) {
      if (row[8] === "Active") {
        subs.push({
          service: row[0],
          amount: parseFloat(row[1]) || 0,
          cadenceDays: parseInt(row[2]) || 30,
          monthlyCost: parseFloat(row[3]) || 0,
          nextExpected: row[7],
          cancelUrl: row[10],
        });
      }
    }
  }

  // Monthly breakdown
  const monthlyTotals = {};
  for (const txn of txns) {
    const month = Utilities.formatDate(txn.date, Session.getScriptTimeZone(), "yyyy-MM");
    if (!monthlyTotals[month]) monthlyTotals[month] = { total: 0, count: 0 };
    monthlyTotals[month].total += txn.amount;
    monthlyTotals[month].count++;
  }

  // Category breakdown
  const categoryTotals = {};
  for (const txn of txns) {
    const cat = txn.category || "Uncategorized";
    if (!categoryTotals[cat]) categoryTotals[cat] = { total: 0, count: 0 };
    categoryTotals[cat].total += txn.amount;
    categoryTotals[cat].count++;
  }

  // Top merchants
  const merchantTotals = {};
  for (const txn of txns) {
    const m = txn.merchant || "Unknown";
    if (!merchantTotals[m]) merchantTotals[m] = { total: 0, count: 0 };
    merchantTotals[m].total += txn.amount;
    merchantTotals[m].count++;
  }

  // Calculate summaries
  const totalMonthly = subs.reduce((s, sub) => s + sub.monthlyCost, 0);
  const totalYearly = totalMonthly * 12;
  const totalSpend = txns.reduce((s, t) => s + t.amount, 0);
  const monthCount = Object.keys(monthlyTotals).length || 1;
  const avgMonthly = totalSpend / monthCount;
  const avgDaily = totalSpend / (monthCount * 30);

  // Build dashboard rows
  const rows = [];

  // Title
  rows.push(["PERSONAL FINANCE DASHBOARD", "", "", "", "", ""]);
  rows.push(["Last updated: " + new Date().toLocaleString(), "", "", "", "", ""]);
  rows.push(["", "", "", "", "", ""]);

  // Summary cards
  rows.push(["Avg Monthly Spend", "Subscriptions /mo", "Subscriptions /yr", "Active Subscriptions", "Avg Daily Spend", "12-Month Total"]);
  rows.push([avgMonthly, totalMonthly, totalYearly, subs.length, avgDaily, totalSpend]);
  rows.push(["", "", "", "", "", ""]);

  // Monthly trend
  rows.push(["MONTHLY SPENDING TREND", "", "", ""]);
  rows.push(["Month", "Total Spend", "Transactions", "Avg Transaction"]);
  const sortedMonths = Object.entries(monthlyTotals).sort((a, b) => b[0].localeCompare(a[0]));
  for (const [month, data] of sortedMonths) {
    rows.push([month, data.total, data.count, data.total / data.count]);
  }
  rows.push(["", "", "", ""]);

  // Category breakdown
  rows.push(["SPENDING BY CATEGORY", "", ""]);
  rows.push(["Category", "Total", "Transactions"]);
  const sortedCats = Object.entries(categoryTotals).sort((a, b) => b[1].total - a[1].total).slice(0, 15);
  for (const [cat, data] of sortedCats) {
    rows.push([cat, data.total, data.count]);
  }
  rows.push(["", "", ""]);

  // Top merchants
  rows.push(["TOP MERCHANTS", "", ""]);
  rows.push(["Merchant", "Total Spent", "Transactions"]);
  const sortedMerchants = Object.entries(merchantTotals).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  for (const [m, data] of sortedMerchants) {
    rows.push([m, data.total, data.count]);
  }
  rows.push(["", "", ""]);

  // Upcoming charges
  rows.push(["UPCOMING SUBSCRIPTION CHARGES", "", "", ""]);
  rows.push(["Service", "Amount", "Next Charge", "Monthly Cost"]);
  const sortedSubs = subs.sort((a, b) => new Date(a.nextExpected) - new Date(b.nextExpected));
  for (const sub of sortedSubs) {
    rows.push([sub.service, sub.amount, sub.nextExpected, sub.monthlyCost]);
  }

  // Write all rows
  if (rows.length > 0) {
    dashSheet.getRange(1, 1, rows.length, 6).setValues(rows.map(r => {
      while (r.length < 6) r.push("");
      return r.slice(0, 6);
    }));
  }

  // Apply formatting
  formatDashboard_(dashSheet, rows);
}

// ============================================================================
// SERVER SYNC — Pull data from the Teller server API
// ============================================================================

/**
 * Sync transactions and subscriptions from the Teller server, then rebuild
 * the dashboard. Requires CONFIG.SERVER_URL to be set.
 */
function syncFromServer() {
  if (!CONFIG.SERVER_URL) {
    SpreadsheetApp.getUi().alert("Server URL not configured. Set CONFIG.SERVER_URL in the script editor.");
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let txnCount = 0;
  let subCount = 0;

  try {
    // 1. Trigger a transaction sync on the server
    const syncRes = fetchFromServer_("/api/sync", { method: "post" });
    if (syncRes.getResponseCode() !== 200) {
      throw new Error("Server sync failed: " + syncRes.getContentText());
    }

    // 2. Trigger detection on the server
    fetchFromServer_("/api/detect", { method: "post" });

    // 3. Pull subscriptions from server
    subCount = syncSubscriptionsFromServer_(ss);

    // 4. Pull transactions from server (recent 6 months for dashboard)
    txnCount = syncTransactionsFromServer_(ss);

    // 5. Rebuild dashboard with merged data
    buildDashboard();

    // Log the sync
    logSync_(ss, "server", txnCount, subCount, "OK");

    SpreadsheetApp.getUi().alert(
      "Server Sync Complete",
      "Synced " + txnCount + " transactions and " + subCount + " subscriptions from server.\nDashboard refreshed.",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    logSync_(ss, "server", txnCount, subCount, "ERROR: " + e.message);
    SpreadsheetApp.getUi().alert("Sync Error", e.message, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

/**
 * Sync only subscriptions from the server (useful for quick updates).
 */
function syncSubscriptionsFromServer() {
  if (!CONFIG.SERVER_URL) {
    SpreadsheetApp.getUi().alert("Server URL not configured.");
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const count = syncSubscriptionsFromServer_(ss);
    buildDashboard();
    logSync_(ss, "server-subs", 0, count, "OK");
    SpreadsheetApp.getUi().alert("Synced " + count + " subscriptions from server.");
  } catch (e) {
    SpreadsheetApp.getUi().alert("Sync Error", e.message, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

/**
 * Pull subscriptions from the server API and merge into the Subscriptions sheet.
 * Server-sourced entries get source="server", preserving local manual entries.
 */
function syncSubscriptionsFromServer_(ss) {
  const res = fetchFromServer_("/api/subscriptions");
  if (res.getResponseCode() !== 200) {
    throw new Error("Failed to fetch subscriptions: " + res.getContentText());
  }

  const data = JSON.parse(res.getContentText());
  const serverSubs = data.subscriptions || [];
  const subSheet = ss.getSheetByName(CONFIG.SHEET_SUBSCRIPTIONS) || ensureSheet_(ss, CONFIG.SHEET_SUBSCRIPTIONS, ["Service", "Amount", "Cycle Days", "Monthly Cost", "Yearly Cost", "First Seen", "Last Charged", "Next Charge", "Status", "Source", "Cancel URL", "Notes"]);

  // Load existing local entries (manual and CSV-detected)
  const localEntries = {};
  if (subSheet.getLastRow() > 1) {
    const existing = subSheet.getRange(2, 1, subSheet.getLastRow() - 1, 12).getValues();
    for (const row of existing) {
      const key = (row[0] || "").toString().toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
      localEntries[key] = {
        row: row,
        source: row[9],
        status: row[8],
      };
    }
  }

  const finalRows = [];
  const processedKeys = new Set();

  // Add server subscriptions
  for (const sub of serverSubs) {
    const key = (sub.display_name || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    processedKeys.add(key);

    const amount = parseFloat(sub.amount) || 0;
    const cadenceDays = parseInt(sub.cadence_days) || 30;
    const monthlyCost = Math.round(amount * (30 / cadenceDays) * 100) / 100;
    const yearlyCost = Math.round(monthlyCost * 12 * 100) / 100;

    let status = "Active";
    if (sub.cancelled_at) status = "Cancelled";
    else if (sub.is_dismissed) status = "Dismissed";
    else if (!sub.is_active) status = "Inactive";

    // Preserve local user overrides (dismissed/cancelled status)
    const local = localEntries[key];
    if (local && (local.status === "Dismissed" || local.status === "Cancelled")) {
      status = local.status;
    }

    const cancelUrl = findCancelUrl_(sub.display_name) || "";
    const notes = sub.notes || (sub.amount_changed ? "Price changed from $" + (parseFloat(sub.prior_amount) || 0).toFixed(2) : "") || (local ? local.row[11] : "") || "";

    finalRows.push([
      sub.display_name,
      amount,
      cadenceDays,
      monthlyCost,
      yearlyCost,
      sub.first_seen || "",
      sub.last_charged || "",
      sub.next_expected || "",
      status,
      "server",
      cancelUrl,
      notes,
    ]);
  }

  // Re-add local-only entries (manual entries, CSV-detected not on server)
  for (const [key, entry] of Object.entries(localEntries)) {
    if (!processedKeys.has(key)) {
      if (entry.source === "manual" || entry.status === "Dismissed" || entry.status === "Cancelled") {
        finalRows.push(entry.row);
      }
    }
  }

  // Sort: Active first, then by amount descending
  finalRows.sort((a, b) => {
    const statusOrder = { "Active": 0, "Inactive": 1, "Dismissed": 2, "Cancelled": 3 };
    const sa = statusOrder[a[8]] || 0;
    const sb = statusOrder[b[8]] || 0;
    if (sa !== sb) return sa - sb;
    return (b[1] || 0) - (a[1] || 0);
  });

  // Clear and rewrite
  if (subSheet.getLastRow() > 1) {
    subSheet.getRange(2, 1, subSheet.getLastRow() - 1, 12).clearContent();
  }
  if (finalRows.length > 0) {
    subSheet.getRange(2, 1, finalRows.length, 12).setValues(finalRows);
  }

  formatSubscriptionsSheet_(subSheet, finalRows.length);
  return serverSubs.length;
}

/**
 * Pull recent transactions from the server's /api/transactions endpoint
 * and merge into the Transactions sheet, deduplicating by transaction ID.
 */
function syncTransactionsFromServer_(ss) {
  const res = fetchFromServer_("/api/transactions?months=12");
  if (res.getResponseCode() !== 200) {
    // Fallback: try sheets sync endpoint
    const syncRes = fetchFromServer_("/api/sheets/sync", { method: "post" });
    if (syncRes.getResponseCode() === 200) {
      return JSON.parse(syncRes.getContentText()).transactions_synced || 0;
    }
    return 0;
  }

  const data = JSON.parse(res.getContentText());
  const serverTxns = data.transactions || [];
  if (serverTxns.length === 0) return 0;

  const txnSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS) || ensureSheet_(ss, CONFIG.SHEET_TRANSACTIONS, ["Date", "Merchant", "Amount", "Category", "Institution", "Account", "Import ID", "Transaction ID"]);

  // Load existing transaction IDs for deduplication
  const existingIds = new Set();
  if (txnSheet.getLastRow() > 1) {
    const txnData = txnSheet.getDataRange().getValues();
    for (let i = 1; i < txnData.length; i++) {
      if (txnData[i][7]) existingIds.add(txnData[i][7]);
    }
  }

  // Build rows for new transactions
  const newRows = [];
  for (const txn of serverTxns) {
    const txnId = txn.transaction_id || "";
    if (existingIds.has(txnId)) continue;

    const date = parseDate_(txn.date);
    if (!date) continue;

    const amount = parseFloat(txn.amount);
    if (isNaN(amount) || amount <= 0) continue;

    newRows.push([
      date,
      txn.merchant || "",
      amount,
      txn.pfc_primary || txn.category || "",
      txn.institution_name || "",
      txn.account_name || "",
      "server",
      txnId,
    ]);
  }

  if (newRows.length > 0) {
    txnSheet.getRange(txnSheet.getLastRow() + 1, 1, newRows.length, 8).setValues(newRows);
    // Sort by date descending
    if (txnSheet.getLastRow() > 1) {
      txnSheet.getRange(2, 1, txnSheet.getLastRow() - 1, 8).sort({ column: 1, ascending: false });
    }
  }

  return newRows.length;
}

function logSync_(ss, source, txnCount, subCount, status) {
  const logSheet = ss.getSheetByName(CONFIG.SHEET_SYNC_LOG) || ensureSheet_(ss, CONFIG.SHEET_SYNC_LOG, ["Timestamp", "Source", "Transactions Synced", "Subscriptions Synced", "Status"]);
  logSheet.appendRow([new Date(), source, txnCount, subCount, status]);
}

// ============================================================================
// DAILY AUTO SYNC (time-driven trigger, runs at 7 AM)
// ============================================================================

/**
 * Automated daily sync: pulls from server (if configured), runs detection,
 * refreshes dashboard, and emails alerts for new/changed subscriptions.
 */
function dailyAutoSync() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let txnCount = 0;
  let subCount = 0;

  try {
    if (CONFIG.SERVER_URL) {
      // Server sync mode
      const syncRes = fetchFromServer_("/api/sync", { method: "post" });
      if (syncRes.getResponseCode() === 200) {
        fetchFromServer_("/api/detect", { method: "post" });
        subCount = syncSubscriptionsFromServer_(ss);
        txnCount = syncTransactionsFromServer_(ss);
      }
      logSync_(ss, "auto-daily", txnCount, subCount, "OK");
    } else {
      // Standalone mode: just run local detection
      detectSubscriptions();
    }

    buildDashboard();

    // Send email alerts for new or changed subscriptions
    sendSubscriptionAlerts_();

  } catch (e) {
    logSync_(ss, "auto-daily", txnCount, subCount, "ERROR: " + e.message);
  }
}

/**
 * Email the user about new subscriptions, price changes, and upcoming charges.
 */
function sendSubscriptionAlerts_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const subSheet = ss.getSheetByName(CONFIG.SHEET_SUBSCRIPTIONS);
  if (!subSheet || subSheet.getLastRow() < 2) return;

  const data = subSheet.getRange(2, 1, subSheet.getLastRow() - 1, 12).getValues();
  const alerts = [];
  const upcoming = [];
  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  for (const row of data) {
    const service = row[0];
    const amount = parseFloat(row[1]) || 0;
    const status = row[8];
    const notes = row[11] || "";

    if (status !== "Active") continue;

    // Check for price changes
    if (notes && notes.toString().toLowerCase().includes("price changed")) {
      alerts.push("Price change: " + service + " — " + notes);
    }

    // Check for upcoming charges in next 7 days
    const nextCharge = row[7] instanceof Date ? row[7] : new Date(row[7]);
    if (!isNaN(nextCharge.getTime()) && nextCharge >= now && nextCharge <= sevenDaysOut) {
      upcoming.push(service + " — $" + amount.toFixed(2) + " on " + nextCharge.toLocaleDateString());
    }
  }

  // Only send email if there's something to report
  if (alerts.length === 0 && upcoming.length === 0) return;

  const email = Session.getActiveUser().getEmail();
  if (!email) return;

  let body = "Subscription Tracker Daily Summary\n";
  body += "==================================\n\n";

  if (alerts.length > 0) {
    body += "ALERTS:\n";
    alerts.forEach(a => body += "  • " + a + "\n");
    body += "\n";
  }

  if (upcoming.length > 0) {
    body += "UPCOMING CHARGES (next 7 days):\n";
    upcoming.forEach(u => body += "  • " + u + "\n");
    body += "\n";
  }

  body += "View dashboard: " + ss.getUrl() + "\n";

  MailApp.sendEmail({
    to: email,
    subject: "Subscription Tracker: " + (alerts.length > 0 ? alerts.length + " alert(s)" : upcoming.length + " upcoming charge(s)"),
    body: body,
  });
}

// ============================================================================
// RUN ALL
// ============================================================================

function runAll() {
  importCsvsFromDrive();
  detectSubscriptions();
  buildDashboard();
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold")
        .setBackground("#161b22").setFontColor("#d4a574").setFontSize(9)
        .setFontFamily("Inter,system-ui,sans-serif");
      sheet.setFrozenRows(1);
    }
    // Apply dark theme base to entire sheet
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns())
      .setBackground("#0d1117").setFontColor("#e6dfd6")
      .setFontFamily("Inter,system-ui,sans-serif").setFontSize(11);
    // Re-apply header formatting (overwritten by the full-sheet styling above)
    if (headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold")
        .setBackground("#161b22").setFontColor("#d4a574").setFontSize(9);
    }
    sheet.setHiddenGridlines(true);
  }
  return sheet;
}

function getOrCreateFolder_(name) {
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function getOrCreateSubfolder_(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function parseDate_(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return dateStr;
  const cleaned = dateStr.toString().trim();

  // MM/DD/YYYY or M/D/YYYY
  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return new Date(parseInt(slashMatch[3]), parseInt(slashMatch[1]) - 1, parseInt(slashMatch[2]));
  }

  // YYYY-MM-DD
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
  }

  // Fallback
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function generateTxnId_(account, date, amount, merchant, rowIndex) {
  // Deterministic ID from content — same logic as the Node.js version
  const dateStr = date instanceof Date
    ? Utilities.formatDate(date, "UTC", "yyyy-MM-dd")
    : date;
  const raw = account + "|" + dateStr + "|" + amount + "|" + (merchant || "") + "|" + rowIndex;
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  return "csv_" + hash.map(b => ("0" + ((b + 256) % 256).toString(16)).slice(-2)).join("").slice(0, 24);
}

function findModeAmount_(amounts) {
  if (amounts.length === 0) return null;
  let bestAmount = amounts[0];
  let bestCount = 0;
  for (const candidate of amounts) {
    const count = amounts.filter(a =>
      Math.abs(a - candidate) / Math.max(candidate, 0.01) <= CONFIG.AMOUNT_TOLERANCE
    ).length;
    if (count > bestCount) {
      bestCount = count;
      bestAmount = candidate;
    }
  }
  return bestAmount;
}

function findCancelUrl_(merchantName) {
  if (!merchantName) return null;
  const lower = merchantName.toLowerCase();
  for (const [key, url] of Object.entries(CANCEL_URLS)) {
    if (lower.includes(key)) return url;
  }
  return null;
}

// ============================================================================
// FORMATTING
// ============================================================================

function formatSubscriptionsSheet_(sheet, dataRows) {
  if (dataRows === 0) return;

  const BG_DARK = "#0d1117";
  const BG_SURFACE = "#161b22";
  const TEXT_PRIMARY = "#e6dfd6";
  const TEXT_MUTED = "#8b949e";
  const WARM = "#d4a574";
  const TEAL = "#5a8f8f";
  const RED_BG = "#2d1518";
  const YELLOW_BG = "#2d2815";

  // Full sheet dark background
  const totalRows = Math.max(dataRows + 1, 50);
  sheet.getRange(1, 1, totalRows, 12).setBackground(BG_DARK).setFontColor(TEXT_PRIMARY)
    .setFontFamily("Inter,system-ui,sans-serif").setFontSize(11).setFontWeight("normal");

  // Currency format for Amount, Monthly Cost, Yearly Cost (cols B, D, E)
  sheet.getRange(2, 2, dataRows, 1).setNumberFormat("$#,##0.00");
  sheet.getRange(2, 4, dataRows, 2).setNumberFormat("$#,##0.00");

  // Date format for First Seen, Last Charged, Next Charge (cols F, G, H)
  sheet.getRange(2, 6, dataRows, 3).setNumberFormat("yyyy-mm-dd").setFontColor(TEXT_MUTED);

  // Conditional formatting: dark red for Cancelled, dark amber for Dismissed
  const cancelledRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$I2="Cancelled"')
    .setBackground(RED_BG).setFontColor("#eb6b6b")
    .setRanges([sheet.getRange(2, 1, dataRows, 12)])
    .build();

  const dismissedRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$I2="Dismissed"')
    .setBackground(YELLOW_BG).setFontColor(TEXT_MUTED)
    .setRanges([sheet.getRange(2, 1, dataRows, 12)])
    .build();

  sheet.setConditionalFormatRules([cancelledRule, dismissedRule]);

  // Header styling — warm accent on dark
  const headerRange = sheet.getRange(1, 1, 1, 12);
  headerRange.setBackground(BG_SURFACE).setFontColor(WARM).setFontWeight("bold")
    .setFontSize(9);

  // Alternating row tints
  for (let r = 0; r < dataRows; r++) {
    if (r % 2 === 0) {
      sheet.getRange(r + 2, 1, 1, 12).setBackground(BG_SURFACE);
    }
  }

  // Auto-resize and tab color
  for (let i = 1; i <= 12; i++) sheet.autoResizeColumn(i);
  sheet.setHiddenGridlines(true);
  sheet.setTabColor(TEAL);
}

function formatDashboard_(sheet, rows) {
  // Dark aurora-inspired palette for Google Sheets
  // (Sheets doesn't support true dark mode, so we use a deep navy base)
  const BG_DARK = "#0d1117";
  const BG_SURFACE = "#161b22";
  const BG_SURFACE2 = "#1c2129";
  const TEXT_PRIMARY = "#e6dfd6";
  const TEXT_MUTED = "#8b949e";
  const WARM = "#d4a574";
  const WARM_GLOW = "#c8856c";
  const TEAL = "#5a8f8f";
  const SECTION_BG = "#1a2030";

  // Full sheet dark background
  const totalRows = Math.max(rows.length, 50);
  sheet.getRange(1, 1, totalRows, 6).setBackground(BG_DARK).setFontColor(TEXT_PRIMARY)
    .setFontFamily("Inter,system-ui,sans-serif").setFontSize(11).setFontWeight("normal");

  // Title — large, light weight
  sheet.getRange(1, 1, 1, 6).merge()
    .setFontSize(22).setFontWeight("normal").setFontColor(TEXT_PRIMARY);

  // Subtitle
  sheet.getRange(2, 1, 1, 6).merge()
    .setFontSize(10).setFontStyle("italic").setFontColor(TEXT_MUTED);

  // Summary card labels — warm accent bar
  sheet.getRange(4, 1, 1, 6)
    .setBackground(BG_SURFACE).setFontColor(WARM).setFontWeight("bold")
    .setFontSize(9).setHorizontalAlignment("center");

  // Summary card values
  sheet.getRange(5, 1, 1, 6)
    .setBackground(BG_SURFACE2).setFontWeight("bold").setFontSize(16)
    .setFontColor(WARM_GLOW).setHorizontalAlignment("center").setNumberFormat("$#,##0.00");
  sheet.getRange(5, 4).setNumberFormat("0").setFontColor(TEAL); // Active count

  // Section headers
  const sectionKeywords = ["MONTHLY SPENDING TREND", "SPENDING BY CATEGORY", "TOP MERCHANTS", "UPCOMING SUBSCRIPTION CHARGES"];
  for (let r = 0; r < rows.length; r++) {
    if (rows[r][0] && sectionKeywords.includes(rows[r][0])) {
      sheet.getRange(r + 1, 1, 1, 6)
        .setFontSize(12).setFontWeight("bold").setFontColor(WARM)
        .setBackground(BG_DARK);
      // Column headers (row after section title)
      if (r + 1 < rows.length) {
        sheet.getRange(r + 2, 1, 1, 6)
          .setBackground(SECTION_BG).setFontWeight("bold").setFontSize(9)
          .setFontColor(TEXT_MUTED);
      }
    }
    // Currency formatting for data rows
    if (typeof rows[r][1] === "number" && r > 5) {
      sheet.getRange(r + 1, 2).setNumberFormat("$#,##0.00");
    }
    if (typeof rows[r][3] === "number" && r > 5) {
      sheet.getRange(r + 1, 4).setNumberFormat("$#,##0.00");
    }
    // Alternating row tint for data rows
    if (r > 5 && rows[r][0] && !sectionKeywords.includes(rows[r][0]) && rows[r][0] !== "") {
      const isEvenData = r % 2 === 0;
      if (isEvenData) {
        sheet.getRange(r + 1, 1, 1, 6).setBackground(BG_SURFACE);
      }
    }
  }

  // Column widths
  [200, 150, 150, 170, 150, 150].forEach((px, i) => sheet.setColumnWidth(i + 1, px));

  // Hide gridlines and set tab color
  sheet.setHiddenGridlines(true);
  sheet.setTabColor(WARM);
}
