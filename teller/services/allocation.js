// Asset-class allocation (roadmap T4.1 A7) — the ONE definition behind the
// Investments card's by_asset_class (GET /api/investments/performance) and the
// cash plan's rebalancing directions (services/advice.js), so the two can't
// disagree about a class's share or its drift from the target.
//
// Holdings come from investment_holdings (Plaid only — Teller-linked accounts
// have no per-security data) on active (or unmatched) investment accounts.
// A class is the lowercased security_type; targets are
// user_settings.target_allocation_pct ({ class: pct }), keys lowercased.

const HOLDINGS_SQL = `
  SELECT h.name, h.ticker, h.quantity, h.cost_basis, h.current_value,
         h.security_type, h.plaid_account_id, ia.name AS account_name
  FROM investment_holdings h
  LEFT JOIN investment_accounts ia ON ia.plaid_account_id = h.plaid_account_id
  WHERE COALESCE(ia.is_active, true) = true`;

// { class: number } from the stored JSONB (an object, or a string from an
// older driver); non-numbers dropped, keys lowercased.
function normalizeTargets(raw) {
  let targets = raw || {};
  if (typeof targets === "string") {
    try { targets = JSON.parse(targets); } catch { targets = {}; } // unparseable → no targets
  }
  const map = {};
  for (const [k, v] of Object.entries(targets || {})) {
    const n = Number(v);
    if (Number.isFinite(n)) map[String(k).toLowerCase()] = n;
  }
  return map;
}

// Pure: per class value, cost basis (known-basis holdings only — BSI-5),
// share of the portfolio and, with targets, target_pct and drift_pct
// (actual − target; positive = overweight). A targeted class with no holdings
// is listed at 0% (underweight by its whole target). Classes by value,
// largest first, then the zero-holding targets.
function assetAllocation(rows, targetMap = {}) {
  let totalValue = 0;
  const byClass = {};
  for (const h of rows || []) {
    const value = parseFloat(h.current_value || 0);
    const known = h.cost_basis != null && Number.isFinite(parseFloat(h.cost_basis));
    totalValue += value;
    const cls = (h.security_type || "unknown").toLowerCase();
    if (!byClass[cls]) byClass[cls] = { security_type: cls, value: 0, cost_basis: 0, value_with_basis: 0 };
    byClass[cls].value += value;
    if (known) {
      byClass[cls].cost_basis += parseFloat(h.cost_basis);
      byClass[cls].value_with_basis += value;
    }
  }
  const hasTargets = Object.keys(targetMap).length > 0;
  const classes = Object.values(byClass).map((c) => {
    const row = { ...c, pct_of_portfolio: totalValue > 0 ? (c.value / totalValue) * 100 : 0 };
    if (hasTargets && Number.isFinite(targetMap[c.security_type])) {
      row.target_pct = targetMap[c.security_type];
      row.drift_pct = row.pct_of_portfolio - row.target_pct;
    }
    return row;
  }).sort((a, b) => b.value - a.value);
  if (hasTargets) {
    const present = new Set(classes.map((c) => c.security_type));
    for (const [cls, target] of Object.entries(targetMap)) {
      if (!present.has(cls)) {
        classes.push({ security_type: cls, value: 0, cost_basis: 0, value_with_basis: 0, pct_of_portfolio: 0, target_pct: target, drift_pct: -target });
      }
    }
  }
  return { total_value: totalValue, has_targets: hasTargets, classes };
}

module.exports = { HOLDINGS_SQL, normalizeTargets, assetAllocation };
