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

// Escape a string for safe insertion into a RegExp.
function reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// True when `needle` appears as a whole word/phrase in `haystack` (case-
// insensitive). Word boundaries prevent short tokens (a 3-char category name
// or known merchant) from substring-matching unrelated text (AI-2/AI-4).
function wordMatch(haystack, needle) {
  if (!needle) return false;
  return new RegExp("\\b" + reEscape(needle) + "\\b", "i").test(haystack);
}

// Decide whether a claimed entity name corresponds to something in the known
// set. Requires an exact match OR a whole-word containment in either direction
// where the shorter token is substantial (>=4 chars) — so a tiny known/claimed
// name ("car" goal, "ira") can't act as a universal substring wildcard that
// makes every claimed entity look "known" (AI-4).
function entityKnown(claimedLower, knownSet) {
  for (const k of knownSet) {
    if (!k) continue;
    if (k === claimedLower) return true;
    const shorter = k.length <= claimedLower.length ? k : claimedLower;
    const longer = k.length <= claimedLower.length ? claimedLower : k;
    if (shorter.length < 4) continue;
    if (wordMatch(longer, shorter)) return true;
  }
  return false;
}

/**
 * Run all audit tiers against an insight text.
 * Returns { findings: [...], summary: { critical, warning, info } }
 */
