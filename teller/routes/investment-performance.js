// ============================================================================
// Investment performance — external cash flows (Plaid + manual), TWR/XIRR,
// and the portfolio-vs-benchmark history endpoint.
// ============================================================================
// Extracted from routes/investments.js (route-file split). investments.js
// mounts this router and re-exports the helpers, so existing import paths
// (`require("./routes/investments").computeTWR` etc.) are unchanged.

const express = require("express");
const router = express.Router();
const { pool, ENCRYPTION_PASSPHRASE } = require("../services/database");
const { INVESTMENT_ACCOUNT_TYPES } = require("../services/financial-queries");
const { getPlaidClient } = require("../services/plaid-client");

// =========================================================================
// Portfolio value history vs S&P 500 benchmark (roadmap #4 completion)
// =========================================================================

// Build a daily total-portfolio series from raw snapshot rows
// ({ snapshot_date, source, source_id, balance }, ordered by date ASC).
// Forward-fills each account's last known balance across the date axis so a
// day where only some accounts synced doesn't show as a phantom dip; an
// account's first snapshot simply starts contributing from that day (no
// backfill — before that day the value genuinely wasn't tracked).
// Pure function — exported for tests.
function buildPortfolioSeries(rows) {
  if (!rows || rows.length === 0) return [];
  const dates = [];
  const seen = new Set();
  for (const r of rows) {
    const d = (r.snapshot_date instanceof Date)
      ? r.snapshot_date.toISOString().slice(0, 10)
      : String(r.snapshot_date).slice(0, 10);
    if (!seen.has(d)) { seen.add(d); dates.push(d); }
  }
  dates.sort();
  const byDate = {};
  for (const r of rows) {
    const d = (r.snapshot_date instanceof Date)
      ? r.snapshot_date.toISOString().slice(0, 10)
      : String(r.snapshot_date).slice(0, 10);
    (byDate[d] = byDate[d] || []).push(r);
  }
  const lastKnown = {}; // "source:source_id" → balance
  const series = [];
  for (const d of dates) {
    for (const r of (byDate[d] || [])) {
      lastKnown[r.source + ":" + r.source_id] = parseFloat(r.balance) || 0;
    }
    let total = 0;
    for (const v of Object.values(lastKnown)) total += v;
    series.push({ date: d, value: Math.round(total * 100) / 100 });
  }
  return series;
}

// -------------------------------------------------------------------------
// External cash flows (TWR/XIRR) — Plaid investmentsTransactionsGet + manual
// -------------------------------------------------------------------------

// Classify a Plaid investment transaction as an external portfolio cash flow
// or null (internal activity / return component). Plaid's sign convention:
// cash INFLOW = negative amount, outflow = positive — but for cash deposits/
// withdrawals we derive the sign from the SUBTYPE (robust against any
// institution-level convention drift) and only fall back to amount-sign
// negation for in-kind transfers. Returned `amount` is OUR convention:
// positive = money into the portfolio.
//
// Not flows (return components / internal churn): buy, sell, fee, cancel,
// and cash subtypes like dividend / interest / capital gains / tax — those
// are what the return MEASURES. Corporate actions (merger, spin off, split,
// exercise, assignment) are value-reorganizations, not flows. Unknown
// transfer subtypes are conservatively skipped rather than fabricating a
// flow. Pure function — exported for tests.
const FLOW_CASH_IN = new Set(["deposit", "contribution"]);
const FLOW_CASH_OUT = new Set(["withdrawal", "distribution"]);
const FLOW_TRANSFER = new Set(["send", "receive", "transfer"]);
function classifyPlaidFlow(txn) {
  const type = String(txn.type || "").toLowerCase();
  const sub = String(txn.subtype || "").toLowerCase();
  const amt = parseFloat(txn.amount);
  if (!Number.isFinite(amt) || amt === 0) return null;
  if (type === "cash") {
    if (FLOW_CASH_IN.has(sub)) return { amount: Math.abs(amt), flow_type: "contribution" };
    if (FLOW_CASH_OUT.has(sub)) return { amount: -Math.abs(amt), flow_type: "withdrawal" };
    return null;
  }
  if (type === "transfer") {
    if (!FLOW_TRANSFER.has(sub)) return null;
    const flow = -amt; // Plaid inflow-negative → negate for into-portfolio-positive
    return { amount: flow, flow_type: flow >= 0 ? "transfer_in" : "transfer_out" };
  }
  return null;
}

