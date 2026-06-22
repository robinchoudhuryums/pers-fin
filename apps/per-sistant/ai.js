// ============================================================================
// Per-sistant — AI (Anthropic Claude) Helpers
// ============================================================================

const { pool } = require("./db");
const { VALID_AI_FEATURES } = require("./config");

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch { Anthropic = null; }

// AI model mapping
const AI_MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  // Bare alias — `claude-sonnet-4-6` has no dated snapshot variant; the old
  // `-20250415` suffix was not a real model ID and risks a 404.
  sonnet: "claude-sonnet-4-6",
};

// Singleton Anthropic client
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient && Anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// Simple TTL cache for AI responses
const aiCache = new Map();
function getCached(key, ttlMs) {
  const entry = aiCache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.value;
  return null;
}
function setCache(key, value) {
  aiCache.set(key, { value, ts: Date.now() });
}

async function callAI(model, prompt, maxTokens = 1024, systemPrompt = null) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) throw new Error("AI not configured");
  if (!AI_MODELS[model]) throw new Error("Invalid model: " + model);
  const client = getAnthropicClient();
  if (!client) throw new Error("AI not configured");
  const params = {
    model: AI_MODELS[model],
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (systemPrompt) {
    params.system = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
  }
  const msg = await client.messages.create(params);
  return msg.content[0].text.trim();
}

// ---------------------------------------------------------------------------
// AI cost cap (D1) — Per-sistant's monthly AI budget, introduced by Job Radar.
// Mirrors Perfin's check-then-charge: callers read getAiBudgetCents() +
// monthlyAiSpendCents(pool), 429 when over, then charge a recordAiUsage() row
// (in a finally — idempotent via a `charged` flag) when tokens were consumed.
// ---------------------------------------------------------------------------
// Cents per token (approx Anthropic list pricing; input / output).
const AI_PRICING = {
  haiku: { input: 0.0001, output: 0.0005 },   // ~$1 / ~$5 per MTok
  sonnet: { input: 0.0003, output: 0.0015 },  // ~$3 / ~$15 per MTok
};
function estimateCostCents(model, usage = {}) {
  const p = AI_PRICING[model] || AI_PRICING.haiku;
  return (Number(usage.input_tokens) || 0) * p.input + (Number(usage.output_tokens) || 0) * p.output;
}

const DEFAULT_AI_BUDGET_CENTS = 100; // $1.00/month fallback
async function getAiBudgetCents() {
  try {
    const r = await pool.query("SELECT ai_monthly_budget_cents FROM user_settings WHERE id = 1");
    const v = parseInt(r.rows[0] && r.rows[0].ai_monthly_budget_cents, 10);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* fall through to env/default */ }
  return parseInt(process.env.PERSISTENT_AI_BUDGET_CENTS, 10) || DEFAULT_AI_BUDGET_CENTS;
}
async function monthlyAiSpendCents(pool_) {
  const p = pool_ || pool;
  try {
    const r = await p.query("SELECT COALESCE(SUM(cost_cents), 0) AS c FROM ai_usage WHERE created_at >= date_trunc('month', now())");
    return parseFloat(r.rows[0].c) || 0;
  } catch { return 0; }
}
async function recordAiUsage(pool_, { entry_type, model, usage = {} }) {
  const p = pool_ || pool;
  const cost = estimateCostCents(model, usage);
  await p.query(
    "INSERT INTO ai_usage (entry_type, model, input_tokens, output_tokens, cost_cents) VALUES ($1,$2,$3,$4,$5)",
    [entry_type, model, Number(usage.input_tokens) || 0, Number(usage.output_tokens) || 0, cost]);
  return cost;
}

// Like callAI but returns { text, usage } so the caller can charge the cap.
// `client` is injectable for tests (the Module._load fake-SDK pattern).
async function callAIWithUsage(model, prompt, maxTokens = 1024, systemPrompt = null, client = null) {
  if (!AI_MODELS[model]) throw new Error("Invalid model: " + model);
  const c = client || getAnthropicClient();
  if (!c) throw new Error("AI not configured");
  const params = { model: AI_MODELS[model], max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (systemPrompt) params.system = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
  const msg = await c.messages.create(params);
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const usage = { input_tokens: (msg.usage && msg.usage.input_tokens) || 0, output_tokens: (msg.usage && msg.usage.output_tokens) || 0 };
  return { text, usage };
}

// Source-grounded answer using the Citations feature. Each source is sent as a
// plain-text `document` block with citations enabled; the response interleaves
// text blocks, some carrying a `.citations[]` array that points back at the
// document that backed the claim. Returns the assembled answer text plus the
// 0-based indexes of documents that were actually cited (index === position in
// `documents`). All our models support citations (only Haiku 3 doesn't).
// `client` is injectable for tests.
async function answerWithCitations({ model, system, query, documents, maxTokens = 1024, client }) {
  const c = client || getAnthropicClient();
  if (!c) throw new Error("AI not configured");
  if (!AI_MODELS[model]) throw new Error("Invalid model: " + model);
  const docBlocks = (documents || []).map((d) => ({
    type: "document",
    source: { type: "text", media_type: "text/plain", data: String(d.content || "") },
    ...(d.title ? { title: String(d.title).slice(0, 200) } : {}),
    citations: { enabled: true },
  }));
  const params = {
    model: AI_MODELS[model],
    max_tokens: maxTokens,
    messages: [{ role: "user", content: docBlocks.concat([{ type: "text", text: query }]) }],
  };
  if (system) params.system = system;
  const msg = await c.messages.create(params);
  let text = "";
  const cited = new Set();
  const spans = [];
  for (const block of msg.content || []) {
    if (block.type !== "text") continue;
    text += block.text;
    for (const cit of block.citations || []) {
      if (typeof cit.document_index === "number") cited.add(cit.document_index);
      spans.push({ document_index: cit.document_index, cited_text: cit.cited_text });
    }
  }
  return { text: text.trim(), citedIndexes: Array.from(cited).sort((a, b) => a - b), citations: spans };
}

async function getAIModelForFeature(feature) {
  if (!VALID_AI_FEATURES.includes(feature)) return "off";
  try {
    const r = await pool.query(`SELECT ai_model_${feature} as model FROM user_settings WHERE id = 1`);
    return r.rows[0]?.model || "off";
  } catch { return "off"; }
}

function isAIAvailable() {
  return !!(Anthropic && process.env.ANTHROPIC_API_KEY);
}

module.exports = {
  callAI, callAIWithUsage, answerWithCitations, getAIModelForFeature, getCached, setCache,
  AI_MODELS, isAIAvailable,
  // AI cost cap (D1)
  estimateCostCents, getAiBudgetCents, monthlyAiSpendCents, recordAiUsage, AI_PRICING,
};
