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
  sonnet: "claude-sonnet-4-6-20250415",
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

module.exports = { callAI, getAIModelForFeature, getCached, setCache, AI_MODELS, isAIAvailable };
