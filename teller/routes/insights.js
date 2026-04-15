// ============================================================================
// Routes: AI Insights (Claude-powered financial analysis)
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { getMonthlySpending, getMonthlyIncomeAndSpending } = require("../services/financial-queries");
const {
  MODEL_COST_PER_M, modelFamily, estimateCostUsd, estimateCostGranular,
  STATE_ELECTRICITY_RATES, US_AVG_ELECTRICITY_RATE,
  zipToState, ANNUAL_SPENDING_BENCHMARKS,
  INSIGHT_MODULES, MODEL_MAP,
} = require("../data/reference-data");

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch {
  Anthropic = null;
}

// GET /api/insights/status
router.get("/api/insights/status", async (_req, res) => {
  const configured = !!(Anthropic && process.env.ANTHROPIC_API_KEY);
  let estimatedCostCents = 0;
  let budgetCents = parseInt(process.env.INSIGHTS_MONTHLY_BUDGET_CENTS) || 50;
  try {
    const usageRows = await pool.query(
      "SELECT tokens_used, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights WHERE created_at >= date_trunc('month', CURRENT_DATE)"
    );
    usageRows.rows.forEach(r => {
      const cost = r.input_tokens
        ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
        : estimateCostUsd(r.tokens_used || 0, r.model_used);
      estimatedCostCents += cost * 100;
    });
  } catch (err) { console.error("Insights status query error:", err.message); }
  res.json({
    configured,
    reason: configured ? null : (!Anthropic ? "SDK not installed" : "ANTHROPIC_API_KEY not set in .env"),
    estimated_cost_cents: Math.round(estimatedCostCents * 100) / 100,
    budget_cents: budgetCents,
    budget_remaining_cents: Math.round((budgetCents - estimatedCostCents) * 100) / 100,
    cost_rates: MODEL_COST_PER_M,
  });
});

// GET /api/insights/usage
router.get("/api/insights/usage", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, tokens_used, model_used, created_at FROM financial_insights ORDER BY created_at DESC LIMIT 20"
    );
    const history = result.rows.map(r => {
      // Use granular cost if we have separate token counts, otherwise fall back to blended
      const cost = r.input_tokens
        ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
        : estimateCostUsd(r.tokens_used || 0, r.model_used);
      return { ...r, estimated_cost_usd: parseFloat(cost.toFixed(4)) };
    });
    const allRows = await pool.query("SELECT tokens_used, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights");
    let totalTokens = 0, totalCost = 0;
    allRows.rows.forEach(r => {
      totalTokens += r.tokens_used || 0;
      totalCost += r.input_tokens
        ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
        : estimateCostUsd(r.tokens_used || 0, r.model_used);
    });
    res.json({
      history,
      totals: { total_runs: allRows.rows.length, total_tokens: totalTokens, total_cost_usd: parseFloat(totalCost.toFixed(4)) },
      cost_rates: MODEL_COST_PER_M,
    });
  } catch (err) { console.error("Insights usage query error:", err.message); res.json({ history: [], totals: { total_runs: 0, total_tokens: 0, total_cost_usd: 0 }, cost_rates: MODEL_COST_PER_M }); }
});

// GET /api/insights
router.get("/api/insights", async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM financial_insights ORDER BY created_at DESC LIMIT 5");
    res.json(result.rows);
  } catch (err) { console.error("Insights list query error:", err.message); res.json([]); }
});

