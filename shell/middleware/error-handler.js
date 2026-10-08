// ============================================================================
// Shell error handler (PSC-4)
// ============================================================================
// NODE_ENV=production isn't set by every deploy config, and without it
// Express's default handler answers with a full stack trace — reachable BEFORE
// auth (malformed JSON posted to /login fails in the shell's body parser) and
// for any error bubbling out of a mounted sub-app. This keeps the status code
// and a short message, logs 5xx server-side, and never exposes the stack.

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const raw = err && (err.status || err.statusCode);
  const status = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
  if (status >= 500) console.error("Shell error:", err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  const message = status === 413 ? "Request body too large."
    : err && err.type === "entity.parse.failed" ? "Malformed request body."
    : status >= 500 ? "Internal server error." : "Bad request.";
  if (req.method === "GET" && req.accepts(["json", "html"]) === "html") {
    return res.status(status).type("text").send(message);
  }
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
