// ============================================================================
// Claude 5.5 model upgrade (Per-sistant ai.js) — pins
// ============================================================================
// AI_MODELS → claude-haiku-5-5 / claude-sonnet-5-5. Both think by default:
// text is read by block type (content[0] may be a thinking block), every call
// sets an explicit effort with thinking headroom on max_tokens, and the cap
// prices the 5.5 rates (incl. cache tokens and Haiku's long-prompt card).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ai = require("../ai");

const thinkingFirst = (text, usage = { input_tokens: 100, output_tokens: 40 }) => ({
  stop_reason: "end_turn", usage,
  content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text }],
});
function fake(resp) { const sent = []; return { sent, messages: { create: async (r) => { sent.push(r); return resp; } } }; }

describe("Per-sistant model upgrade", () => {
  it("AI_MODELS are the 5.5 models", () => {
    assert.deepEqual(ai.AI_MODELS, { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5" });
  });
  it("responseText reads text blocks even when a thinking block comes first", () => {
    assert.equal(ai.responseText(thinkingFirst("  Hello  ")), "Hello");
  });
  it("responseText throws a REFUSAL error on a safety decline", () => {
    assert.throws(() => ai.responseText({ stop_reason: "refusal", content: [] }), (e) => e.code === "REFUSAL");
  });
  it("callAIWithUsage: low effort, thinking headroom, text by type, cache tokens in usage", async () => {
    const c = fake(thinkingFirst("Fit: 80", { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 500 }));
    const r = await ai.callAIWithUsage("haiku", "p", 300, "sys", c);
    assert.equal(r.text, "Fit: 80");
    assert.equal(c.sent[0].model, "claude-haiku-5-5");
    assert.deepEqual(c.sent[0].output_config, { effort: "low" });
    assert.equal(c.sent[0].max_tokens, 300 + 2048);
    assert.equal(r.usage.cache_read_input_tokens, 500);
  });
  it("callAIWithUsage returns empty text (not a throw) on a refusal so the spend is still charged", async () => {
    const r = await ai.callAIWithUsage("haiku", "p", 300, null, fake({ stop_reason: "refusal", usage: { input_tokens: 9, output_tokens: 0 }, content: [] }));
    assert.equal(r.text, "");
    assert.equal(r.usage.input_tokens, 9);
  });
  it("answerWithCitations uses medium effort and reads cited text by type", async () => {
    const resp = { stop_reason: "end_turn", usage: {}, content: [{ type: "thinking", thinking: "" },
      { type: "text", text: "Deductible is $500", citations: [{ document_index: 0, cited_text: "$500" }] }] };
    const c = fake(resp);
    const out = await ai.answerWithCitations({ model: "sonnet", query: "q", documents: [{ content: "d" }], client: c });
    assert.equal(out.text, "Deductible is $500");
    assert.deepEqual(out.citedIndexes, [0]);
    assert.equal(c.sent[0].model, "claude-sonnet-5-5");
    assert.deepEqual(c.sent[0].output_config, { effort: "medium" });
  });
  it("estimateCostCents: 5.5 prices, cache tokens, Haiku long-prompt card", () => {
    assert.ok(Math.abs(ai.estimateCostCents("haiku", { input_tokens: 1e6, output_tokens: 1e6 }) - 300) < 1e-6);    // 1M-token prompt → long card: $0.50 + $2.50
    assert.ok(Math.abs(ai.estimateCostCents("haiku", { input_tokens: 50000, output_tokens: 1000 }) - (0.5 + 0.05)) < 1e-9);
    assert.ok(Math.abs(ai.estimateCostCents("sonnet", { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10000 }) - (0.2 + 1 + 0.2)) < 1e-9);
  });
});
