// ============================================================================
// Benchmarks — S&P 500 daily closes for portfolio comparison
// ============================================================================
// Source: Stooq (https://stooq.com) — free daily-close CSVs, no API key.
// Closes are cached in the benchmark_prices table so the dashboard never
// blocks on (or hammers) the external source: ensureBenchmark() fetches at
// most once per UTC day and only the missing date range. Every failure path
// is graceful — the caller renders the portfolio line without a benchmark
// rather than erroring the whole performance-history response.
//
// ^spx is the S&P 500 index itself (price return, no dividends). That makes
// the comparison slightly conservative vs a total-return benchmark — fine
// for a personal "am I roughly tracking the market?" signal.

const SYMBOL = "^spx";
const STOOQ_URL = (d1, d2) =>
  `https://stooq.com/q/d/l/?s=${encodeURIComponent(SYMBOL)}&d1=${d1}&d2=${d2}&i=d`;
const FETCH_TIMEOUT_MS = 10000;

// In-memory once-per-day fetch gate (cheap; the DB max(price_date) check is
// the durable gate — this just avoids re-querying after a failed fetch).
let _lastAttemptDay = null;

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// Parse Stooq's daily CSV ("Date,Open,High,Low,Close,Volume") into
// [{ date: 'YYYY-MM-DD', close: Number }]. Tolerant of garbage: non-CSV
// bodies, missing columns, and unparseable rows yield [] / are skipped.
function parseStooqCsv(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^date,open,high,low,close/i.test(lines[0])) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const date = cols[0];
    const close = parseFloat(cols[4]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
    out.push({ date, close });
  }
  return out;
}

// Make sure benchmark_prices covers the trailing `months` window, fetching
// the missing range from Stooq when needed. Returns true when the table has
// usable coverage, false when it doesn't (fetch failed / source down) —
// NEVER throws. `fetchImpl` is injectable for tests.
async function ensureBenchmark(pool, months, { fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  try {
    const today = new Date();
    const start = new Date(today);
    start.setMonth(start.getMonth() - months);

    const cov = await pool.query(
      "SELECT MIN(price_date) AS min_d, MAX(price_date) AS max_d FROM benchmark_prices WHERE symbol = $1",
      [SYMBOL]
    );
    const minD = cov.rows[0]?.min_d ? new Date(cov.rows[0].min_d) : null;
    const maxD = cov.rows[0]?.max_d ? new Date(cov.rows[0].max_d) : null;

    // Fresh enough (markets close on weekends/holidays — allow a 4-day lag)
    // and covering the window start → nothing to do.
    const FOUR_DAYS = 4 * 24 * 60 * 60 * 1000;
    const fresh = maxD && (today - maxD) < FOUR_DAYS;
    const covered = minD && minD <= start;
    if (fresh && covered) return true;

    // At most one fetch attempt per UTC day, even if it fails — Stooq being
    // down shouldn't add a 10s stall to every dashboard load all day.
    const dayKey = ymd(today);
    if (_lastAttemptDay === dayKey) return !!(maxD && covered);
    _lastAttemptDay = dayKey;

    // Fetch the union of what's missing: from min(needed start, day after
    // existing max) so one call fills both a stale tail and a short head.
    let from = start;
    if (covered && maxD) {
      from = new Date(maxD);
      from.setDate(from.getDate() + 1);
    }
    const d1 = ymd(from).replace(/-/g, "");
    const d2 = ymd(today).replace(/-/g, "");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let body;
    try {
      const res = await doFetch(STOOQ_URL(d1, d2), { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      body = await res.text();
    } finally {
      clearTimeout(timer);
    }

    const rows = parseStooqCsv(body);
    for (const r of rows) {
      await pool.query(
        `INSERT INTO benchmark_prices (symbol, price_date, close)
         VALUES ($1, $2, $3)
         ON CONFLICT (symbol, price_date) DO UPDATE SET close = EXCLUDED.close`,
        [SYMBOL, r.date, r.close]
      );
    }
    if (rows.length > 0) return true;
    // Empty body with prior coverage: stale but usable.
    return !!maxD;
  } catch (err) {
    console.error("Benchmark refresh error:", err.message);
    return false;
  }
}

// Trailing window of cached closes, oldest first. Never throws.
async function getBenchmarkSeries(pool, months) {
  try {
    const r = await pool.query(
      `SELECT price_date::text AS date, close
       FROM benchmark_prices
       WHERE symbol = $1 AND price_date >= CURRENT_DATE - make_interval(months => $2)
       ORDER BY price_date`,
      [SYMBOL, months]
    );
    return r.rows.map((row) => ({ date: row.date.slice(0, 10), close: parseFloat(row.close) }));
  } catch (err) {
    console.error("Benchmark series read error:", err.message);
    return [];
  }
}

module.exports = {
  SYMBOL,
  parseStooqCsv,
  ensureBenchmark,
  getBenchmarkSeries,
  // exported for tests
  _resetFetchGate: () => { _lastAttemptDay = null; },
};
