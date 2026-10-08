// ============================================================================
// AI Audit — validates AI insight claims against actual data
// ============================================================================
// Runs after each AI analysis to check arithmetic, entity existence,
// trend direction, and internal consistency. Results stored in ai_audit_log.

const { pool } = require("../services/database");
const { getMonthlySpending, getMonthlyIncomeAndSpending, getCategorySpendingThisMonth, currentMonth } = require("./financial-queries");

// AIA1: Tier-1 arithmetic only has THIS-MONTH per-category + monthly-subscription
// actuals to compare against (getCategorySpendingThisMonth / actualSubMonthly).
// A dollar claim scoped to a DIFFERENT period — annualized, multi-month, YTD,
// projected, or a running average — legitimately differs from the single-month
// actual by large multiples, so comparing it here produced false-positive
// CRITICAL findings (audit-alert notification spam + a deflated audit_accuracy %,
// the headline trust metric). When a claim's surrounding context signals a
// non-current-month window we SKIP the dollar comparison rather than mis-flag it.
// Unqualified or explicitly "this month" claims (which refer to the this-month
// data the model was actually given) are still checked, so this-month
// hallucinations are still caught.
// F6: widened with UNAMBIGUOUS cross-period tokens the original regex missed —
// explicit other-month references (last/previous/prior month, "N months ago"),
// year-over-year, "trailing", and "estimate(d)". These are never this-month, so
// comparing them to getCategorySpendingThisMonth produced false CRITICALs.
// F7: "average"/"avg" is only a cross-period signal when PERIOD-qualified
// (running / rolling / monthly / N-month / per-month average, or the verb
// "averaging") — a bare BENCHMARK comparator ("above the national average",
// "below average") refers to a this-month figure and must NOT suppress the
// arithmetic check, so the bare token was replaced with the qualified forms
// (previously it matched anywhere in the ±context window and silently skipped
// genuine this-month hallucinations, inflating audit_accuracy as a false
// negative). Deliberately NOT added: bare/unqualified or "per month" claims —
// AIA1 intentionally checks those against this-month (pinned in tests).
const CROSS_PERIOD_RE = /\b(per year|\/?yr\b|\/year|annual|annually|a year|yearly|year[- ]?to[- ]?date|ytd|this year|last month|previous month|prior month|months? ago|year[- ]?over[- ]?year|yoy|trailing|estimated?|over the (?:past|last)|(?:last|past|over)\s+\d+\s+months?|\d+\s+months?|running[- ]?average|rolling[- ]?average|monthly average|average monthly|average per month|\d+[- ]?month average|avg[ ./]*mo|averaging|projected|projection|annualized|run[- ]?rate|on track)\b/;

// An explicit this-month qualifier OVERRIDES a cross-period match: the model
// was given this-month actuals, so a claim it tags "this month" is checkable
// regardless of any nearby period word (F7).
const THIS_MONTH_RE = /\b(this month|this period|so far this month|month[- ]to[- ]date|mtd|current month)\b/;

