// ============================================================================
// Routes: AI Insights (Claude-powered financial analysis)
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { getMonthlySpending, getMonthlyIncomeAndSpending, NOT_TRANSFER } = require("../services/financial-queries");
const { auditInsight, getAuditStats, getAuditAccuracy } = require("../services/ai-audit");
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

// Tool definition for structured insight generation. The model is forced to
// emit BOTH an insights_text string and a typed `summary` object. The latter
// becomes long-term memory — JSON instead of the legacy plain-text running
// summary, so callers can show counts, render lists, and audit drift.
const INSIGHT_TOOL = {
  name: "generate_financial_insight",
  description: "Generate user-facing insight text and an updated structured running summary for long-term memory.",
  input_schema: {
    type: "object",
    properties: {
      insights_text: {
        type: "string",
        description: "3-5 markdown bullet-point insights with specific dollar amounts.",
      },
      summary: {
        type: "object",
        description: "Updated structured cumulative summary. Carry forward existing items and update / add / remove based on current data.",
        properties: {
          trends: {
            type: "array",
            description: "Long-term direction observations (max 8).",
            items: {
              type: "object",
              properties: {
                category: { type: "string" },
                direction: { type: "string", enum: ["up", "down", "stable"] },
                magnitude: { type: "string" },
                since_when: { type: "string" },
              },
              required: ["category", "direction"],
            },
          },
          completed_goals: {
            type: "array",
            description: "Goals the user has completed (max 10).",
            items: {
              type: "object",
              properties: {
                goal_name: { type: "string" },
                completed_date: { type: "string" },
              },
              required: ["goal_name"],
            },
          },
          pending_actions: {
            type: "array",
            description: "Concrete actions previously recommended that are NOT yet completed (max 10).",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                urgency: { type: "string", enum: ["high", "medium", "low"] },
                first_recommended: { type: "string" },
              },
              required: ["description"],
            },
          },
          alerts: {
            type: "array",
            description: "Active concerns the user should be aware of (max 5).",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                message: { type: "string" },
                severity: { type: "string", enum: ["critical", "warning", "info"] },
              },
              required: ["message"],
            },
          },
        },
        required: ["trends", "completed_goals", "pending_actions", "alerts"],
      },
    },
    required: ["insights_text", "summary"],
  },
};

// Coerce + cap arrays + drop unknown keys so a pathological tool response
// can't leak unbounded data into long-term memory or break renderers. Returns
// null when the shape is unrecoverable, so the caller can preserve the prior
// summary instead of overwriting with garbage.
function sanitizeStructuredSummary(s) {
  if (!s || typeof s !== "object") return null;
  function arr(v, max) { return Array.isArray(v) ? v.slice(0, max) : []; }
  function str(v, max) { return typeof v === "string" ? v.slice(0, max || 200) : ""; }
  const safeEnum = (v, allowed) => allowed.includes(v) ? v : null;
  return {
    trends: arr(s.trends, 8).map(t => ({
      category: str(t && t.category, 80),
      direction: safeEnum(t && t.direction, ["up", "down", "stable"]) || "stable",
      magnitude: str(t && t.magnitude, 80),
      since_when: str(t && t.since_when, 40),
    })).filter(t => t.category),
    completed_goals: arr(s.completed_goals, 10).map(g => ({
      goal_name: str(g && g.goal_name, 120),
      completed_date: str(g && g.completed_date, 40),
    })).filter(g => g.goal_name),
    pending_actions: arr(s.pending_actions, 10).map(a => ({
      description: str(a && a.description, 240),
      urgency: safeEnum(a && a.urgency, ["high", "medium", "low"]) || "medium",
      first_recommended: str(a && a.first_recommended, 40),
    })).filter(a => a.description),
    alerts: arr(s.alerts, 5).map(a => ({
      type: str(a && a.type, 60),
      message: str(a && a.message, 240),
      severity: safeEnum(a && a.severity, ["critical", "warning", "info"]) || "info",
    })).filter(a => a.message),
  };
}