// Sync external cash flows for every Plaid investment item via
// investmentsTransactionsGet. Deliberately fetches the FULL trailing window
// (Plaid serves up to ~24 months) on every run instead of keeping a
// watermark: a personal account has a few hundred investment transactions in
// two years (≤1 page), the UNIQUE plaid_investment_transaction_id makes
// re-pulls idempotent (ON CONFLICT DO NOTHING), and watermark bookkeeping is
// exactly where a newly-linked second item would silently lose its history.
// Same reconcile-over-cleverness philosophy as reconcileTeller.
const FLOW_BACKFILL_DAYS = 730;
const FLOW_PAGE_SIZE = 500;
const FLOW_MAX_PAGES = 30;
async function syncAllPlaidInvestmentFlows() {
  const client = getPlaidClient();
  if (!client) return { ok: false, error: "Plaid not configured" };
  try {
    // Same item UNION as syncAllPlaidHoldings: the registry plus any GOOD
    // plaid_items with an investment-type account in linked_accounts.
    const items = await pool.query(
      `SELECT DISTINCT ON (item_id) item_id, institution_name, access_token FROM (
         SELECT item_id, institution_name,
                pgp_sym_decrypt(access_token_enc, $1) AS access_token, 1 AS src
         FROM plaid_investment_items
         UNION ALL
         SELECT pi.item_id, pi.institution_name,
                pgp_sym_decrypt(pi.access_token_enc, $1) AS access_token, 2 AS src
         FROM plaid_items pi
         WHERE pi.status = 'GOOD' AND EXISTS (
           SELECT 1 FROM linked_accounts la
           WHERE la.plaid_item_id = pi.id AND ${INVESTMENT_ACCOUNT_TYPES}
         )
       ) u
       ORDER BY item_id, src`,
      [ENCRYPTION_PASSPHRASE]
    );
    const acctRows = await pool.query(
      "SELECT id, plaid_account_id FROM investment_accounts WHERE plaid_account_id IS NOT NULL"
    );
    const acctMap = {};
    for (const r of acctRows.rows) acctMap[r.plaid_account_id] = r.id;

    const end = new Date();
    const start = new Date(end.getTime() - FLOW_BACKFILL_DAYS * 86400000);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    let flowsAdded = 0, itemsSynced = 0;
    const errors = [];
    for (const item of items.rows) {
      try {
        if (!item.access_token) {
          errors.push({ institution: item.institution_name, error: "decryption_failed" });
          continue;
        }
        let offset = 0, total = Infinity, pages = 0;
        while (offset < total && pages < FLOW_MAX_PAGES) {
          const resp = await client.investmentsTransactionsGet({
            access_token: item.access_token,
            start_date: startStr,
            end_date: endStr,
            options: { count: FLOW_PAGE_SIZE, offset },
          });
          total = resp.data.total_investment_transactions ?? 0;
          const txns = resp.data.investment_transactions || [];
          for (const t of txns) {
            const localId = acctMap[t.account_id];
            if (!localId) continue; // account not tracked in investment_accounts
            const flow = classifyPlaidFlow(t);
            if (!flow) continue;
            const ins = await pool.query(
              `INSERT INTO investment_flows
                 (source, source_id, flow_date, amount, flow_type, provenance, plaid_investment_transaction_id, name)
               VALUES ('investment', $1, $2, $3, $4, 'plaid', $5, $6)
               ON CONFLICT (plaid_investment_transaction_id) DO NOTHING`,
              [localId, t.date, flow.amount, flow.flow_type, t.investment_transaction_id, t.name || null]
            );
            flowsAdded += ins.rowCount;
          }
          offset += txns.length;
          pages++;
          if (txns.length === 0) break; // defensive: empty page = done
        }
        itemsSynced++;
      } catch (err) {
        const code = err.response?.data?.error_code || err.message;
        console.error(`Investment flows sync error (${item.institution_name}):`, code);
        errors.push({ institution: item.institution_name, error: String(code) });
      }
    }
    return { ok: true, flows_added: flowsAdded, items_synced: itemsSynced, ...(errors.length ? { errors } : {}) };
  } catch (err) {
    console.error("syncAllPlaidInvestmentFlows error:", err.message);
    return { ok: false, error: "An internal error occurred." };
  }
}

// POST /api/plaid/sync-flows — thin wrapper for manual trigger
router.post("/api/plaid/sync-flows", async (_req, res) => {
  const result = await syncAllPlaidInvestmentFlows();
  if (!result.ok) return res.status(result.error === "Plaid not configured" ? 501 : 500).json(result);
  res.json(result);
});