// Extract dollar amounts from text: "$1,234.56" or "$500"
function extractDollarClaims(text) {
  const matches = [];
  const regex = /\$([0-9,]+(?:\.\d{1,2})?)\b/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(value) && value > 0) {
      const ctx = text.substring(Math.max(0, m.index - 80), m.index + m[0].length + 40).trim();
      matches.push({ value, context: ctx, index: m.index, raw: m[0] });
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
    // AIN-2: a "- **Heading**:" bullet is only an entity claim when the line
    // goes straight on to a dollar amount ("- **Netflix**: $15.99/mo"). Plain
    // section headings ("- **Spending trend**: overall spending is up") were
    // captured as unknown merchants and turned nearly every insight's badge
    // into "N cautions".
    /^[\-\*]\s*\*?\*?([A-Z][A-Za-z0-9. &'-]+)\*?\*?\s*[:—\-]\s*\*?\*?\s*\$/gm,
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

// AIN-2: words that are never merchants — months/weekdays and the finance
// nouns the modules use as section labels ("Emergency fund", "Spending
// trend", "Debt"). A claimed name made ONLY of these (or starting with a
// month/weekday, e.g. "March was") is not an entity claim.
const MONTH_DAY_RE = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const GENERIC_WORDS = new Set([
  "a", "an", "the", "your", "you", "my", "our", "this", "that", "these", "those", "and", "or", "of", "for", "to", "in", "on", "at", "with", "by", "from", "is", "was", "are", "were", "be", "it", "its", "no", "not", "all", "any", "each", "every", "per", "vs",
  "spending", "spend", "spent", "income", "savings", "saving", "save", "emergency", "fund", "funds", "debt", "debts", "budget", "budgets", "budgeting", "goal", "goals", "trend", "trends", "overall", "total", "totals", "summary", "overview", "recommendation", "recommendations", "action", "actions", "item", "items", "alert", "alerts", "tip", "tips", "note", "notes", "insight", "insights", "analysis", "key", "takeaway", "takeaways", "next", "steps", "step", "priority", "priorities", "quick", "win", "wins", "bottom", "line",
  "rate", "ratio", "cash", "flow", "net", "worth", "credit", "card", "cards", "score", "utilization", "loan", "loans", "mortgage", "rent", "utilities", "utility", "subscription", "subscriptions", "bill", "bills", "payment", "payments", "transfer", "transfers", "investment", "investments", "retirement", "account", "accounts", "balance", "balances", "interest", "apr", "tax", "taxes", "deduction", "deductions", "insurance", "groceries", "grocery", "dining", "food", "drink", "travel", "transport", "transportation", "shopping", "entertainment", "health", "healthcare", "medical", "housing", "home", "personal", "general", "other", "misc", "miscellaneous", "fees", "fee", "category", "categories", "merchant", "merchants", "month", "months", "monthly", "week", "weekly", "year", "yearly", "annual", "seasonal", "pattern", "patterns", "forecast", "anomaly", "anomalies", "benchmark", "benchmarks", "average", "national", "rule", "debt-free", "fire", "runway", "progress", "milestone", "high", "low", "medium", "critical", "warning", "info",
]);
function isGenericName(name) {
  const n = String(name).trim();
  if (MONTH_DAY_RE.test(n)) return true;
  const words = n.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  return words.length > 0 && words.every(w => GENERIC_WORDS.has(w) || MONTH_DAY_RE.test(w));
}

// AIN-1: per-claim attribution. A dollar figure is compared with a
// category's this-month total only when it is the amount NEAREST that
// category — the first `$` after the name (short gap, same clause, no
// parenthetical: "Food and Drink spending hit $450", "Groceries: $612") or
// "$X on|for|in <category>". A figure inside a budget / benchmark / savings /
// cancel window, or followed by a comparator ("$120 over …"), is not a spend
// total and is skipped: per-item prices, national averages and budget limits
// produced false CRITICALs on correct insights.
const SKIP_WINDOW_RE = /\b(budget\w*|limit|target|goal|average|avg|benchmark\w*|national|typical|median|save[sd]?|saving|savings|cut|cutting|reduce[sd]?|reducing|trim|cancel\w*|switch\w*|downgrad\w*|instead|alternative|could|would)\b/;
const DELTA_AFTER_RE = /^\s*(?:\/mo\b|\/month\b|a month\b|per month\b)?\s*(?:over|under|above|below|more|less|higher|lower|extra|short)\b/;
const CLAUSE_END_RE = /[,;.!?()\n—]|\s-\s/;
const MAX_ATTRIB_GAP = 30;

// The claim's own clause: text after the previous dollar figure (and after
// the last sentence break) up to the claim, plus the trailing span up to the
// next clause break or dollar figure.
function claimSegments(text, claims, i) {
  const c = claims[i];
  const prevEnd = i > 0 ? claims[i - 1].index + claims[i - 1].raw.length : 0;
  let lead = text.slice(Math.max(prevEnd, c.index - 80), c.index);
  const breaks = [...lead.matchAll(/[.!?;]\s|\n/g)];
  if (breaks.length) {
    const last = breaks[breaks.length - 1];
    lead = lead.slice(last.index + last[0].length);
  }
  const end = c.index + c.raw.length;
  const nextStart = i + 1 < claims.length ? claims[i + 1].index : text.length;
  let trail = text.slice(end, Math.min(nextStart, end + 40));
  const cut = trail.search(CLAUSE_END_RE);
  if (cut >= 0) trail = trail.slice(0, cut);
  return { lead: lead.toLowerCase(), trail: trail.toLowerCase() };
}

// The category this claim is the nearest amount of, or null.
function attributeCategory(lead, trail, categories) {
  let best = null, bestDist = Infinity;
  for (const cat of categories) {
    // Before: the LAST occurrence of the name in the lead clause, a short gap
    // not ending inside an open parenthetical ("Shopping (Amazon $45" /
    // "cancel Hulu ($17.99)" are item prices; "Food (this month): $900" is not).
    const re = new RegExp("\\b" + reEscape(cat) + "\\b", "gi");
    let m, lastEnd = -1;
    while ((m = re.exec(lead)) !== null) lastEnd = m.index + m[0].length;
    if (lastEnd >= 0) {
      const gap = lead.slice(lastEnd);
      const openParens = (gap.match(/\(/g) || []).length - (gap.match(/\)/g) || []).length;
      if (gap.length <= MAX_ATTRIB_GAP && openParens <= 0) {
        if (gap.length < bestDist || (gap.length === bestDist && best && cat.length > best.length)) {
          best = cat; bestDist = gap.length;
        }
      }
    }
    // After: "$X on|for|in [the|your] <category>".
    const after = new RegExp("^\\s*(?:\\/mo\\b|\\/month\\b|a month\\b|per month\\b)?\\s*(?:on|for|in)\\s+(?:the\\s+|your\\s+)?" + reEscape(cat) + "\\b", "i");
    const am = trail.match(after);
    if (am && am[0].length < bestDist) { best = cat; bestDist = am[0].length; }
  }
  return best;
}

// AIN-1: a subscription figure is the TOTAL only when phrased as one.
const SUB_TOTAL_RE = /\b(total\w*|all|combined|altogether|overall)\b|\b\d+\s+(?:active\s+|recurring\s+)?subscriptions\b/;

// AIN-3: savings rate over a set of {income, spending} months (sum-based).
function savingsRateOf(rows) {
  const inc = rows.reduce((a, r) => a + (r.income || 0), 0);
  const sp = rows.reduce((a, r) => a + (r.spending || 0), 0);
  return inc > 0 ? Math.round((1 - sp / inc) * 100) : null;
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
    // AIN-3: the savings-rate baseline is COMPLETE months only — the current
    // month to date (a payday on the 3rd reads ~90%) is not what "your savings
    // rate" means. A claim may legitimately be the last complete month or the
    // multi-month average, so both are accepted (closest wins); only an
    // explicit "this month" claim is checked against the partial month.
    const thisMonth = currentMonth();
    const completeIS = incomeSpending.filter(r => r.month < thisMonth);
    const currentIS = incomeSpending.filter(r => r.month === thisMonth);
    const lastCompleteRate = completeIS.length ? savingsRateOf(completeIS.slice(-1)) : null;
    const avgCompleteRate = completeIS.length ? savingsRateOf(completeIS) : null;
    const currentRate = currentIS.length ? savingsRateOf(currentIS) : null;

    // Check subscription totals
    const subsResult = await pool.query(
      "SELECT COUNT(*) AS cnt, SUM(amount * 30.0 / cadence_days) AS monthly FROM detected_subscriptions WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL"
    ).catch(() => ({ rows: [{ cnt: 0, monthly: 0 }] }));
    const actualSubCount = parseInt(subsResult.rows[0].cnt);
    const actualSubMonthly = parseFloat(subsResult.rows[0].monthly || 0);

    // Check dollar claims against actuals
    const dollarClaims = extractDollarClaims(insightText);
    const categoryNames = Object.keys(actualCategories);
    for (let i = 0; i < dollarClaims.length; i++) {
      const claim = dollarClaims[i];
      const ctx = claim.context.toLowerCase();
      // Skip claims scoped to a non-current-month period (annual/multi-month/YTD/
      // projected/average) — the per-category + subscription actuals below are
      // this-month figures, so comparing a cross-period dollar amount would
      // false-flag (AIA1).
      const crossPeriod = CROSS_PERIOD_RE.test(ctx) && !THIS_MONTH_RE.test(ctx);
      if (crossPeriod) continue;
      // AIN-1: judge the claim on its OWN clause, not an ±80-char window that
      // spans neighbouring figures. Budget/benchmark/savings/cancel windows and
      // comparator deltas ("$120 over your budget") are not spend totals.
      const { lead, trail } = claimSegments(insightText, dollarClaims, i);
      if (SKIP_WINDOW_RE.test(lead) || SKIP_WINDOW_RE.test(trail) || DELTA_AFTER_RE.test(trail)) continue;
      // Attribute the claim to the single category it is the NEAREST amount
      // of (word-boundary names, AI-2; one finding per claim, AI-3).
      const bestCat = attributeCategory(lead, trail, categoryNames);
      const bestActual = bestCat !== null ? actualCategories[bestCat] : null;
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
      // Check subscription TOTAL claims — only when the clause names
      // subscriptions AND phrases the figure as a total ("all", "total",
      // "your 7 subscriptions"); a single subscription's price is not the
      // total (AIN-1). Same this-month cross-period skip as above.
      const clause = lead + " " + trail;
      if (bestCat === null && /subscription/.test(clause) && SUB_TOTAL_RE.test(clause)
          && Math.abs(claim.value - actualSubMonthly) > 1) {
        const pctOff = actualSubMonthly > 0 ? Math.abs(claim.value - actualSubMonthly) / actualSubMonthly : 1;
        // Same critical/warning split as the per-category check above — a
        // subscription-total claim off 5-20% now emits a warning instead of
        // silently passing (F8).
        if (pctOff > 0.20) {
          findings.push({ severity: "critical", tier: 1, check: "subscription_total",
            claim: `$${claim.value.toFixed(2)}`, expected: `$${actualSubMonthly.toFixed(2)}`,
            pct_off: Math.round(pctOff * 100), context: claim.context });
        } else if (pctOff > 0.05) {
          findings.push({ severity: "warning", tier: 1, check: "subscription_total",
            claim: `$${claim.value.toFixed(2)}`, expected: `$${actualSubMonthly.toFixed(2)}`,
            pct_off: Math.round(pctOff * 100), context: claim.context });
        }
      }
    }

    // Check percentage claims (savings rate). Match common phrasings, not just
    // the literal "savings rate", so "save rate"/"savings ratio"/"saving rate"
    // claims are validated too (F10). Other percent types (utilization, budget
    // used, trend %) are deliberately NOT checked here — they have no single
    // reliable actual in scope and fuzzy per-entity matching would regress
    // audit precision (the AI-2/AI-4 false-positive class); deferred.
    const SAVINGS_RATE_RE = /\bsav(?:ings?|e|ing)\s+(?:rate|ratio)\b/;
    const pctClaims = extractPercentClaims(insightText);
    for (const claim of pctClaims) {
      const pctx = claim.context.toLowerCase();
      if (!SAVINGS_RATE_RE.test(pctx)) continue;
      // AIN-3: an explicit "this month" claim is checked against the partial
      // month; anything else against the last complete month OR the complete-
      // month average (a "6-month average" claim, CROSS_PERIOD_RE, is the
      // latter) — whichever is closer.
      const candidates = THIS_MONTH_RE.test(pctx)
        ? [currentRate]
        : [lastCompleteRate, avgCompleteRate];
      const usable = candidates.filter(v => v !== null);
      if (usable.length === 0) continue;
      let expected = usable[0];
      for (const v of usable) if (Math.abs(claim.value - v) < Math.abs(claim.value - expected)) expected = v;
      const diff = Math.abs(claim.value - expected);
      if (diff > 10) {
        findings.push({ severity: "critical", tier: 1, check: "savings_rate",
          claim: `${claim.value}%`, expected: `${expected}%`,
          pct_off: diff, context: claim.context });
      } else if (diff > 3) {
        findings.push({ severity: "warning", tier: 1, check: "savings_rate",
          claim: `${claim.value}%`, expected: `${expected}%`,
          pct_off: diff, context: claim.context });
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
      // AIN-2: category names are entities the model is given ("Shopping",
      // "Food and Drink") — not hallucinated merchants.
      const cats = await pool.query(
        "SELECT DISTINCT LOWER(COALESCE(user_category, category[1])) AS c FROM transactions WHERE COALESCE(user_category, category[1]) IS NOT NULL LIMIT 1000"
      );
      for (const c of cats.rows) if (c.c) known.add(c.c);

      for (const name of merchantNames) {
        // AIN-2: months, weekdays and generic finance nouns are not entities.
        if (isGenericName(name)) continue;
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
      // AIN-3: compare COMPLETE months only — the partial current month always
      // reads "down" early in the month, turning a correct "overall spending is
      // up" (about the last full month) into a warning.
      const thisMonth = currentMonth();
      const monthlyData = (await getMonthlySpending(pool, 3)).filter(r => r.month < thisMonth);
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

module.exports = { auditInsight, getAuditStats, getAuditAccuracy, extractDollarClaims, extractPercentClaims, extractMerchantNames, extractTrendClaims, findContradictions, wordMatch, entityKnown, isGenericName, claimSegments, attributeCategory, CROSS_PERIOD_RE };
