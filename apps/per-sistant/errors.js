// ============================================================================
// Per-sistant — shared error responder
// ============================================================================
// Logs the real error server-side and returns a GENERIC client message so
// raw DB / internal error text (constraint names, SQL details) isn't leaked
// to the client (PB-2). Mirrors Perfin's "An internal error occurred."
// convention. Pass an optional status (defaults to 500).
function serverError(res, err, status = 500) {
  console.error("Per-sistant route error:", (err && err.message) ? err.message : err);
  res.status(status).json({ error: "An internal error occurred." });
}

module.exports = { serverError };
