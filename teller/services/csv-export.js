// ============================================================================
// CSV export helpers (SXE-13 / SXE-8)
// ============================================================================
// csvText: one quoted CSV TEXT field. Quotes are doubled (RFC 4180) and a value
// starting with = + - @ (or tab / CR) gets an apostrophe prefix so a spreadsheet
// opening the download treats it as text instead of evaluating a formula
// (merchant names, notes and memos are user/bank-controlled). Use it for text
// only — numeric fields (amounts) are written bare so negatives stay numbers.
// csvDate: a DATE value as 'YYYY-MM-DD' (node-pg returns DATE columns as JS
// Date objects at LOCAL midnight; interpolating one printed
// "Mon Jan 05 2026 00:00:00 GMT+0000 (…)", which spreadsheets don't parse —
// SXE-8 / PSC-10). Local getters, so the stored day survives any server TZ.
function csvText(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function csvDate(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

module.exports = { csvText, csvDate, isoDate: csvDate };