// POST /api/insights — generate via Claude
router.post("/api/insights", async (_req, res) => {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: "Set ANTHROPIC_API_KEY in .env to enable AI insights." });
  }
  try {
    const budgetCents = parseInt(process.env.INSIGHTS_MONTHLY_BUDGET_CENTS) || 50;
    const usageResult = await pool.query(
      "SELECT tokens_used, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights " +
      "WHERE created_at >= date_trunc('month', CURRENT_DATE)"
    ).catch(() => ({ rows: [] }));
    let estimatedCostCents = 0;
    usageResult.rows.forEach(r => {
      const cost = r.input_tokens
        ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
        : estimateCostUsd(r.tokens_used || 0, r.model_used);
      estimatedCostCents += cost * 100;
    });
    if (estimatedCostCents >= budgetCents) {
      return res.status(429).json({
        error: `Monthly AI budget reached ($${(estimatedCostCents / 100).toFixed(2)} of $${(budgetCents / 100).toFixed(2)} cap). Resets next month. Adjust INSIGHTS_MONTHLY_BUDGET_CENTS in .env to raise the limit.`,
        budget_cents: budgetCents,
      });
    }

    // Use the shared split-adjusted spending query so the AI sees the same
    // monthly numbers as /api/spending-summary and the dashboard.
    const monthlySpendRows = await getMonthlySpending(pool, 6);
    const monthlyData = {
      rows: monthlySpendRows.map(r => ({
        month: r.month,
        total: r.total_spend,
        txns: r.txn_count,
      })),
    };
    const [subData, prevInsight, settingsRow] = await Promise.all([
      pool.query(
        "SELECT display_name, amount, cadence_days, category FROM detected_subscriptions " +
        "WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL ORDER BY amount DESC"
      ),
      pool.query(
        "SELECT insight_text, created_at FROM financial_insights ORDER BY created_at DESC LIMIT 1"
      ).catch(() => ({ rows: [] })),
      pool.query(
        "SELECT insights_running_summary, insights_model, insights_cadence_days, zip_code, insight_modules FROM user_settings WHERE id = 1"
      ).catch(() => ({ rows: [{ insights_running_summary: null, insights_model: "sonnet", insights_cadence_days: 30, zip_code: null, insight_modules: {} }] })),
    ]);
    const settings = settingsRow.rows[0] || {};
    const runningSummary = settings.insights_running_summary || null;
    const zipCode = settings.zip_code || null;
    let modules = settings.insight_modules || {};
    if (typeof modules === "string") modules = JSON.parse(modules);
    const modelPref = settings.insights_model || "sonnet";
    const modelId = MODEL_MAP[modelPref] || MODEL_MAP.sonnet;

    const subs = subData.rows.filter(r => r.category !== "utility");
    const utils = subData.rows.filter(r => r.category === "utility");
    const subTotal = subs.reduce((s, r) => s + parseFloat(r.amount) * 30 / r.cadence_days, 0);
    const utilTotal = utils.reduce((s, r) => s + parseFloat(r.amount) * 30 / r.cadence_days, 0);

    const activeModules = [];

    // ---- Build STATIC system prompt (cacheable across requests) ----
    let systemText = "You are a personal finance advisor providing ongoing monthly analysis. You have two tasks:\n\n" +
      "TASK 1: Analyze the data below and give 3-5 concise, actionable insights with specific dollar amounts. Use markdown bullet points. Reference long-term context where relevant.\n\n" +
      "TASK 2: After your insights, output a delimiter line containing exactly '---RUNNING_SUMMARY---' followed by an updated cumulative summary (max 200 words). This summary should capture:\n" +
      "- Baseline spending levels and trends (e.g. 'avg monthly spend ~$X, trending up/down')\n" +
      "- Key subscriptions and any changes noticed over time\n" +
      "- Progress on past recommendations (what improved, what didn't)\n" +
      "- Any recurring patterns or concerns worth tracking long-term\n" +
      "This summary persists across sessions as your long-term memory. Update it — don't just append.";

    // Add static module instructions to system prompt
    if (modules.spending_benchmarks !== false) {
      activeModules.push("spending_benchmarks");
      const benchText = Object.entries(ANNUAL_SPENDING_BENCHMARKS)
        .map(([, v]) => v.label + ": $" + Math.round(v.avg / 12) + "/mo ($" + v.avg.toLocaleString() + "/yr)")
        .join("\n");
      systemText += "\n\n=== NATIONAL SPENDING BENCHMARKS (avg US household, BLS 2024) ===\n" + benchText +
        "\nINSTRUCTION: Where the user's spending in a category is visible, briefly note how it compares to the national average. Only mention categories where there's a meaningful difference.";
    }
    if (modules.savings_suggestions !== false) {
      activeModules.push("savings_suggestions");
      systemText += "\n\n=== SAVINGS & WEALTH-BUILDING ===\n" +
        "INSTRUCTION: Based on the user's spending patterns, include 1-2 specific, actionable wealth-building suggestions. Examples: " +
        "if cancelling a specific subscription could fund an index fund contribution, quantify the 10-year compound growth; " +
        "if utility costs are high, estimate annual savings from a specific efficiency improvement; " +
        "if spending is trending up, identify the category driving it and suggest a concrete target. " +
        "Always give specific dollar amounts and time horizons. Avoid generic advice like 'save more'.";
    }
    if (modules.subscription_audit !== false) {
      activeModules.push("subscription_audit");
      systemText += "\n\n=== SUBSCRIPTION AUDIT ===\n" +
        "INSTRUCTION: Review the subscription list for potential savings: " +
        "flag services with overlapping functionality (e.g. multiple streaming or cloud storage), " +
        "note any subscriptions that seem unusually expensive for their category, " +
        "and suggest cheaper alternatives where well-known options exist. Be specific about potential monthly savings.";
    }
    if (modules.anomaly_detection !== false) {
      systemText += "\n\n=== ANOMALY DETECTION INSTRUCTIONS ===\n" +
        "When anomaly data is present: Flag anomalies. For each, suggest whether it's likely a one-time event, price increase, " +
        "or potentially unauthorized. Recommend specific action if warranted (e.g. dispute, check account, update budget).\n" +
        "When no anomalies are present: Note positively that spending patterns are consistent.";
    }
    if (modules.seasonal_forecast !== false) {
      systemText += "\n\n=== SEASONAL FORECASTING INSTRUCTIONS ===\n" +
        "When seasonal history is provided: Identify seasonal patterns (e.g. holiday spending spikes, summer utility increases, " +
        "back-to-school, annual renewals). Predict the likely spend for the next 1-2 months based on these patterns. " +
        "If certain months are consistently high, warn the user in advance and suggest preparing a buffer.";
    }
    if (modules.debt_optimizer !== false) {
      systemText += "\n\n=== DEBT PAYOFF OPTIMIZER INSTRUCTIONS ===\n" +
        "When credit card data is provided, give a personalized debt payoff analysis:\n" +
        "1. CREDIT SCORE IMPACT: Explain current utilization impact on credit score (FICO uses 30% weight for utilization). " +
        "Project how the score would improve at key thresholds: <50%, <30%, <10%, and 0% utilization. " +
        "Be specific: 'Paying down $X would drop utilization from Y% to Z%, which typically improves scores by N points.'\n" +
        "2. PAYOFF STRATEGY: If APRs are known, compare avalanche (highest APR first) vs snowball (smallest balance first) approaches. " +
        "Calculate interest saved with the optimal strategy over 6-12 months.\n" +
        "3. QUICK WINS: Identify any cards near a utilization threshold (e.g. just over 30%) where a small payment would have outsized credit score impact.\n" +
        "4. If APR is unknown for any card, note that the user should add it in their Accounts page for more accurate projections.";
    }
    if (modules.bill_negotiation !== false) {
      activeModules.push("bill_negotiation");
      systemText += "\n\n=== BILL NEGOTIATION INSTRUCTIONS ===\n" +
        "Review the utility bills and subscriptions for negotiation opportunities. " +
        "Common negotiable bills include: internet/cable (call retention department), insurance premiums (shop quotes), " +
        "cell phone plans (switch to MVNO), medical bills (ask for itemized + payment plan). " +
        "For each opportunity, estimate typical savings (e.g. 'Internet: calling retention typically saves $20-40/mo'). " +
        "Be specific about which bills to target and the typical script/approach.";
    }
    if (modules.income_savings !== false) {
      systemText += "\n\n=== INCOME & SAVINGS RATE INSTRUCTIONS ===\n" +
        "When income data is provided: Analyze the savings rate trend. The recommended savings rate is 20%+ (50/30/20 rule). " +
        "If below target, identify the top category driving overspending. " +
        "Project how the current savings rate translates to emergency fund timeline (3-6 months of expenses). " +
        "Suggest a specific, achievable savings rate improvement target.";
    }
    if (modules.tax_deductions !== false) {
      systemText += "\n\n=== TAX DEDUCTION INSTRUCTIONS ===\n" +
        "When tax-deductible transactions are provided: Review for potential deductions. " +
        "Categorize as: medical (Schedule A), charitable (Schedule A), education (1098-T/LLC), " +
        "business (Schedule C), or not deductible. Note standard deduction thresholds ($14,600 single / $29,200 married 2024). " +
        "Only flag deductions likely to exceed the standard deduction threshold. Remind user to consult a tax professional.";
    }
    if (modules.goal_tracking !== false) {
      systemText += "\n\n=== GOAL TRACKING INSTRUCTIONS ===\n" +
        "When financial goals are provided: Assess progress on each goal. For savings goals, calculate if the current contribution rate is on track. " +
        "For retirement goals, use the expected return to project growth. If a goal is behind schedule, suggest specific adjustments " +
        "(increase monthly contribution by $X, extend timeline by Y months, or reallocate from discretionary spending). " +
        "For home/car purchases, note down payment requirements (typically 20% for home, 10-20% for car) and monthly payment estimates.\n" +
        "IMPORTANT: Consider current real-world economic context when making projections. " +
        "Account for current market conditions, interest rate environment, inflation trends, and any major economic events " +
        "that could affect investment returns, home prices, or retirement planning. " +
        "For retirement goals, factor in realistic return expectations given current market conditions rather than historical averages.";
    }

    // ---- Build DYNAMIC user message (changes each request) ----
    let userMsg = "=== CURRENT DATA ===\n" +
      "Monthly Spending (6mo):\n" + monthlyData.rows.map(r => r.month + ": $" + parseFloat(r.total).toFixed(2) + " (" + r.txns + " txns)").join("\n") +
      "\n\nActive Subscriptions (" + subs.length + " total, $" + subTotal.toFixed(2) + "/mo):\n" +
      subs.map(r => r.display_name + ": $" + parseFloat(r.amount).toFixed(2) + " every " + r.cadence_days + " days").join("\n") +
      "\n\nUtility Bills (" + utils.length + " total, $" + utilTotal.toFixed(2) + "/mo):\n" +
      (utils.length > 0 ? utils.map(r => r.display_name + ": $" + parseFloat(r.amount).toFixed(2) + " every " + r.cadence_days + " days").join("\n") : "(none detected)");

    // --- Module: Utility rate comparison (dynamic data in user msg) ---
    if (modules.utility_comparison !== false && zipCode && utils.length > 0) {
      const state = zipToState(zipCode);
      if (state) {
        const stateRate = STATE_ELECTRICITY_RATES[state] || US_AVG_ELECTRICITY_RATE;
        activeModules.push("utility_comparison");
        userMsg += "\n\n=== UTILITY RATE COMPARISON ===\n" +
          "User ZIP: " + zipCode + " (State: " + state + ")\n" +
          "State avg residential electricity rate: " + stateRate.toFixed(1) + "¢/kWh\n" +
          "National avg: " + US_AVG_ELECTRICITY_RATE.toFixed(1) + "¢/kWh\n" +
          "Compare the user's utility bills to their state and national averages.";
      }
    }

    // --- Module: Anomaly detection (dynamic data) ---
    if (modules.anomaly_detection !== false) {
      try {
        const anomalyData = await pool.query(
          `SELECT t.merchant_name, t.name, t.amount, t.date,
                  avg_tbl.avg_amount, avg_tbl.txn_count
           FROM transactions t
           JOIN (
             SELECT COALESCE(merchant_name, name) AS merchant,
                    AVG(amount) AS avg_amount,
                    STDDEV(amount) AS std_amount,
                    COUNT(*) AS txn_count
             FROM transactions
             WHERE amount > 0 AND pending = false
               AND date >= CURRENT_DATE - INTERVAL '12 months'
             GROUP BY COALESCE(merchant_name, name)
             HAVING COUNT(*) >= 3
           ) avg_tbl ON COALESCE(t.merchant_name, t.name) = avg_tbl.merchant
           WHERE t.amount > 0 AND t.pending = false
             AND t.date >= CURRENT_DATE - INTERVAL '2 months'
             AND t.amount > avg_tbl.avg_amount * 2
           ORDER BY t.date DESC
           LIMIT 10`
        );
        activeModules.push("anomaly_detection");
        if (anomalyData.rows.length > 0) {
          userMsg += "\n\n=== ANOMALY DETECTION DATA ===\n" +
            "Recent transactions significantly above their merchant's typical amount:\n" +
            anomalyData.rows.map(r =>
              (r.merchant_name || r.name) + ": $" + parseFloat(r.amount).toFixed(2) +
              " on " + r.date + " (usual avg: $" + parseFloat(r.avg_amount).toFixed(2) +
              " over " + r.txn_count + " transactions)"
            ).join("\n");
        } else {
          userMsg += "\n\n=== ANOMALY DETECTION DATA ===\nNo unusual transactions detected in the last 2 months.";
        }
      } catch (err) { console.error("Anomaly detection query error:", err.message); }
    }

    // --- Module: Seasonal forecasting (dynamic data) ---
    if (modules.seasonal_forecast !== false) {
      try {
        const seasonalData = await pool.query(
          `SELECT EXTRACT(MONTH FROM date)::int AS month_num,
                  TO_CHAR(date, 'Mon') AS month_name,
                  EXTRACT(YEAR FROM date)::int AS year,
                  SUM(amount) AS total
           FROM transactions
           WHERE amount > 0 AND pending = false
             AND date >= CURRENT_DATE - INTERVAL '24 months'
           GROUP BY EXTRACT(MONTH FROM date), TO_CHAR(date, 'Mon'), EXTRACT(YEAR FROM date)
           ORDER BY year, month_num`
        );
        if (seasonalData.rows.length >= 6) {
          activeModules.push("seasonal_forecast");
          userMsg += "\n\n=== SEASONAL SPENDING HISTORY (24 months) ===\n" +
            seasonalData.rows.map(r => r.month_name + " " + r.year + ": $" + parseFloat(r.total).toFixed(2)).join("\n");
        }
      } catch (err) { console.error("Seasonal forecast query error:", err.message); }
    }

    // --- Module: Debt payoff optimizer (dynamic data) ---
    if (modules.debt_optimizer !== false) {
      try {
        const creditAccounts = await pool.query(
          `SELECT name, mask, current_balance, available_balance, apr
           FROM linked_accounts
           WHERE type = 'credit'
             AND (current_balance IS NOT NULL OR available_balance IS NOT NULL)
           ORDER BY current_balance DESC NULLS LAST`
        );
        const cards = creditAccounts.rows.filter(r => parseFloat(r.current_balance || 0) > 0);
        if (cards.length > 0) {
          activeModules.push("debt_optimizer");
          let cardLines = cards.map(c => {
            const owed = parseFloat(c.current_balance || 0);
            const avail = parseFloat(c.available_balance || 0);
            const limit = owed + avail;
            const util = limit > 0 ? Math.round((owed / limit) * 100) : 0;
            return c.name + (c.mask ? " (****" + c.mask + ")" : "") +
              ": Balance $" + owed.toFixed(2) +
              ", Limit $" + limit.toFixed(2) +
              ", Utilization " + util + "%" +
              (c.apr ? ", APR " + c.apr + "%" : ", APR unknown");
          }).join("\n");
          const totalDebt = cards.reduce((s, c) => s + parseFloat(c.current_balance || 0), 0);
          const totalLimit = cards.reduce((s, c) => s + parseFloat(c.current_balance || 0) + parseFloat(c.available_balance || 0), 0);
          const overallUtil = totalLimit > 0 ? Math.round((totalDebt / totalLimit) * 100) : 0;
          userMsg += "\n\n=== DEBT PAYOFF DATA ===\n" +
            "Credit Card Accounts:\n" + cardLines +
            "\nTotal credit card debt: $" + totalDebt.toFixed(2) +
            "\nTotal credit limit: $" + totalLimit.toFixed(2) +
            "\nOverall utilization: " + overallUtil + "%";
        }
      } catch (err) { console.error("Debt optimizer query error:", err.message); }
    }

    // --- Module: Income & savings rate (dynamic data) ---
    // Uses the shared income predicate (payroll/direct-dep/salary keywords,
    // excluding transfers/payments/refunds) so the AI sees the same numbers
    // as /api/savings-rate. Spending is split-adjusted for shared accounts.
    if (modules.income_savings !== false) {
      try {
        const incomeRows = await getMonthlyIncomeAndSpending(pool, 6);
        const hasIncome = incomeRows.some(r => r.income > 0);
        if (hasIncome) {
          activeModules.push("income_savings");
          userMsg += "\n\n=== INCOME & SAVINGS RATE DATA ===\n" +
            incomeRows.map(r => {
              const rate = r.income > 0 ? Math.round((1 - r.spending / r.income) * 100) : 0;
              return r.month + ": Income $" + r.income.toFixed(2) + ", Spending $" + r.spending.toFixed(2) + ", Savings rate " + rate + "%";
            }).join("\n");
        }
      } catch (err) { console.error("Income/savings query error:", err.message); }
    }

    // --- Module: Tax deduction flags (dynamic data) ---
    if (modules.tax_deductions !== false) {
      try {
        // Word-boundary matching prevents substring false positives like
        // "interest" → "internet", "office" → "Box Office", "vision" → "television".
        // Multi-word phrases still match because \y is a word-boundary anchor at the
        // edges of the phrase, not inside it.
        const taxKeywords = ["doctor", "medical", "pharmacy", "hospital", "dental", "vision", "health",
          "charity", "donation", "goodwill", "salvation army", "red cross",
          "tuition", "university", "college", "education", "student",
          "office", "supplies", "home office", "business",
          "mortgage", "interest", "property tax", "state tax"];
        const taxRegex = "\\y(" + taxKeywords.join("|") + ")\\y";
        const taxData = await pool.query(
          `SELECT COALESCE(merchant_name, name) AS merchant, SUM(amount) AS total, COUNT(*) AS txn_count
           FROM transactions
           WHERE pending = false AND amount > 0
             AND date >= date_trunc('year', CURRENT_DATE)
             AND COALESCE(merchant_name, name) ~* $1
           GROUP BY COALESCE(merchant_name, name)
           ORDER BY total DESC LIMIT 15`,
          [taxRegex]
        );
        if (taxData.rows.length > 0) {
          activeModules.push("tax_deductions");
          userMsg += "\n\n=== POTENTIAL TAX-DEDUCTIBLE TRANSACTIONS (YTD) ===\n" +
            taxData.rows.map(r => r.merchant + ": $" + parseFloat(r.total).toFixed(2) + " (" + r.txn_count + " transactions)").join("\n");

          // Persist flagged deductions to tax_deductions table for year-round accumulation
          for (const row of taxData.rows) {
            await pool.query(
              `INSERT INTO tax_deductions (tax_year, merchant, amount, category, deduction_type)
               VALUES (EXTRACT(YEAR FROM CURRENT_DATE), $1, $2, 'flagged', 'ai_detected')
               ON CONFLICT (merchant, tax_year) WHERE transaction_id IS NULL
               DO UPDATE SET amount = EXCLUDED.amount, flagged_at = now()`,
              [row.merchant, parseFloat(row.total)]
            ).catch(() => {});
          }
        }
      } catch (err) { console.error("Tax deductions query error:", err.message); }
    }

    // --- Module: Goal tracking (dynamic data) ---
    if (modules.goal_tracking !== false) {
      try {
        const goalsData = await pool.query("SELECT name, type, target_amount, current_amount, monthly_contribution, target_date, interest_rate FROM financial_goals WHERE is_active = true");
        if (goalsData.rows.length > 0) {
          activeModules.push("goal_tracking");
          userMsg += "\n\n=== FINANCIAL GOALS ===\n" +
            goalsData.rows.map(g => {
              const target = parseFloat(g.target_amount);
              const current = parseFloat(g.current_amount);
              const pct = target > 0 ? Math.round(current / target * 100) : 0;
              let line = g.name + " (" + g.type + "): $" + current.toFixed(2) + " / $" + target.toFixed(2) + " (" + pct + "%)";
              if (g.monthly_contribution > 0) line += ", contributing $" + parseFloat(g.monthly_contribution).toFixed(2) + "/mo";
              if (g.target_date) line += ", target date: " + g.target_date;
              if (g.interest_rate > 0) line += ", expected return: " + g.interest_rate + "%/yr";
              return line;
            }).join("\n");
        }
      } catch (err) { console.error("Goal tracking query error:", err.message); }
    }

    // --- Module: Recurring transfer analysis (dynamic data) ---
    try {
      const transferData = await pool.query(
        `SELECT display_name, amount, cadence_days, transfer_type, direction, last_transferred
         FROM recurring_transfers
         WHERE is_active = true AND is_dismissed = false
         ORDER BY amount DESC`
      );
      if (transferData.rows.length > 0) {
        activeModules.push("recurring_transfers");
        const outgoing = transferData.rows.filter(r => r.direction === "outgoing");
        const incoming = transferData.rows.filter(r => r.direction === "incoming");
        const outTotal = outgoing.reduce((s, r) => s + parseFloat(r.amount) * 30 / r.cadence_days, 0);
        const inTotal = incoming.reduce((s, r) => s + Math.abs(parseFloat(r.amount)) * 30 / r.cadence_days, 0);
        userMsg += "\n\n=== RECURRING TRANSFERS ===\n" +
          "Outgoing (" + outgoing.length + " transfers, $" + outTotal.toFixed(2) + "/mo):\n" +
          (outgoing.length > 0 ? outgoing.map(r => r.display_name + ": $" + parseFloat(r.amount).toFixed(2) + " every " + r.cadence_days + " days (" + r.transfer_type + ")").join("\n") : "(none)") +
          "\n\nIncoming (" + incoming.length + " transfers, $" + inTotal.toFixed(2) + "/mo):\n" +
          (incoming.length > 0 ? incoming.map(r => r.display_name + ": $" + Math.abs(parseFloat(r.amount)).toFixed(2) + " every " + r.cadence_days + " days (" + r.transfer_type + ")").join("\n") : "(none)");
      }
    } catch (err) { console.error("Recurring transfers query error:", err.message); }

    // --- Enrichment: Month-over-month spending trends with deltas ---
    try {
      if (monthlyData.rows.length >= 2) {
        const trends = [];
        for (let i = 1; i < monthlyData.rows.length; i++) {
          const curr = parseFloat(monthlyData.rows[i].total);
          const prev = parseFloat(monthlyData.rows[i - 1].total);
          const delta = curr - prev;
          const pctChange = prev > 0 ? Math.round((delta / prev) * 100) : 0;
          trends.push(monthlyData.rows[i].month + ": " + (delta >= 0 ? "+" : "") + "$" + delta.toFixed(2) + " (" + (pctChange >= 0 ? "+" : "") + pctChange + "%)");
        }
        userMsg += "\n\n=== SPENDING TREND DELTAS (month-over-month) ===\n" + trends.join("\n");
      }
    } catch (err) { console.error("Trend delta error:", err.message); }

    // --- Enrichment: Current budget status ---
    try {
      const budgetStatus = await pool.query(
        `SELECT b.category, b.monthly_limit,
                COALESCE(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 0) AS spent
         FROM budgets b
         LEFT JOIN transactions t ON COALESCE(t.category[1], 'Uncategorized') = b.category
           AND t.amount > 0 AND t.pending = false
           AND t.date >= date_trunc('month', CURRENT_DATE)
           AND t.date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
         LEFT JOIN linked_accounts la ON la.account_id = t.account_id
         GROUP BY b.category, b.monthly_limit
         ORDER BY b.monthly_limit DESC`
      );
      if (budgetStatus.rows.length > 0) {
        userMsg += "\n\n=== BUDGET STATUS (current month) ===\n" +
          budgetStatus.rows.map(b => {
            const spent = parseFloat(b.spent);
            const limit = parseFloat(b.monthly_limit);
            const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
            return b.category + ": $" + spent.toFixed(2) + " / $" + limit.toFixed(2) + " (" + pct + "% used)";
          }).join("\n");
      }
    } catch (err) { console.error("Budget status query error:", err.message); }

    // Include running summary and previous insight in user message (dynamic)
    if (runningSummary) {
      userMsg += "\n\n=== LONG-TERM CONTEXT (your cumulative memory from past analyses) ===\n" + runningSummary;
    }
    if (prevInsight.rows.length > 0) {
      const prev = prevInsight.rows[0];
      const date = new Date(prev.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" });
      userMsg += "\n\n=== MOST RECENT ANALYSIS [" + date + "] ===\n" + prev.insight_text.substring(0, 600) + (prev.insight_text.length > 600 ? "..." : "");
    }

    const client = new Anthropic();
    const maxTokens = Math.min(4096, 1500 + activeModules.length * 200);
    const message = await client.messages.create({
      model: modelId, max_tokens: maxTokens,
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMsg }],
    });
    const fullResponse = message.content[0].text;
    const usage = message.usage || {};
    const tokensUsed = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    const delimIdx = fullResponse.indexOf("---RUNNING_SUMMARY---");
    let insightText, newSummary;
    if (delimIdx !== -1) {
      insightText = fullResponse.substring(0, delimIdx).trim();
      newSummary = fullResponse.substring(delimIdx + "---RUNNING_SUMMARY---".length).trim();
    } else {
      insightText = fullResponse.trim();
      newSummary = runningSummary;
    }
    const actualModel = message.model || modelId;
    await pool.query(
      "INSERT INTO financial_insights (insight_text, period_start, period_end, model_used, tokens_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES ($1, CURRENT_DATE - INTERVAL '6 months', CURRENT_DATE, $2, $3, $4, $5, $6, $7)",
      [insightText, actualModel, tokensUsed, usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0]
    );
    if (newSummary) {
      await pool.query(
        "UPDATE user_settings SET insights_running_summary = $1, insights_last_run = now() WHERE id = 1",
        [newSummary]
      ).catch(() => {});
    } else {
      await pool.query("UPDATE user_settings SET insights_last_run = now() WHERE id = 1").catch(() => {});
    }
    const costUsd = estimateCostGranular(usage, actualModel);
    res.json({ insight: insightText, tokens_used: tokensUsed, modules_used: activeModules, cache_read_tokens: usage.cache_read_input_tokens || 0, estimated_cost_usd: parseFloat(costUsd.toFixed(6)) });
  } catch (err) {
    console.error("Insights error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/insights/reset
router.post("/api/insights/reset", async (_req, res) => {
  try {
    await pool.query("UPDATE user_settings SET insights_running_summary = NULL WHERE id = 1");
    res.json({ ok: true, message: "Long-term AI context cleared. Next analysis starts fresh." });
  } catch (err) {
    console.error("Insights reset error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/insights/rebuild
router.post("/api/insights/rebuild", async (_req, res) => {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: "Set ANTHROPIC_API_KEY in .env to enable AI insights." });
  }
  try {
    // Check monthly budget before calling Claude (using granular cost if available)
    const budgetCents = parseInt(process.env.INSIGHTS_MONTHLY_BUDGET_CENTS) || 50;
    const usageResult = await pool.query(
      "SELECT tokens_used, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights WHERE created_at >= date_trunc('month', CURRENT_DATE)"
    ).catch(() => ({ rows: [] }));
    let estimatedCostCents = 0;
    usageResult.rows.forEach(r => {
      const cost = r.input_tokens
        ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
        : estimateCostUsd(r.tokens_used || 0, r.model_used);
      estimatedCostCents += cost * 100;
    });
    if (estimatedCostCents >= budgetCents) {
      return res.status(429).json({
        error: `Monthly AI budget reached ($${(estimatedCostCents / 100).toFixed(2)} of $${(budgetCents / 100).toFixed(2)} cap). Resets next month.`,
        budget_cents: budgetCents,
      });
    }

    const [allInsights, settingsRow] = await Promise.all([
      pool.query("SELECT insight_text, created_at FROM financial_insights ORDER BY created_at ASC"),
      pool.query("SELECT insights_model FROM user_settings WHERE id = 1").catch(() => ({ rows: [{ insights_model: "sonnet" }] })),
    ]);
    if (allInsights.rows.length === 0) {
      return res.json({ ok: true, message: "No historical insights to rebuild from.", summary: null });
    }
    const modelId = MODEL_MAP[settingsRow.rows[0]?.insights_model] || MODEL_MAP.sonnet;
    let timeline = "";
    allInsights.rows.forEach((ins) => {
      const date = new Date(ins.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" });
      timeline += "[" + date + "]: " + ins.insight_text.substring(0, 400) + (ins.insight_text.length > 400 ? "..." : "") + "\n\n";
    });
    const client = new Anthropic();
    const message = await client.messages.create({
      model: modelId, max_tokens: 500,
      system: [{ type: "text", text:
        "You are a personal finance advisor. Synthesize a chronological timeline of past financial analyses into a single cumulative summary (max 200 words) that captures:\n" +
        "- Baseline spending levels and long-term trends\n" +
        "- Key subscriptions and how they've changed over time\n" +
        "- Progress on past recommendations (what improved, what didn't)\n" +
        "- Recurring patterns or concerns worth continuing to track\n\n" +
        "This summary will serve as persistent memory for future analyses.",
        cache_control: { type: "ephemeral" },
      }],
      messages: [{ role: "user", content: "=== ALL PAST ANALYSES ===\n" + timeline }],
    });
    const newSummary = message.content[0].text.trim();
    const usage = message.usage || {};
    const tokensUsed = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    await pool.query(
      "UPDATE user_settings SET insights_running_summary = $1 WHERE id = 1", [newSummary]
    );
    res.json({ ok: true, message: "Long-term context rebuilt from " + allInsights.rows.length + " historical analyses.", summary: newSummary, tokens_used: tokensUsed });
  } catch (err) {
    console.error("Rebuild error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/tax-deductions — retrieve accumulated tax deductions for a year
router.get("/api/tax-deductions", async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    const result = await pool.query(
      "SELECT * FROM tax_deductions WHERE tax_year = $1 ORDER BY amount DESC",
      [year]
    );
    const total = result.rows.reduce((s, r) => s + parseFloat(r.amount), 0);
    res.json({ year, deductions: result.rows, total: Math.round(total * 100) / 100 });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/tax-deductions/:id — confirm or update a flagged deduction
router.patch("/api/tax-deductions/:id", async (req, res) => {
  const { is_confirmed, category, notes } = req.body;
  try {
    const updates = []; const values = []; let idx = 1;
    if (is_confirmed !== undefined) { updates.push("is_confirmed = $" + idx++); values.push(!!is_confirmed); }
    if (category !== undefined) { updates.push("category = $" + idx++); values.push(category); }
    if (notes !== undefined) { updates.push("notes = $" + idx++); values.push(notes); }
    if (!updates.length) return res.status(400).json({ error: "No valid fields" });
    values.push(req.params.id);
    const result = await pool.query(
      "UPDATE tax_deductions SET " + updates.join(", ") + " WHERE id = $" + idx + " RETURNING *",
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
