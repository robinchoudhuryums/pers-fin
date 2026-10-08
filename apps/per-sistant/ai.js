// ============================================================================
// Per-sistant — AI (Anthropic Claude) Helpers
// ============================================================================

const { pool } = require("./db");
const { VALID_AI_FEATURES } = require("./config");

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch { Anthropic = null; }

// AI model mapping — the current model of each line (no date suffix on the
// 5.5 IDs). Both think by default (adaptive thinking; billed as output and
// counted against max_tokens), so every call below sets an explicit effort,
// adds thinking headroom to max_tokens and reads content blocks by type.
const AI_MODELS = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
};

// Effort for Per-sistant's short assistant tasks (drafts, tags, briefings,
// parsing) is "low"; Knowledge Q&A (answerWithCitations) uses "medium".
// THINKING_HEADROOM is added to each caller's maxTokens (which sizes the
// REPLY) so thinking can't starve the answer; only tokens used are billed.
const DEFAULT_EFFORT = "low";
const THINKING_HEADROOM = 2048;
function sizedParams(maxTokens, effort) {
  return { max_tokens: Math.min(16000, (Number(maxTokens) || 1024) + THINKING_HEADROOM), output_config: { effort: effort || DEFAULT_EFFORT } };
}

// Text of a response — thinking / tool blocks skipped. A safety decline
// (stop_reason "refusal") carries no usable text: surface it as an error so
// callers' existing catch paths report "AI unavailable" instead of "".
function responseText(msg) {
  if (msg && msg.stop_reason === "refusal") {
    const err = new Error("The AI declined this request.");
    err.code = "REFUSAL";
    throw err;
  }
  return ((msg && msg.content) || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

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
    ...sizedParams(maxTokens),
    messages: [{ role: "user", content: prompt }],
  };
  if (systemPrompt) {
    params.system = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
  }
  const msg = await client.messages.create(params);
  // By type: a 5.5 response can begin with a thinking block (content[0]).
  return responseText(msg);
}

// ---------------------------------------------------------------------------
// AI cost cap (D1) — Per-sistant's monthly AI budget, introduced by Job Radar.
// Mirrors Perfin's check-then-charge: callers read getAiBudgetCents() +
// monthlyAiSpendCents(pool), 429 when over, then charge a recordAiUsage() row
// (in a finally — idempotent via a `charged` flag) when tokens were consumed.
// ---------------------------------------------------------------------------
// Cents per token for the models AI_MODELS maps to (list pricing; output
// includes thinking tokens). Cache reads 0.1x input, 5-minute cache writes
// 1.25x. Claude Haiku 5.5 has two rate cards: a prompt (input + cache tokens)
// over 100K tokens uses `long`.
const AI_PRICING = {
  haiku: { input: 0.00001, output: 0.00005,                     // $0.10 / $0.50 per MTok
           long: { above: 100000, input: 0.00005, output: 0.00025 } }, // $0.50 / $2.50
  sonnet: { input: 0.0002, output: 0.001 },                     // $2 / $10 per MTok
};
function estimateCostCents(model, usage = {}) {
  const base = AI_PRICING[model] || AI_PRICING.haiku;
  const input = Number(usage.input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  const p = base.long && (input + cacheRead + cacheWrite) > base.long.above ? base.long : base;
  return input * p.input + (Number(usage.output_tokens) || 0) * p.output +
    cacheRead * p.input * 0.1 + cacheWrite * p.input * 1.25;
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
  const params = { model: AI_MODELS[model], ...sizedParams(maxTokens), messages: [{ role: "user", content: prompt }] };
  if (systemPrompt) params.system = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
  const msg = await c.messages.create(params);
  const u = msg.usage || {};
  // Cache tokens ride along so recordAiUsage charges them too.
  const usage = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0 };
  // A refusal yields empty text (not a throw) here: the tokens were spent and
  // the caller must still charge them.
  const text = msg.stop_reason === "refusal" ? "" : responseText(msg);
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
    ...sizedParams(maxTokens, "medium"),
    messages: [{ role: "user", content: docBlocks.concat([{ type: "text", text: query }]) }],
  };
  if (system) params.system = system;
  const msg = await c.messages.create(params);
  if (msg.stop_reason === "refusal") responseText(msg); // throws REFUSAL
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
  AI_MODELS, isAIAvailable, responseText, sizedParams,
  // AI cost cap (D1)
  estimateCostCents, getAiBudgetCents, monthlyAiSpendCents, recordAiUsage, AI_PRICING,
};