// GET /api/investment-flows — list flows (query: months, default 24)
router.get("/api/investment-flows", async (req, res) => {
  const months = Math.min(60, Math.max(1, parseInt(req.query.months) || 24));
  try {
    const r = await pool.query(
      `SELECT f.id, f.source, f.source_id, f.flow_date::text AS flow_date, f.amount,
              f.flow_type, f.provenance, f.name,
              COALESCE(ia.name, la.name) AS account_name
       FROM investment_flows f
       LEFT JOIN investment_accounts ia ON f.source = 'investment' AND ia.id = f.source_id
       LEFT JOIN linked_accounts la ON f.source = 'linked' AND la.id = f.source_id
       WHERE f.flow_date >= CURRENT_DATE - make_interval(months => $1)
       ORDER BY f.flow_date DESC, f.id DESC
       LIMIT 300`,
      [months]
    );
    res.json({ flows: r.rows });
  } catch (err) {
    console.error("investment-flows list error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/investment-flows — log a manual contribution/withdrawal for an
// account Plaid can't see (Teller-linked or manual investment accounts).
// Body: { source?: 'investment'|'linked', source_id, flow_date: 'YYYY-MM-DD',
//         amount, flow_type: 'contribution'|'withdrawal' }.
// The sign is derived from flow_type (contribution → +, withdrawal → −)
// regardless of the submitted sign, so the UI can't store an inverted flow.
router.post("/api/investment-flows", async (req, res) => {
  try {
    const source = req.body.source === "linked" ? "linked" : "investment";
    const sourceId = parseInt(req.body.source_id);
    const flowDate = String(req.body.flow_date || "");
    const flowType = req.body.flow_type;
    const rawAmount = parseFloat(req.body.amount);
    if (!Number.isInteger(sourceId) || sourceId < 1) return res.status(400).json({ error: "source_id is required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flowDate) || isNaN(new Date(flowDate).getTime())) {
      return res.status(400).json({ error: "flow_date must be YYYY-MM-DD" });
    }
    if (!["contribution", "withdrawal"].includes(flowType)) {
      return res.status(400).json({ error: "flow_type must be 'contribution' or 'withdrawal'" });
    }
    if (!Number.isFinite(rawAmount) || rawAmount === 0 || Math.abs(rawAmount) > 1e9) {
      return res.status(400).json({ error: "amount must be a non-zero number" });
    }
    const table = source === "linked" ? "linked_accounts" : "investment_accounts";
    const exists = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [sourceId]);
    if (exists.rows.length === 0) return res.status(400).json({ error: "Account not found" });
    const amount = flowType === "contribution" ? Math.abs(rawAmount) : -Math.abs(rawAmount);
    const ins = await pool.query(
      `INSERT INTO investment_flows (source, source_id, flow_date, amount, flow_type, provenance)
       VALUES ($1, $2, $3, $4, $5, 'manual') RETURNING *`,
      [source, sourceId, flowDate, amount, flowType]
    );
    res.json(ins.rows[0]);
  } catch (err) {
    console.error("investment-flows create error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/investment-flows/:id — manual rows only. Plaid-sourced rows
// are protected: deleting one would just resurrect on the next sync (and
// silently skew TWR until then).
router.delete("/api/investment-flows/:id", async (req, res) => {
  try {
    const del = await pool.query(
      "DELETE FROM investment_flows WHERE id = $1 AND provenance = 'manual' RETURNING id",
      [req.params.id]
    );
    if (del.rows.length === 0) return res.status(404).json({ error: "Manual flow not found" });
    res.json({ deleted: true });
  } catch (err) {
    console.error("investment-flows delete error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// True time-weighted return over a daily-valued series. `flowsByDate` maps a
// series date → net external flow bucketed to that date (end-of-day
// convention: the flow is assumed to land AFTER yesterday's close, so it's
// removed from today's value before measuring growth on yesterday's base).
// With daily valuations this is exact — no Modified-Dietz approximation.
// Returns cumulative % for the window, or null. Pure — exported for tests.
function computeTWR(series, flowsByDate) {
  if (!series || series.length < 2) return null;
  let chain = 1;
  let usable = false;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].value;
    if (prev <= 0) continue; // no base to measure growth from
    const flow = flowsByDate[series[i].date] || 0;
    const r = (series[i].value - flow) / prev - 1;
    if (r <= -1) continue; // pathological (flow > value) — skip, don't zero the chain
    chain *= 1 + r;
    usable = true;
  }
  return usable ? (chain - 1) * 100 : null;
}

// Annualized money-weighted return (XIRR) via bisection on NPV.
// `cashflows` = [{ date, amount }] from the INVESTOR's perspective: money in
// (initial value, contributions) negative, money out (withdrawals, final
// value) positive. Returns annualized %, or null when a root can't be
// bracketed (all-same-sign flows, degenerate windows). Pure — exported.
function computeXIRR(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;
  const t0 = new Date(cashflows[0].date).getTime();
  const flows = cashflows.map((c) => ({
    years: (new Date(c.date).getTime() - t0) / (365.25 * 86400000),
    amount: c.amount,
  }));
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;
  const npv = (r) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, f.years), 0);
  let lo = -0.9999, hi = 10;
  let fLo = npv(lo), fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < 1e-9) return mid * 100;
    if (fLo * fMid < 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  return ((lo + hi) / 2) * 100;
}

// GET /api/investments/performance-history — portfolio value over time vs
// the S&P 500 (query: months=3-60, default 12).
//
// Portfolio series = sum of daily account_balance_snapshots across all
// investment accounts: source='investment' rows (Plaid + manual) plus
// source='linked' rows for Teller-linked investment-type accounts —
// excluding linked rows whose account_id has an active
// investment_accounts.plaid_account_id twin (same dedupe direction as
// getNetWorth / GET /api/investments: investment_accounts is authoritative
// for Plaid brokerages, the linked_accounts row is the $0 phantom).
//
// Benchmark = cached S&P 500 closes (services/benchmarks.js; lazily fetched
// from Stooq at most once/day). When the benchmark is unavailable (source
// down, network-restricted deploy) the response carries benchmark: null and
// the portfolio series still renders.
//
// Returns are point-to-point on account VALUE, so contributions count as
// growth — that's by design for this endpoint (it answers "what is the line
// doing?"); the contribution-adjusted number is /api/investments/performance's
// cost-basis return. Flow-attribution for a true time-weighted return isn't
// reliably possible from balance snapshots alone (noted in the response).
router.get("/api/investments/performance-history", async (req, res) => {
  const months = Math.min(60, Math.max(3, parseInt(req.query.months) || 12));
  try {
    const snaps = await pool.query(
      `SELECT s.snapshot_date, s.source, s.source_id, s.balance
       FROM account_balance_snapshots s
       WHERE s.snapshot_date >= CURRENT_DATE - make_interval(months => $1)
         AND (
           (s.source = 'investment' AND s.source_id IN (
              SELECT id FROM investment_accounts WHERE is_active = true))
           OR
           (s.source = 'linked' AND s.source_id IN (
              SELECT la.id FROM linked_accounts la
              WHERE ${INVESTMENT_ACCOUNT_TYPES}
                AND NOT EXISTS (
                  SELECT 1 FROM investment_accounts ia
                  WHERE ia.plaid_account_id = la.account_id AND ia.is_active = true)))
         )
       ORDER BY s.snapshot_date`,
      [months]
    );
    const portfolio = buildPortfolioSeries(snaps.rows);

    let benchmark = null;
    let excess = null;
    let portfolioReturnPct = null;
    if (portfolio.length >= 2) {
      const first = portfolio[0].value;
      const last = portfolio[portfolio.length - 1].value;
      portfolioReturnPct = first > 0 ? ((last - first) / first) * 100 : null;
    }
    try {
      const benchmarks = require("../services/benchmarks");
      await benchmarks.ensureBenchmark(pool, months);
      let series = await benchmarks.getBenchmarkSeries(pool, months);
      if (portfolio.length >= 2 && series.length >= 2) {
        // Trim the benchmark to the portfolio's window so both lines cover
        // the same period and the return comparison is apples-to-apples.
        const startD = portfolio[0].date;
        const endD = portfolio[portfolio.length - 1].date;
        series = series.filter((b) => b.date >= startD && b.date <= endD);
        if (series.length >= 2) {
          const bFirst = series[0].close;
          const bLast = series[series.length - 1].close;
          const benchReturnPct = bFirst > 0 ? ((bLast - bFirst) / bFirst) * 100 : null;
          benchmark = {
            symbol: "S&P 500",
            series,
            return_pct: benchReturnPct,
          };
          if (portfolioReturnPct !== null && benchReturnPct !== null) {
            excess = portfolioReturnPct - benchReturnPct;
          }
        }
      }
    } catch (err) {
      console.error("performance-history benchmark error:", err.message);
    }

    // --- TWR / XIRR over flow-covered accounts ---
    // "Covered" = accounts whose external flows are actually tracked: every
    // Plaid-synced investment_accounts row (investmentsTransactionsGet feeds
    // investment_flows for them) plus any account with at least one manual
    // flow logged. Computing TWR over UNcovered accounts would silently treat
    // their contributions as market gains — so the figures are scoped and the
    // response says how much of the portfolio they cover.
    let twrPct = null, xirrPct = null, flowCoverage = null;
    try {
      const [plaidCovered, flowAccounts, flowsRes] = await Promise.all([
        pool.query("SELECT id FROM investment_accounts WHERE plaid_account_id IS NOT NULL AND is_active = true"),
        pool.query("SELECT DISTINCT source, source_id FROM investment_flows"),
        pool.query(
          `SELECT source, source_id, flow_date::text AS flow_date, amount
           FROM investment_flows
           WHERE flow_date >= CURRENT_DATE - make_interval(months => $1)
           ORDER BY flow_date`,
          [months]
        ),
      ]);
      const covered = new Set(plaidCovered.rows.map((r) => "investment:" + r.id));
      for (const r of flowAccounts.rows) covered.add(r.source + ":" + r.source_id);

      const coveredRows = snaps.rows.filter((r) => covered.has(r.source + ":" + r.source_id));
      const coveredSeries = buildPortfolioSeries(coveredRows);

      if (coveredSeries.length >= 2) {
        // Bucket each flow onto the first snapshot date >= its flow_date
        // (end-of-day convention). Flows on/before the first snapshot are part
        // of the starting value, not the measured window; flows from covered
        // accounts only.
        const flowsByDate = {};
        const cashflows = [{ date: coveredSeries[0].date, amount: -coveredSeries[0].value }];
        let netFlows = 0, flowsCount = 0;
        let si = 1;
        for (const f of flowsRes.rows) {
          if (!covered.has(f.source + ":" + f.source_id)) continue;
          const d = f.flow_date.slice(0, 10);
          if (d <= coveredSeries[0].date) continue;
          if (d > coveredSeries[coveredSeries.length - 1].date) continue;
          while (si < coveredSeries.length && coveredSeries[si].date < d) si++;
          if (si >= coveredSeries.length) break;
          const bucket = coveredSeries[si].date;
          const amt = parseFloat(f.amount) || 0;
          flowsByDate[bucket] = (flowsByDate[bucket] || 0) + amt;
          cashflows.push({ date: d, amount: -amt }); // investor perspective
          netFlows += amt;
          flowsCount++;
        }
        cashflows.push({
          date: coveredSeries[coveredSeries.length - 1].date,
          amount: coveredSeries[coveredSeries.length - 1].value,
        });

        twrPct = computeTWR(coveredSeries, flowsByDate);
        xirrPct = computeXIRR(cashflows);

        const totalLatest = portfolio.length ? portfolio[portfolio.length - 1].value : 0;
        const coveredLatest = coveredSeries[coveredSeries.length - 1].value;
        const coveragePct = totalLatest > 0 ? Math.min(100, (coveredLatest / totalLatest) * 100) : 0;
        flowCoverage = {
          coverage_pct: Math.round(coveragePct * 10) / 10,
          flows_count: flowsCount,
          net_flows: Math.round(netFlows * 100) / 100,
          scope: coveragePct >= 99.5 ? "all" : (coveragePct > 0 ? "partial" : "none"),
        };
      }
    } catch (err) {
      console.error("performance-history TWR/XIRR error:", err.message);
    }

    res.json({
      months,
      start_date: portfolio.length ? portfolio[0].date : null,
      end_date: portfolio.length ? portfolio[portfolio.length - 1].date : null,
      portfolio,
      portfolio_return_pct: portfolioReturnPct,
      benchmark,
      excess_return_pct: excess,
      twr_pct: twrPct,
      xirr_pct: xirrPct,
      flow_coverage: flowCoverage,
      note: "Portfolio return is point-to-point on account value (contributions count as growth). twr_pct/xirr_pct are flow-adjusted, computed over flow-covered accounts only (see flow_coverage.scope).",
    });
  } catch (err) {
    console.error("performance-history error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});


module.exports = router;
// Helper exports attached AFTER module.exports = router (INV-19).
module.exports.buildPortfolioSeries = buildPortfolioSeries;
module.exports.classifyPlaidFlow = classifyPlaidFlow;
module.exports.computeTWR = computeTWR;
module.exports.computeXIRR = computeXIRR;
module.exports.syncAllPlaidInvestmentFlows = syncAllPlaidInvestmentFlows;
