// ============================================================================
// AI Audit — validates AI insight claims against actual data
// ============================================================================
// Runs after each AI analysis to check arithmetic, entity existence,
// trend direction, and internal consistency. Results stored in ai_audit_log.

const { pool } = require("../services/database");
const { getMonthlySpending, getMonthlyIncomeAndSpending, getCategorySpendingThisMonth } = require("./financial-queries");

// Extract dollar amounts from text: "$1,234.56" or "$500"
function extractDollarClaims(text) {
  const matches = [];
  const regex = /\$([0-9,]+(?:\.\d{1,2})?)\b/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(value) && value > 0) {
      const ctx = text.substring(Math.max(0, m.index - 80), m.index + m[0].length + 40).trim();
      matches.push({ value, context: ctx, index: m.index });
    }
  }
  return matches;
}

// Extract percentage claims: "18%", "up 15%"
function extractPercentClaims(text) {
  const matches = [];
  const regex = /(\d+(?:\.\d+)?)%/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const value = parseFloat(m[1]);
    if (!isNaN(value) && value > 0 && value < 1000) {
      const ctx = text.substring(Math.max(0, m.index - 80), m.index + m[0].length + 40).trim();
      matches.push({ value, context: ctx, index: m.index });
    }
  }
  return matches;
}

// Extract merchant/entity names mentioned in insight text
function extractMerchantNames(text) {
  const names = new Set();
  // Look for patterns like "Merchant: $X" or "at Merchant" or "from Merchant"
  const patterns = [
    /(?:at|from|to|for|cancelling?|cancel)\s+([A-Z][A-Za-z0-9. &'-]+)/g,
    /^[\-\*]\s*\*?\*?([A-Z][A-Za-z0-9. &'-]+)\*?\*?\s*[:—\-]/gm,
  ];
  for (const regex of patterns) {
    let m;
    while ((m = regex.exec(text)) !== null) {
      const name = m[1].trim().replace(/[.,:]+$/, "");
      if (name.length >= 3 && name.length <= 50) names.add(name);
    }
  }
  return [...names];
}

// Extract trend direction claims
function extractTrendClaims(text) {
  const claims = [];
  const patterns = [
    { regex: /\b([A-Z][\w &]{1,30}?)\s+(?:is|was|are|were)\s+(up|down|increasing|decreasing|higher|lower)\b/g, type: "direction" },
    { regex: /(?:spending\s+(?:on\s+)?)?([A-Z][\w &]{1,30}?)\s+(increased|decreased|rose|fell|dropped|grew)\b/g, type: "change" },
  ];
  for (const { regex, type } of patterns) {
    let m;
    while ((m = regex.exec(text)) !== null) {
      // Strip leading filler words so "Later we see Food" normalizes to "Food"
      const category = m[1].trim().replace(/^(?:.*\b(?:the|your|our|my|that|this|see|and|but|however|also|then|later|overall|total)\s+)+/i, "");
      const direction = (m[2] || "").toLowerCase();
      const isUp = /up|increas|higher|rose|grew/.test(direction);
      claims.push({ category, direction: isUp ? "up" : "down", type, context: m[0] });
    }
  }
  return claims;
}

// Detect self-contradictions
function findContradictions(text) {
  const contradictions = [];
  const trendClaims = extractTrendClaims(text);
  const seen = {};
  for (const claim of trendClaims) {
    const key = claim.category.toLowerCase();
    if (seen[key] && seen[key] !== claim.direction) {
      contradictions.push({
        category: claim.category,
        claim1: seen[key],
        claim2: claim.direction,
        context: claim.context,
      });
    }
    seen[key] = claim.direction;
  }
  return contradictions;
}

/**
 * Run all audit tiers against an insight text.
 * Returns { findings: [...], summary: { critical, warning, info } }
 */
async function auditInsight(insightText, insightId) {
  const findings = [];

  // ---- Tier 1: Arithmetic Validation ----
  try {
    const [monthlyData, incomeSpending, categorySpending] = await Promise.all([
      getMonthlySpending(pool, 6),
      getMonthlyIncomeAndSpending(pool, 6),
      getCategorySpendingThisMonth(pool),
    ]);

    // Build lookup of actual values
    const actualMonthly = {};
    for (const r of monthlyData) actualMonthly[r.month] = parseFloat(r.total_spend);
    const actualCategories = {};
    for (const r of categorySpending) actualCategories[r.category.toLowerCase()] = parseFloat(r.spent);
    const latestIncome = incomeSpending.length > 0 ? incomeSpending[incomeSpending.length - 1] : null;
    const actualSavingsRate = latestIncome && latestIncome.income > 0
      ? Math.round((1 - latestIncome.spending / latestIncome.income) * 100) : null;

    // Check subscription totals
    const subsResult = await pool.query(
      "SELECT COUNT(*) AS cnt, SUM(amount * 30.0 / cadence_days) AS monthly FROM detected_subscriptions WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL"
    ).catch(() => ({ rows: [{ cnt: 0, monthly: 0 }] }));
    const actualSubCount = parseInt(subsResult.rows[0].cnt);
    const actualSubMonthly = parseFloat(subsResult.rows[0].monthly || 0);

    // Check dollar claims against actuals
    const dollarClaims = extractDollarClaims(insightText);
    for (const claim of dollarClaims) {
      const ctx = claim.context.toLowerCase();
      // Check against category spending
      for (const [cat, actual] of Object.entries(actualCategories)) {
        if (ctx.includes(cat.toLowerCase()) && Math.abs(claim.value - actual) > 0.01) {
          const pctOff = actual > 0 ? Math.abs(claim.value - actual) / actual : 1;
          if (pctOff > 0.20) {
            findings.push({ severity: "critical", tier: 1, check: "arithmetic",
              claim: `$${claim.value.toFixed(2)} for ${cat}`, expected: `$${actual.toFixed(2)}`,
              pct_off: Math.round(pctOff * 100), context: claim.context });
          } else if (pctOff > 0.05) {
            findings.push({ severity: "warning", tier: 1, check: "arithmetic",
              claim: `$${claim.value.toFixed(2)} for ${cat}`, expected: `$${actual.toFixed(2)}`,
              pct_off: Math.round(pctOff * 100), context: claim.context });
          }
        }
      }
      // Check subscription total claims
      if (ctx.includes("subscription") && Math.abs(claim.value - actualSubMonthly) > 1) {
        const pctOff = actualSubMonthly > 0 ? Math.abs(claim.value - actualSubMonthly) / actualSubMonthly : 1;
        if (pctOff > 0.20) {
          findings.push({ severity: "critical", tier: 1, check: "subscription_total",
            claim: `$${claim.value.toFixed(2)}`, expected: `$${actualSubMonthly.toFixed(2)}`,
            pct_off: Math.round(pctOff * 100), context: claim.context });
        }
      }
    }

    // Check percentage claims (savings rate)
    const pctClaims = extractPercentClaims(insightText);
    for (const claim of pctClaims) {
      if (claim.context.toLowerCase().includes("savings rate") && actualSavingsRate !== null) {
        const diff = Math.abs(claim.value - actualSavingsRate);
        if (diff > 10) {
          findings.push({ severity: "critical", tier: 1, check: "savings_rate",
            claim: `${claim.value}%`, expected: `${actualSavingsRate}%`,
            pct_off: diff, context: claim.context });
        } else if (diff > 3) {
          findings.push({ severity: "warning", tier: 1, check: "savings_rate",
            claim: `${claim.value}%`, expected: `${actualSavingsRate}%`,
            pct_off: diff, context: claim.context });
        }
      }
    }
  } catch (err) {
    console.error("Audit Tier 1 error:", err.message);
  }

  // ---- Tier 2: Entity Existence ----
  try {
    const merchantNames = extractMerchantNames(insightText);
    if (merchantNames.length > 0) {
      const txnMerchants = await pool.query(
        "SELECT DISTINCT LOWER(COALESCE(user_merchant_name, merchant_name, name)) AS m FROM transactions WHERE pending = false LIMIT 5000"
      );
      const known = new Set(txnMerchants.rows.map(r => r.m?.toLowerCase()).filter(Boolean));
      const goals = await pool.query("SELECT name FROM financial_goals WHERE is_active = true");
      for (const g of goals.rows) known.add(g.name.toLowerCase());
      const subs = await pool.query("SELECT display_name FROM detected_subscriptions");
      for (const s of subs.rows) known.add(s.display_name.toLowerCase());

      for (const name of merchantNames) {
        const lower = name.toLowerCase();
        const exists = [...known].some(k => k.includes(lower) || lower.includes(k));
        if (!exists) {
          findings.push({ severity: "warning", tier: 2, check: "entity_existence",
            claim: name, expected: "Should exist in transactions/goals/subscriptions",
            context: `Mentioned "${name}" but no matching entity found in data` });
        }
      }
    }
  } catch (err) {
    console.error("Audit Tier 2 error:", err.message);
  }

  // ---- Tier 3: Trend Direction Verification ----
  try {
    const trendClaims = extractTrendClaims(insightText);
    if (trendClaims.length > 0) {
      const monthlyData = await getMonthlySpending(pool, 3);
      if (monthlyData.length >= 2) {
        const latest = parseFloat(monthlyData[monthlyData.length - 1].total_spend);
        const prior = parseFloat(monthlyData[monthlyData.length - 2].total_spend);
        const actualDirection = latest > prior ? "up" : "down";

        for (const claim of trendClaims) {
          if (claim.category.toLowerCase().includes("spending") || claim.category.toLowerCase().includes("total")) {
            if (claim.direction !== actualDirection && Math.abs(latest - prior) / Math.max(prior, 1) > 0.05) {
              findings.push({ severity: "warning", tier: 3, check: "trend_direction",
                claim: `${claim.category} is ${claim.direction}`,
                expected: `Actual direction is ${actualDirection} ($${prior.toFixed(0)} → $${latest.toFixed(0)})`,
                context: claim.context });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Audit Tier 3 error:", err.message);
  }

  // ---- Tier 4: Consistency (self-contradictions) ----
  try {
    const contradictions = findContradictions(insightText);
    for (const c of contradictions) {
      findings.push({ severity: "warning", tier: 4, check: "consistency",
        claim: `"${c.category}" claimed both ${c.claim1} and ${c.claim2}`,
        expected: "Consistent direction within the same report",
        context: c.context });
    }
  } catch (err) {
    console.error("Audit Tier 4 error:", err.message);
  }

  // Summarize
  const summary = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) summary[f.severity] = (summary[f.severity] || 0) + 1;

  // Persist to ai_audit_log
  for (const f of findings) {
    try {
      await pool.query(
        `INSERT INTO ai_audit_log (insight_id, module, severity, check_type, claim_text, expected_value, actual_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [insightId, f.check, f.severity, `tier${f.tier}`, f.claim || f.context, f.expected || "", f.context || ""]
      );
    } catch {}
  }

  return { findings, summary };
}

/**
 * Get audit stats for the last N insight runs
 */
async function getAuditStats(limit = 10) {
  try {
    const result = await pool.query(
      `SELECT insight_id, severity, COUNT(*) AS cnt
       FROM ai_audit_log
       WHERE created_at >= CURRENT_DATE - INTERVAL '90 days'
       GROUP BY insight_id, severity
       ORDER BY insight_id DESC
       LIMIT $1`,
      [limit * 5]
    );
    return result.rows;
  } catch {
    return [];
  }
}

/**
 * Compute high-level AI-accuracy metrics from `ai_audit_log` cross-referenced
 * with `financial_insights`. Surfaced in /api/insights/status and the audit
 * endpoint so the AI's verifiability is visible (rather than buried in a raw
 * findings table). Numbers cover the trailing 90 days.
 *
 * Returns:
 *   {
 *     total_audited_runs: int,
 *     clean_runs: int (no critical findings),
 *     accuracy_pct: number 0-100 (clean_runs / total_audited_runs),
 *     findings_by_severity: { critical, warning, info },
 *     findings_by_tier: { tier1, tier2, tier3, tier4 },
 *   }
 */
async function getAuditAccuracy(days = 90) {
  try {
    // Count audited insight runs (distinct insight_id with at least one audit
    // row) and runs without any critical finding.
    const runs = await pool.query(`
      WITH recent_audits AS (
        SELECT al.insight_id, MAX(CASE WHEN al.severity = 'critical' THEN 1 ELSE 0 END) AS has_critical
        FROM ai_audit_log al
        JOIN financial_insights fi ON fi.id = al.insight_id AND fi.entry_type = 'insight'
        WHERE al.created_at >= CURRENT_DATE - make_interval(days => $1)
        GROUP BY al.insight_id
      ),
      audited_inserted AS (
        SELECT id FROM financial_insights
        WHERE entry_type = 'insight'
          AND created_at >= CURRENT_DATE - make_interval(days => $1)
      )
      SELECT
        (SELECT COUNT(*) FROM audited_inserted) AS total_runs,
        COALESCE(SUM(CASE WHEN ra.has_critical = 0 THEN 1 ELSE 0 END), 0) AS clean_runs
      FROM audited_inserted ai
      LEFT JOIN recent_audits ra ON ra.insight_id = ai.id
    `, [days]);
    const totals = runs.rows[0] || { total_runs: 0, clean_runs: 0 };

    const sev = await pool.query(`
      SELECT severity, COUNT(*) AS cnt
      FROM ai_audit_log
      WHERE created_at >= CURRENT_DATE - make_interval(days => $1)
      GROUP BY severity
    `, [days]);
    const findings_by_severity = { critical: 0, warning: 0, info: 0 };
    for (const r of sev.rows) findings_by_severity[r.severity] = parseInt(r.cnt, 10);

    const tier = await pool.query(`
      SELECT check_type, COUNT(*) AS cnt
      FROM ai_audit_log
      WHERE created_at >= CURRENT_DATE - make_interval(days => $1)
      GROUP BY check_type
    `, [days]);
    const findings_by_tier = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
    for (const r of tier.rows) {
      if (findings_by_tier[r.check_type] !== undefined) findings_by_tier[r.check_type] = parseInt(r.cnt, 10);
    }

    const totalRuns = parseInt(totals.total_runs, 10) || 0;
    const cleanRuns = parseInt(totals.clean_runs, 10) || 0;
    return {
      window_days: days,
      total_audited_runs: totalRuns,
      clean_runs: cleanRuns,
      accuracy_pct: totalRuns > 0 ? Math.round((cleanRuns / totalRuns) * 1000) / 10 : null,
      findings_by_severity,
      findings_by_tier,
    };
  } catch (err) {
    console.error("getAuditAccuracy error:", err.message);
    return {
      window_days: days,
      total_audited_runs: 0,
      clean_runs: 0,
      accuracy_pct: null,
      findings_by_severity: { critical: 0, warning: 0, info: 0 },
      findings_by_tier: { tier1: 0, tier2: 0, tier3: 0, tier4: 0 },
    };
  }
}

module.exports = { auditInsight, getAuditStats, getAuditAccuracy, extractDollarClaims, extractPercentClaims, extractMerchantNames, extractTrendClaims, findContradictions };
