// ============================================================================
// Claude call helpers for the 5.5 model family
// ============================================================================
// MODEL_MAP (data/reference-data.js) points the haiku / sonnet / opus tiers at
// claude-haiku-5-5 / claude-sonnet-5-5 / claude-opus-5-5. Two API changes
// matter for every structured-output call in Perfin:
//   - Opus 5.5 and Sonnet 5.5 REJECT a forced tool_choice ({type:"tool"} /
//     {type:"any"} → 400). Structured calls use tool_choice "auto" with a
//     `strict: true` tool (schema-valid input guaranteed), an instruction in
//     the prompt, and a check that the call happened — createToolCall()
//     re-asks once when the model answered in prose instead.
//   - All three models think by default (adaptive thinking). Thinking tokens
//     are billed as output and count against max_tokens, so every call sets
//     an explicit `effort` (effortParams) and a max_tokens with headroom, and
//     reads content blocks by `type` (a response can start with a thinking
//     block). Thinking blocks are passed back unchanged (append-only).
// A safety decline is a normal 200 with stop_reason "refusal" — callers treat
// it like "no tool call / no text" (their existing fallback paths).

// Effort per task shape. Low for extraction / classification, medium for the
// analysis-style calls. (Defaults differ per model — Haiku/Opus 5.5 medium,
// Sonnet 5.5 high — so it is always set explicitly.)
const EFFORT = {
  extract: "low",   // categorize, bill OCR, budget suggestions
  analyze: "medium", // insights, context rebuild, Ask
};

function effortParams(kind) {
  return { output_config: { effort: EFFORT[kind] || "medium" } };
}

// Concatenated text blocks (skips thinking / tool_use blocks).
function textOf(message) {
  return ((message && message.content) || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function toolUseOf(message, toolName) {
  return ((message && message.content) || [])
    .find((b) => b.type === "tool_use" && (!toolName || b.name === toolName)) || null;
}

function addUsage(a, b) {
  const out = { ...(a || {}) };
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    out[k] = (Number(out[k]) || 0) + (Number(b && b[k]) || 0);
  }
  return out;
}

// One structured call: tool_choice auto + the given tools, then — if the model
// ended its turn WITHOUT calling `toolName` (and didn't stop for max_tokens or
// a refusal) — ONE follow-up turn asking it to call the tool now. Returns the
// final message with `usage` = the SUM over both calls, so the caller's
// cap-charge covers every token spent.
async function createToolCall(client, params, toolName) {
  const req = { ...params, tool_choice: { type: "auto" } };
  const first = await client.messages.create(req);
  if (toolUseOf(first, toolName) || first.stop_reason !== "end_turn") return first;
  let retry;
  try {
    retry = await client.messages.create({
      ...req,
      messages: [
        ...req.messages,
        { role: "assistant", content: first.content },
        { role: "user", content: `Call the ${toolName} tool now with your answer — reply with the tool call only.` },
      ],
    });
  } catch (err) {
    // Keep the first response (and its usage, so the caller still charges
    // the cap for it) rather than losing the spend to a thrown retry.
    console.error(`createToolCall(${toolName}) follow-up failed:`, err.message);
    return first;
  }
  return { ...retry, usage: addUsage(first.usage, retry.usage) };
}

module.exports = { EFFORT, effortParams, textOf, toolUseOf, addUsage, createToolCall };