async function auditInsight(insightText, insightId) {
  const findings = [];
  // AI-5: track tiers that threw so a swallowed DB error in a tier isn't later
  // mistaken for "audited and clean". Any incomplete tier marks the whole run
  // incomplete, which getAuditAccuracy excludes from the clean/total tally.
  let incomplete = false;

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
      // Find the single BEST (longest = most specific) category whose name
      // appears as a whole word in the claim's context, and emit at most one
      // finding per dollar claim — word boundaries stop short category names
      // substring-matching unrelated text (AI-2), and the single-best choice
      // stops one claim producing several conflicting findings (AI-3).
      let bestCat = null, bestActual = null;
      for (const [cat, actual] of Object.entries(actualCategories)) {
        if (wordMatch(ctx, cat) && (bestCat === null || cat.length > bestCat.length)) {
          bestCat = cat; bestActual = actual;
        }
      }
      if (bestCat !== null && Math.abs(claim.value - bestActual) > 0.01) {
        const pctOff = bestActual > 0 ? Math.abs(claim.value - bestActual) / bestActual : 1;
        if (pctOff > 0.20) {
          findings.push({ severity: "critical", tier: 1, check: "arithmetic",
            claim: `$${claim.value.toFixed(2)} for ${bestCat}`, expected: `$${bestActual.toFixed(2)}`,
            pct_off: Math.round(pctOff * 100), context: claim.context });
        } else if (pctOff > 0.05) {
          findings.push({ severity: "warning", tier: 1, check: "arithmetic",
            claim: `$${claim.value.toFixed(2)} for ${bestCat}`, expected: `$${bestActual.toFixed(2)}`,
            pct_off: Math.round(pctOff * 100), context: claim.context });
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
    incomplete = true;
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
        // Whole-word match with a min-length guard (AI-4) instead of the old
        // bidirectional substring check, which let any short known entity make
        // every claimed name look "known" (so hallucinations slipped through).
        const exists = entityKnown(lower, known);
        if (!exists) {
          findings.push({ severity: "warning", tier: 2, check: "entity_existence",
            claim: name, expected: "Should exist in transactions/goals/subscriptions",
            context: `Mentioned "${name}" but no matching entity found in data` });
        }
      }
    }
  } catch (err) {
    console.error("Audit Tier 2 error:", err.message);
    incomplete = true;
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
          // Only verify claims about TOTAL/overall spending against the monthly
          // total. A category-specific claim ("Dining spending is down") was
          // previously matched here (its text contains "spending") and checked
          // against the TOTAL direction, producing false trend findings. We have
          // no reliable per-category monthly series in this tier, so we skip
          // category-specific claims rather than mis-flag them (AI-1). A claim is
          // "total" only if removing the spend/cost noun leaves nothing or a
          // total/overall qualifier.
          const core = claim.category.toLowerCase()
            .replace(/\b(spending|spend|costs?|expenses?)\b/g, "").trim();
          const isTotalClaim = core === "" || core === "total" || core === "overall" || core === "aggregate";
          if (!isTotalClaim) continue;
          if (claim.direction !== actualDirection && Math.abs(latest - prior) / Math.max(prior, 1) > 0.05) {
            findings.push({ severity: "warning", tier: 3, check: "trend_direction",
              claim: `${claim.category} is ${claim.direction}`,
              expected: `Actual total spending direction is ${actualDirection} ($${prior.toFixed(0)} → $${latest.toFixed(0)})`,
              context: claim.context });
          }
        }
      }
    }
  } catch (err) {
    console.error("Audit Tier 3 error:", err.message);
    incomplete = true;
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
    incomplete = true;
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

  // AI-5/AI-6: stamp the run as audited so getAuditAccuracy can tell a
  // genuinely-clean run (audited, zero findings) apart from one that was never
  // audited or whose tiers silently failed. audit_incomplete flags swallowed
  // tier errors so those runs are excluded from the accuracy denominator.
  if (insightId != null) {
    try {
      await pool.query(
        "UPDATE financial_insights SET audited_at = now(), audit_incomplete = $1 WHERE id = $2",
        [incomplete, insightId]
      );
    } catch (err) {
      console.error("Audit completion marker update error:", err.message);
    }
  }

  return { findings, summary, incomplete };
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
    // AI-6: "audited" means the run was actually audited to completion —
    // audited_at IS NOT NULL AND NOT audit_incomplete. A run with zero
    // ai_audit_log rows that was genuinely audited (audited_at set) counts as
    // clean; a run that was never audited or whose tiers silently failed is
    // EXCLUDED from the denominator (surfaced separately as incomplete_runs)
    // rather than silently inflating accuracy as a phantom "clean" run.
    const runs = await pool.query(`
      WITH recent_audits AS (
        SELECT al.insight_id, MAX(CASE WHEN al.severity = 'critical' THEN 1 ELSE 0 END) AS has_critical
        FROM ai_audit_log al
        WHERE al.created_at >= CURRENT_DATE - make_interval(days => $1)
        GROUP BY al.insight_id
      ),
      audited_runs AS (
        SELECT id FROM financial_insights
        WHERE entry_type = 'insight'
          AND created_at >= CURRENT_DATE - make_interval(days => $1)
          AND audited_at IS NOT NULL
          AND COALESCE(audit_incomplete, false) = false
      )
      SELECT
        (SELECT COUNT(*) FROM audited_runs) AS total_runs,
        COALESCE(SUM(CASE WHEN COALESCE(ra.has_critical, 0) = 0 THEN 1 ELSE 0 END), 0) AS clean_runs,
        (SELECT COUNT(*) FROM financial_insights
          WHERE entry_type = 'insight'
            AND created_at >= CURRENT_DATE - make_interval(days => $1)
            AND (audited_at IS NULL OR COALESCE(audit_incomplete, false) = true)
        ) AS incomplete_runs
      FROM audited_runs ar
      LEFT JOIN recent_audits ra ON ra.insight_id = ar.id
    `, [days]);
    const totals = runs.rows[0] || { total_runs: 0, clean_runs: 0, incomplete_runs: 0 };

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
    const incompleteRuns = parseInt(totals.incomplete_runs, 10) || 0;
    return {
      window_days: days,
      total_audited_runs: totalRuns,
      clean_runs: cleanRuns,
      incomplete_runs: incompleteRuns,
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
      incomplete_runs: 0,
      accuracy_pct: null,
      findings_by_severity: { critical: 0, warning: 0, info: 0 },
      findings_by_tier: { tier1: 0, tier2: 0, tier3: 0, tier4: 0 },
    };
  }
}

module.exports = { auditInsight, getAuditStats, getAuditAccuracy, extractDollarClaims, extractPercentClaims, extractMerchantNames, extractTrendClaims, findContradictions, wordMatch, entityKnown };