// Render the structured summary back to readable bullets for the AI prompt
// AND for the backward-compat plain-text column. The same function serves
// both — model and human read the same shape.
function renderStructuredSummaryForPrompt(s) {
  if (!s) return null;
  const sections = [];
  if (s.trends && s.trends.length) {
    sections.push("Trends being tracked:\n" + s.trends.map(t =>
      "- " + t.category + ": " + (t.direction || "stable") +
      (t.magnitude ? " (" + t.magnitude + ")" : "") +
      (t.since_when ? " since " + t.since_when : "")
    ).join("\n"));
  }
  if (s.completed_goals && s.completed_goals.length) {
    sections.push("Completed goals:\n" + s.completed_goals.map(g =>
      "- " + g.goal_name + (g.completed_date ? " (" + g.completed_date + ")" : "")
    ).join("\n"));
  }
  if (s.pending_actions && s.pending_actions.length) {
    sections.push("Pending actions:\n" + s.pending_actions.map(a =>
      "- " + a.description + (a.urgency ? " [" + a.urgency + "]" : "")
    ).join("\n"));
  }
  if (s.alerts && s.alerts.length) {
    sections.push("Active alerts:\n" + s.alerts.map(a =>
      "- " + a.message + (a.severity ? " [" + a.severity + "]" : "")
    ).join("\n"));
  }
  return sections.length ? sections.join("\n\n") : null;
}

// Render insight text as styled HTML email matching app aesthetic
function renderInsightEmail(text, modules, auditResult) {
  let body = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, '<h3 style="color:#d4a574;font-size:16px;margin:18px 0 8px;font-weight:600;">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="color:#d4a574;font-size:18px;margin:20px 0 10px;font-weight:600;">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#ffffff;">$1</strong>')
    .replace(/^[\-\*] (.+)$/gm, '<li style="margin:4px 0;color:#cccccc;">$1</li>')
    .replace(/\n/g, "<br>");

  let auditSection = "";
  if (auditResult && (auditResult.summary.critical > 0 || auditResult.summary.warning > 0)) {
    auditSection = `
      <div style="margin-top:24px;padding:16px;background:#2a1a1a;border:1px solid #663333;border-radius:8px;">
        <h3 style="color:#eb6b6b;margin:0 0 8px;font-size:14px;">Audit Findings</h3>
        <p style="color:#cccccc;font-size:12px;margin:0;">${auditResult.summary.critical} critical, ${auditResult.summary.warning} warning issue(s) detected. Review in Settings &rarr; AI Insights.</p>
      </div>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#080b12;font-family:Inter,system-ui,sans-serif;">
    <div style="max-width:640px;margin:0 auto;padding:32px 24px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;width:40px;height:40px;background:#d4a574;mask:url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><circle cx=%2220%22 cy=%2220%22 r=%2217%22 stroke=%22white%22 stroke-width=%222%22 fill=%22none%22/><circle cx=%2220%22 cy=%2220%22 r=%228%22 stroke=%22white%22 stroke-width=%221.5%22 fill=%22none%22/><circle cx=%2220%22 cy=%2220%22 r=%223%22 fill=%22white%22/></svg>') center/contain no-repeat;-webkit-mask:url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><circle cx=%2220%22 cy=%2220%22 r=%2217%22 stroke=%22white%22 stroke-width=%222%22 fill=%22none%22/><circle cx=%2220%22 cy=%2220%22 r=%228%22 stroke=%22white%22 stroke-width=%221.5%22 fill=%22none%22/><circle cx=%2220%22 cy=%2220%22 r=%223%22 fill=%22white%22/></svg>') center/contain no-repeat;"></div>
        <h1 style="color:#d4a574;font-size:22px;margin:12px 0 4px;font-weight:300;">Perfin Financial Analysis</h1>
        <p style="color:#888888;font-size:12px;margin:0;">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
      </div>
      <div style="background:#0f1320;border:1px solid #1a1f35;border-radius:12px;padding:24px;color:#cccccc;font-size:13px;line-height:1.7;">
        ${body}
      </div>
      ${auditSection}
      <div style="text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #1a1f35;">
        <p style="color:#666666;font-size:11px;margin:0;">Modules: ${modules.join(", ")}</p>
        <p style="color:#555555;font-size:10px;margin:8px 0 0;">Generated by Perfin &middot; <a href="#" style="color:#5a8f8f;">Open Dashboard</a></p>
      </div>
    </div>
  </body></html>`;
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
  // Audit accuracy + structured running summary: both surfaced so the
  // Settings/dashboard UI can show "AI accuracy 87%" plus "tracking 3 trends,
  // 2 completed goals, 5 pending actions, 1 alert" without a second fetch.
  const accuracy = await getAuditAccuracy(90);
  let runningSummaryJson = null;
  let summaryCounts = { trends: 0, completed_goals: 0, pending_actions: 0, alerts: 0 };
  try {
    const sumRow = await pool.query(
      "SELECT insights_running_summary_json FROM user_settings WHERE id = 1"
    );
    let raw = sumRow.rows[0] && sumRow.rows[0].insights_running_summary_json;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = null; } }
    if (raw && typeof raw === "object") {
      runningSummaryJson = raw;
      summaryCounts = {
        trends: Array.isArray(raw.trends) ? raw.trends.length : 0,
        completed_goals: Array.isArray(raw.completed_goals) ? raw.completed_goals.length : 0,
        pending_actions: Array.isArray(raw.pending_actions) ? raw.pending_actions.length : 0,
        alerts: Array.isArray(raw.alerts) ? raw.alerts.length : 0,
      };
    }
  } catch (err) { console.error("running summary read error:", err.message); }
  res.json({
    configured,
    reason: configured ? null : (!Anthropic ? "SDK not installed" : "ANTHROPIC_API_KEY not set in .env"),
    estimated_cost_cents: Math.round(estimatedCostCents * 100) / 100,
    budget_cents: budgetCents,
    budget_remaining_cents: Math.round((budgetCents - estimatedCostCents) * 100) / 100,
    cost_rates: MODEL_COST_PER_M,
    audit_accuracy: accuracy,
    running_summary: runningSummaryJson,
    running_summary_counts: summaryCounts,
  });
});

// GET /api/insights/usage
router.get("/api/insights/usage", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, tokens_used, model_used, created_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights ORDER BY created_at DESC LIMIT 20"
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
    // entry_type filter excludes /api/categorize tracking rows from the user-facing feed.
    const result = await pool.query("SELECT * FROM financial_insights WHERE entry_type = 'insight' ORDER BY created_at DESC LIMIT 5");
    res.json(result.rows);
  } catch (err) { console.error("Insights list query error:", err.message); res.json([]); }
});

// generateInsights — orchestration extracted from POST /api/insights so the
// scheduler in startup.js can invoke it in-process (an HTTP self-fetch from
// the auto-trigger 401s under the unified shell). Returns either:
//   { ok: false, status, error }                 — early bail / failure
//   { ok: true, insight, modules_used, ... }     — same body the HTTP handler
//                                                  used to JSON-encode
async function generateInsights() {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return { ok: false, status: 501, error: "Set ANTHROPIC_API_KEY in .env to enable AI insights." };
  }
  try {
    const budgetCents = parseInt(process.env.INSIGHTS_MONTHLY_BUDGET_CENTS) || 50;
    const usageResult = await pool.query(
      "SELECT tokens_used, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM financial_insights " +
      "WHERE created_at >= date_trunc('month', CURRENT_DATE)"
    );
    let estimatedCostCents = 0;
    usageResult.rows.forEach(r => {
      const cost = r.input_tokens
        ? estimateCostGranular({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_input_tokens: r.cache_read_tokens || 0, cache_creation_input_tokens: r.cache_creation_tokens || 0 }, r.model_used)
        : estimateCostUsd(r.tokens_used || 0, r.model_used);
      estimatedCostCents += cost * 100;
    });
    if (estimatedCostCents >= budgetCents) {
      return {
        ok: false,
        status: 429,
        error: `Monthly AI budget reached ($${(estimatedCostCents / 100).toFixed(2)} of $${(budgetCents / 100).toFixed(2)} cap). Resets next month. Adjust INSIGHTS_MONTHLY_BUDGET_CENTS in .env to raise the limit.`,
        budget_cents: budgetCents,
      };
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
        "SELECT insight_text, created_at FROM financial_insights WHERE entry_type = 'insight' ORDER BY created_at DESC LIMIT 1"
      ).catch(() => ({ rows: [] })),
      pool.query(
        "SELECT insights_running_summary, insights_running_summary_json, insights_model, insights_cadence_days, zip_code, insight_modules FROM user_settings WHERE id = 1"
      ).catch(() => ({ rows: [{ insights_running_summary: null, insights_running_summary_json: null, insights_model: "sonnet", insights_cadence_days: 30, zip_code: null, insight_modules: {} }] })),
    ]);
    const settings = settingsRow.rows[0] || {};
    const runningSummary = settings.insights_running_summary || null;
    let runningSummaryJson = settings.insights_running_summary_json || null;
    if (typeof runningSummaryJson === "string") {
      try { runningSummaryJson = JSON.parse(runningSummaryJson); } catch { runningSummaryJson = null; }
    }
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
    let systemText = "You are a personal finance advisor providing ongoing monthly analysis.\n" +
      "Use the `generate_financial_insight` tool to return BOTH:\n" +
      "  (a) `insights_text` — 3-5 concise, actionable markdown bullet-point insights with specific dollar amounts. Reference long-term context where relevant.\n" +
      "  (b) `summary` — an UPDATED structured running summary (long-term memory) with four arrays:\n" +
      "      - trends: long-term direction observations (max 8). Each: { category, direction (up/down/stable), magnitude, since_when }. Carry forward + update + drop as needed.\n" +
      "      - completed_goals: goals the user has completed (max 10). Each: { goal_name, completed_date }.\n" +
      "      - pending_actions: concrete actions previously recommended that are NOT YET completed (max 10). Drop items the user has acted on. Each: { description, urgency (high/medium/low), first_recommended }.\n" +
      "      - alerts: active concerns the user should be aware of (max 5). Each: { type, message, severity (critical/warning/info) }. Remove items when the underlying issue resolves.\n" +
      "The summary persists across sessions as your long-term memory — UPDATE the existing entries (don't just append) based on the current data.";

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
      activeModules.push("anomaly_detection");
      systemText += "\n\n=== ANOMALY DETECTION INSTRUCTIONS ===\n" +
        "When anomaly data is present: Flag anomalies. For each, suggest whether it's likely a one-time event, price increase, " +
        "or potentially unauthorized. Recommend specific action if warranted (e.g. dispute, check account, update budget).\n" +
        "When no anomalies are present: Note positively that spending patterns are consistent.";
    }
    if (modules.seasonal_forecast !== false) {
      activeModules.push("seasonal_forecast");
      systemText += "\n\n=== SEASONAL FORECASTING INSTRUCTIONS ===\n" +
        "When seasonal history is provided: Identify seasonal patterns (e.g. holiday spending spikes, summer utility increases, " +
        "back-to-school, annual renewals). Predict the likely spend for the next 1-2 months based on these patterns. " +
        "If certain months are consistently high, warn the user in advance and suggest preparing a buffer.";
    }
    if (modules.debt_optimizer !== false) {
      activeModules.push("debt_optimizer");
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
      activeModules.push("income_savings");
      systemText += "\n\n=== INCOME & SAVINGS RATE INSTRUCTIONS ===\n" +
        "When income data is provided: Analyze the savings rate trend. The recommended savings rate is 20%+ (50/30/20 rule). " +
        "If below target, identify the top category driving overspending. " +
        "Project how the current savings rate translates to emergency fund timeline (3-6 months of expenses). " +
        "Suggest a specific, achievable savings rate improvement target.";
    }
    if (modules.tax_deductions !== false) {
      activeModules.push("tax_deductions");
      systemText += "\n\n=== TAX DEDUCTION INSTRUCTIONS ===\n" +
        "When tax-deductible transactions are provided: Review for potential deductions. " +
        "Categorize as: medical (Schedule A), charitable (Schedule A), education (1098-T/LLC), " +
        "business (Schedule C), or not deductible. Note standard deduction thresholds ($14,600 single / $29,200 married 2024). " +
        "Only flag deductions likely to exceed the standard deduction threshold. Remind user to consult a tax professional.";
    }
    if (modules.goal_tracking !== false) {
      activeModules.push("goal_tracking");
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

    // ---- Sanitize user-controlled strings to prevent prompt injection ----
    // The running-summary delimiter (---RUNNING_SUMMARY---) is parsed from the
    // model's response. If a merchant name, goal name, or transfer name contains
    // this pattern, it could corrupt summary parsing. Strip it.
    function sanitizeForPrompt(s) {
      if (!s) return "";
      return String(s).replace(/---+RUNNING_SUMMARY---+/gi, "[redacted]").replace(/---+/g, "--");
    }

    // ---- Build DYNAMIC user message (changes each request) ----
    let userMsg = "=== CURRENT DATA ===\n" +
      "Monthly Spending (6mo):\n" + monthlyData.rows.map(r => r.month + ": $" + parseFloat(r.total).toFixed(2) + " (" + r.txns + " txns)").join("\n") +
      "\n\nActive Subscriptions (" + subs.length + " total, $" + subTotal.toFixed(2) + "/mo):\n" +
      subs.map(r => sanitizeForPrompt(r.display_name) + ": $" + parseFloat(r.amount).toFixed(2) + " every " + r.cadence_days + " days").join("\n") +
      "\n\nUtility Bills (" + utils.length + " total, $" + utilTotal.toFixed(2) + "/mo):\n" +
      (utils.length > 0 ? utils.map(r => sanitizeForPrompt(r.display_name) + ": $" + parseFloat(r.amount).toFixed(2) + " every " + r.cadence_days + " days").join("\n") : "(none detected)");

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
        // Numbers shown to the AI now match the dashboard:
        //   - Group by COALESCE(user_merchant_name, merchant_name, name) so user-
        //     merged merchants don't fragment baselines.
        //   - Apply spending_split_pct on both baseline AVG and candidate amount
        //     so shared/joint accounts contribute the user's share, not the full
        //     transaction amount.
        //   - Exclude reimbursed rows from CANDIDATES (baselines still include
        //     reimbursed per CLAUDE.md — a reimbursed charge is still typical).
        const anomalyData = await pool.query(
          `SELECT t.merchant_name, t.name, t.user_merchant_name,
                  ROUND(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0, 2) AS amount,
                  t.date,
                  avg_tbl.avg_amount, avg_tbl.txn_count
           FROM transactions t
           LEFT JOIN linked_accounts la ON la.account_id = t.account_id
           JOIN (
             SELECT LOWER(COALESCE(t2.user_merchant_name, t2.merchant_name, t2.name)) AS merchant,
                    AVG(t2.amount * COALESCE(la2.spending_split_pct, 100) / 100.0) AS avg_amount,
                    STDDEV(t2.amount * COALESCE(la2.spending_split_pct, 100) / 100.0) AS std_amount,
                    COUNT(*) AS txn_count
             FROM transactions t2
             LEFT JOIN linked_accounts la2 ON la2.account_id = t2.account_id
             WHERE t2.amount > 0 AND t2.pending = false
               AND t2.date >= CURRENT_DATE - INTERVAL '12 months'
               AND t2.date <  CURRENT_DATE - INTERVAL '7 days'
             GROUP BY LOWER(COALESCE(t2.user_merchant_name, t2.merchant_name, t2.name))
             HAVING COUNT(*) >= 3
           ) avg_tbl ON LOWER(COALESCE(t.user_merchant_name, t.merchant_name, t.name)) = avg_tbl.merchant
           WHERE t.amount > 0 AND t.pending = false
             AND COALESCE(t.is_reimbursed, false) = false
             AND t.date >= CURRENT_DATE - INTERVAL '2 months'
             AND (t.amount * COALESCE(la.spending_split_pct, 100) / 100.0) > avg_tbl.avg_amount * 2
           ORDER BY t.date DESC
           LIMIT 10`
        );
        if (anomalyData.rows.length > 0) {
          userMsg += "\n\n=== ANOMALY DETECTION DATA ===\n" +
            "Recent transactions significantly above their merchant's typical amount:\n" +
            anomalyData.rows.map(r =>
              sanitizeForPrompt(r.user_merchant_name || r.merchant_name || r.name) + ": $" + parseFloat(r.amount).toFixed(2) +
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
        // Use shared NOT_TRANSFER + spending_split_pct so seasonal numbers
        // shown to the AI match the "Monthly Spending (6mo)" block earlier in
        // the same prompt — the previous query was a raw SUM that included
        // credit-card payments, ACH transfers, and 100% of joint-account spend.
        const seasonalData = await pool.query(
          `SELECT EXTRACT(MONTH FROM t.date)::int AS month_num,
                  TO_CHAR(t.date, 'Mon') AS month_name,
                  EXTRACT(YEAR FROM t.date)::int AS year,
                  ROUND(SUM(t.amount * COALESCE(la.spending_split_pct, 100) / 100.0), 2) AS total
           FROM transactions t
           LEFT JOIN linked_accounts la ON la.account_id = t.account_id
           WHERE t.amount > 0 AND t.pending = false
             AND COALESCE(t.is_reimbursed, false) = false
             AND ${NOT_TRANSFER}
             AND t.date >= CURRENT_DATE - INTERVAL '24 months'
           GROUP BY EXTRACT(MONTH FROM t.date), TO_CHAR(t.date, 'Mon'), EXTRACT(YEAR FROM t.date)
           ORDER BY year, month_num`
        );
        if (seasonalData.rows.length >= 6) {
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
        // Word-boundary matching anchors at word edges (Postgres `\y`), so short
        // tokens can't substring-match unrelated merchants. We also avoid bare
        // ambiguous words ("office" → "Box Office", "interest" → "interest charge"
        // on a credit card statement, "supplies" → "Pet Supplies", "business" →
        // "Business Casual" retailer) by preferring multi-word phrases:
        //   - medical:    specific medical-context words only
        //   - charity:    named charities are self-evident
        //   - education:  "student loan" rather than bare "student"
        //   - business:   only multi-word "home office" / "office supplies" /
        //                 "business expense" — drops bare "office"/"supplies"/"business"
        //   - tax:        "mortgage interest" / "student loan interest" rather
        //                 than bare "mortgage" / "interest" (which match payments
        //                 and credit-card finance charges that aren't deductible)
        const taxKeywords = ["doctor", "medical", "pharmacy", "hospital", "dental",
          "charity", "donation", "goodwill", "salvation army", "red cross",
          "tuition", "university", "college", "student loan",
          "home office", "office supplies", "office depot", "business expense",
          "mortgage interest", "student loan interest", "property tax", "state tax"];
        const taxRegex = "\\y(" + taxKeywords.join("|") + ")\\y";
        const taxData = await pool.query(
          `SELECT COALESCE(merchant_name, name) AS merchant, SUM(amount) AS total, COUNT(*) AS txn_count
           FROM transactions
           WHERE pending = false AND amount > 0
             AND COALESCE(is_reimbursed, false) = false
             AND date >= date_trunc('year', CURRENT_DATE)
             AND COALESCE(merchant_name, name) ~* $1
           GROUP BY COALESCE(merchant_name, name)
           ORDER BY total DESC LIMIT 15`,
          [taxRegex]
        );
        if (taxData.rows.length > 0) {
          userMsg += "\n\n=== POTENTIAL TAX-DEDUCTIBLE TRANSACTIONS (YTD) ===\n" +
            taxData.rows.map(r => sanitizeForPrompt(r.merchant) + ": $" + parseFloat(r.total).toFixed(2) + " (" + r.txn_count + " transactions)").join("\n");

          // Persist flagged deductions to tax_deductions table for year-round accumulation
          for (const row of taxData.rows) {
            await pool.query(
              `INSERT INTO tax_deductions (tax_year, merchant, amount, category, deduction_type)
               VALUES (EXTRACT(YEAR FROM CURRENT_DATE), $1, $2, 'flagged', 'ai_detected')
               ON CONFLICT (merchant, tax_year) WHERE transaction_id IS NULL
               DO UPDATE SET amount = EXCLUDED.amount, flagged_at = now()`,
              [row.merchant, parseFloat(row.total)]
            ).catch(err => console.error("tax_deductions upsert error for", row.merchant, ":", err.message));
          }
        }
      } catch (err) { console.error("Tax deductions query error:", err.message); }
    }

    // --- Module: Goal tracking (dynamic data) ---
    if (modules.goal_tracking !== false) {
      try {
        const goalsData = await pool.query("SELECT name, type, target_amount, current_amount, monthly_contribution, target_date, interest_rate FROM financial_goals WHERE is_active = true");
        if (goalsData.rows.length > 0) {
          userMsg += "\n\n=== FINANCIAL GOALS ===\n" +
            goalsData.rows.map(g => {
              const target = parseFloat(g.target_amount);
              const current = parseFloat(g.current_amount);
              const pct = target > 0 ? Math.round(current / target * 100) : 0;
              let line = sanitizeForPrompt(g.name) + " (" + g.type + "): $" + current.toFixed(2) + " / $" + target.toFixed(2) + " (" + pct + "%)";
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
          (outgoing.length > 0 ? outgoing.map(r => sanitizeForPrompt(r.display_name) + ": $" + parseFloat(r.amount).toFixed(2) + " every " + r.cadence_days + " days (" + r.transfer_type + ")").join("\n") : "(none)") +
          "\n\nIncoming (" + incoming.length + " transfers, $" + inTotal.toFixed(2) + "/mo):\n" +
          (incoming.length > 0 ? incoming.map(r => sanitizeForPrompt(r.display_name) + ": $" + Math.abs(parseFloat(r.amount)).toFixed(2) + " every " + r.cadence_days + " days (" + r.transfer_type + ")").join("\n") : "(none)");
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

    // --- Enrichment: Current budget status (honors splits via shared helper) ---
    try {
      const { getCategorySpendingThisMonth } = require("../services/financial-queries");
      const [budgetRows, catSpending] = await Promise.all([
        pool.query("SELECT category, monthly_limit FROM budgets ORDER BY monthly_limit DESC"),
        getCategorySpendingThisMonth(pool),
      ]);
      const catMap = {};
      for (const r of catSpending) catMap[r.category] = parseFloat(r.spent);
      const budgetStatus = {
        rows: budgetRows.rows.map(b => ({
          category: b.category,
          monthly_limit: b.monthly_limit,
          spent: catMap[b.category] || 0,
        })),
      };
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

    // Include long-term context — prefer the structured summary when
    // available; fall back to the legacy text column for sessions that
    // haven't yet migrated. The structured form is rendered into readable
    // bullets here; the next AI run replaces it with an updated structured
    // summary via the tool. Eventually the text column will be retired.
    if (runningSummaryJson) {
      const rendered = renderStructuredSummaryForPrompt(runningSummaryJson);
      if (rendered) userMsg += "\n\n=== LONG-TERM CONTEXT (cumulative memory from past analyses) ===\n" + rendered;
    } else if (runningSummary) {
      userMsg += "\n\n=== LONG-TERM CONTEXT (your cumulative memory from past analyses) ===\n" + runningSummary;
    }
    if (prevInsight.rows.length > 0) {
      const prev = prevInsight.rows[0];
      const date = new Date(prev.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" });
      userMsg += "\n\n=== MOST RECENT ANALYSIS [" + date + "] ===\n" + prev.insight_text.substring(0, 600) + (prev.insight_text.length > 600 ? "..." : "");
    }

    const client = new Anthropic();
    // Tool-use replaces the previous `---RUNNING_SUMMARY---` delimiter
    // pattern. The model is forced (via tool_choice) to produce a structured
    // response with both insights_text and a typed summary, so we never have
    // to text-parse a delimiter and the long-term memory is auditable JSON.
    const maxTokens = Math.min(8192, 2000 + activeModules.length * 250);
    const message = await client.messages.create({
      model: modelId, max_tokens: maxTokens,
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      tools: [INSIGHT_TOOL],
      tool_choice: { type: "tool", name: "generate_financial_insight" },
      messages: [{ role: "user", content: userMsg }],
    });
    const usage = message.usage || {};
    const tokensUsed = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    const hitTokenCap = message.stop_reason === "max_tokens";
    const toolBlock = message.content.find(b => b.type === "tool_use");
    let insightText = "";
    let newSummaryJson = null;
    let summaryStatus = "updated";
    if (toolBlock && toolBlock.input && typeof toolBlock.input.insights_text === "string" && toolBlock.input.summary) {
      insightText = String(toolBlock.input.insights_text).trim();
      newSummaryJson = sanitizeStructuredSummary(toolBlock.input.summary);
      if (!newSummaryJson) {
        // Validation rejected the model's summary shape — preserve prior.
        newSummaryJson = runningSummaryJson;
        summaryStatus = "preserved_validation_failed";
        console.warn("Insights: structured summary failed validation; keeping prior summary.");
      }
    } else {
      // No tool block at all (rare with tool_choice forced) — fall back to
      // any text content the model returned, keep prior summary.
      const textBlock = message.content.find(b => b.type === "text");
      insightText = (textBlock && textBlock.text ? textBlock.text : "").trim();
      newSummaryJson = runningSummaryJson;
      summaryStatus = hitTokenCap ? "preserved_due_to_truncation" : "preserved_no_tool_block";
      if (hitTokenCap) {
        console.warn("Insights: stop_reason=max_tokens before tool block emitted. Consider raising max_tokens or trimming module set.");
      } else {
        console.warn("Insights: no tool_use block in response; long-term memory not advanced.");
      }
    }
    // Backward-compat: render the structured summary to text for the legacy
    // `insights_running_summary` column so any consumer not yet updated to
    // read JSON still sees a meaningful long-term memory string.
    const newSummaryText = newSummaryJson ? renderStructuredSummaryForPrompt(newSummaryJson) : null;
    const actualModel = message.model || modelId;
    const insightRow = await pool.query(
      "INSERT INTO financial_insights (insight_text, period_start, period_end, model_used, tokens_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES ($1, CURRENT_DATE - INTERVAL '6 months', CURRENT_DATE, $2, $3, $4, $5, $6, $7) RETURNING id",
      [insightText, actualModel, tokensUsed, usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0]
    );
    const insightId = insightRow.rows[0]?.id || null;
    if (summaryStatus === "updated" && newSummaryJson) {
      await pool.query(
        "UPDATE user_settings SET insights_running_summary = $1, insights_running_summary_json = $2, insights_last_run = now() WHERE id = 1",
        [newSummaryText, newSummaryJson]
      ).catch(err => console.error("insights_running_summary update failed:", err.message));
    } else {
      await pool.query("UPDATE user_settings SET insights_last_run = now() WHERE id = 1")
        .catch(err => console.error("insights_last_run update failed:", err.message));
    }

    // Run audit against the insight
    let auditResult = null;
    try {
      auditResult = await auditInsight(insightText, insightId);
      if (auditResult.summary.critical > 0) {
        try {
          const { sendToAll } = require("./notifications");
          await sendToAll({
            title: "AI Insight audit: issues found",
            body: `${auditResult.summary.critical} critical, ${auditResult.summary.warning} warning findings. Review in Settings.`,
            tag: "audit-alert",
            data: { url: "/settings" },
          });
        } catch {}
      }
    } catch (auditErr) {
      console.error("AI audit error:", auditErr.message);
    }

    // Send insight via webhook to Per-sistant for email delivery
    try {
      const { sendPerSistantWebhook } = require("./persistent");
      const auditNote = auditResult && auditResult.summary.critical > 0
        ? `\n\n⚠ Audit flagged ${auditResult.summary.critical} critical finding(s). Review accuracy before acting on this report.`
        : "";
      await sendPerSistantWebhook("insights_generated", {
        subject: "Perfin AI Financial Analysis — " + new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
        plain_text: insightText + auditNote,
        html_body: renderInsightEmail(insightText, activeModules, auditResult),
        modules_used: activeModules,
        cost_usd: parseFloat(estimateCostGranular(usage, actualModel).toFixed(6)),
      });
    } catch (whErr) {
      console.error("Insight webhook email error:", whErr.message);
    }

    const costUsd = estimateCostGranular(usage, actualModel);
    return {
      ok: true,
      insight: insightText,
      tokens_used: tokensUsed,
      modules_used: activeModules,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
      estimated_cost_usd: parseFloat(costUsd.toFixed(6)),
      stop_reason: message.stop_reason,
      summary_status: summaryStatus,
      audit: auditResult ? auditResult.summary : null,
    };
  } catch (err) {
    console.error("Insights error:", err.message);
    return { ok: false, status: 500, error: "An internal error occurred." };
  }
}

// POST /api/insights — HTTP wrapper around generateInsights().
router.post("/api/insights", async (_req, res) => {
  const result = await generateInsights();
  if (!result.ok) {
    const { status, ...body } = result;
    return res.status(status || 500).json(body);
  }
  const { ok, ...body } = result;
  res.json(body);
});

// POST /api/insights/reset
router.post("/api/insights/reset", async (_req, res) => {
  try {
    // Clear both legacy text and structured JSON so a reset is total.
    await pool.query(
      "UPDATE user_settings SET insights_running_summary = NULL, insights_running_summary_json = NULL WHERE id = 1"
    );
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
    );
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
      pool.query("SELECT insight_text, created_at FROM financial_insights WHERE entry_type = 'insight' ORDER BY created_at ASC"),
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
    // Rebuild also uses the structured-output tool so the rebuilt summary
    // matches the same shape new runs produce — without this, a /rebuild
    // would overwrite JSON with text and the next /api/insights call would
    // see no structured context.
    const message = await client.messages.create({
      model: modelId, max_tokens: 1500,
      system: [{ type: "text", text:
        "You are a personal finance advisor. Synthesize a chronological timeline of past financial analyses into a structured cumulative summary that future analyses will use as persistent memory. Use the `generate_financial_insight` tool to return:\n" +
        "  - insights_text: a brief 1-2 sentence acknowledgement that the rebuild is complete (this won't be displayed prominently).\n" +
        "  - summary: structured cumulative memory with trends / completed_goals / pending_actions / alerts arrays as defined in the tool schema. Cover the user's baseline spending levels, long-term trends, key subscriptions and changes, progress on past recommendations, and any recurring concerns worth tracking.",
        cache_control: { type: "ephemeral" },
      }],
      tools: [INSIGHT_TOOL],
      tool_choice: { type: "tool", name: "generate_financial_insight" },
      messages: [{ role: "user", content: "=== ALL PAST ANALYSES ===\n" + timeline }],
    });
    const usage = message.usage || {};
    const tokensUsed = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    const toolBlock = message.content.find(b => b.type === "tool_use");
    if (!toolBlock || !toolBlock.input || !toolBlock.input.summary) {
      return res.status(500).json({ error: "Rebuild did not return expected structured summary." });
    }
    const newSummaryJson = sanitizeStructuredSummary(toolBlock.input.summary);
    if (!newSummaryJson) {
      return res.status(500).json({ error: "Rebuild summary failed validation." });
    }
    const newSummaryText = renderStructuredSummaryForPrompt(newSummaryJson) || "";
    await pool.query(
      "UPDATE user_settings SET insights_running_summary = $1, insights_running_summary_json = $2 WHERE id = 1",
      [newSummaryText, newSummaryJson]
    );
    res.json({
      ok: true,
      message: "Long-term context rebuilt from " + allInsights.rows.length + " historical analyses.",
      summary: newSummaryJson,
      summary_text: newSummaryText,
      tokens_used: tokensUsed,
    });
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

// GET /api/insights/audit — audit log, per-run stats, and 90-day accuracy summary
router.get("/api/insights/audit", async (_req, res) => {
  try {
    const recent = await pool.query(
      `SELECT al.*, fi.created_at AS insight_date
       FROM ai_audit_log al
       LEFT JOIN financial_insights fi ON fi.id = al.insight_id
       ORDER BY al.created_at DESC LIMIT 50`
    );
    const [stats, accuracy] = await Promise.all([
      getAuditStats(10),
      getAuditAccuracy(90),
    ]);
    res.json({ findings: recent.rows, stats, accuracy });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
module.exports.renderInsightEmail = renderInsightEmail;
module.exports.generateInsights = generateInsights;
