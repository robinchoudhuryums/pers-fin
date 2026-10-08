// ============================================================================
// Claude 5.5 model upgrade (Perfin) — pins
// ============================================================================
// MODEL_MAP → claude-haiku-5-5 / claude-sonnet-5-5 / claude-opus-5-5. Opus and
// Sonnet 5.5 reject a forced tool_choice (400), and all three think by default,
// so structured calls go through services/claude.js createToolCall (auto +
// strict tool + one re-ask) with an explicit effort and thinking headroom.
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const ref = require("../teller/data/reference-data");
const claude = require("../teller/services/claude");

describe("model tiers map to the current (5.5) models", () => {
  it("MODEL_MAP", () => {
    assert.deepEqual(ref.MODEL_MAP, { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });
  });
  it("5.5 list prices", () => {
    const h = ref.modelRates("claude-haiku-5-5"), s = ref.modelRates("claude-sonnet-5-5"), o = ref.modelRates("claude-opus-5-5");
    assert.deepEqual([h.input, h.output, h.cache_read, h.cache_write], [0.1, 0.5, 0.01, 0.125]);
    assert.deepEqual([s.input, s.output, s.cache_read], [2, 10, 0.2]);
    assert.deepEqual([o.input, o.output, o.cache_read], [4, 20, 0.2]);
  });
  it("Haiku 5.5 switches to the long-prompt rate card above 100K prompt tokens", () => {
    const short = ref.estimateCostGranular({ input_tokens: 100000, output_tokens: 1e6 }, "claude-haiku-5-5");
    assert.ok(Math.abs(short - (0.01 + 0.5)) < 1e-9, String(short));
    const long = ref.estimateCostGranular({ input_tokens: 60000, cache_read_input_tokens: 50000, output_tokens: 1e6 }, "claude-haiku-5-5");
    assert.ok(Math.abs(long - (0.03 + 0.0025 + 2.5)) < 1e-9, String(long));
  });
  it("stored rows from previous models keep their own prices", () => {
    assert.equal(ref.modelRates("claude-haiku-4-5-20251001").input, 1);
    assert.equal(ref.modelRates("claude-sonnet-4-6").input, 3);
  });
});

describe("no forced tool_choice anywhere (400 on Opus/Sonnet 5.5)", () => {
  it("teller + Per-sistant sources", () => {
    const offenders = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (f.name === "node_modules" || f.name === "tests") continue;
        const rel = path.join(dir, f.name);
        if (f.isDirectory()) walk(rel);
        else if (f.name.endsWith(".js") && /tool_choice:\s*\{\s*type:\s*["'](tool|any)["']/.test(read(rel))) offenders.push(rel);
      }
    };
    walk("teller"); walk(path.join("apps", "per-sistant")); walk("shell");
    assert.deepEqual(offenders, []);
  });
  it("every Perfin model call sets an explicit effort", () => {
    for (const f of ["insights.js", "categorize.js", "budgets.js", "housing.js", "ask.js"]) {
      const src = read("teller", "routes", f);
      const calls = (src.match(/(createToolCall\(client, \{|messages\.create\(\{)/g) || []).length;
      const efforts = (src.match(/effortParams\("(extract|analyze)"\)/g) || []).length;
      assert.ok(calls > 0 && efforts >= calls, `${f}: ${calls} call(s), ${efforts} effort setting(s)`);
    }
  });
  it("strict tools carry additionalProperties:false on every object", () => {
    const { INSIGHT_TOOL } = require("../teller/routes/insights");
    const walk = (o) => { if (o && o.type === "object") assert.equal(o.additionalProperties, false); for (const v of Object.values(o.properties || {})) walk(v); if (o.items) walk(o.items); };
    walk(INSIGHT_TOOL.input_schema);
    for (const f of ["categorize.js", "budgets.js", "housing.js"]) {
      const src = read("teller", "routes", f);
      assert.match(src, /strict: true/, f);
      assert.equal((src.match(/type: "object",\s*\n\s*additionalProperties: false/g) || []).length,
        (src.match(/type: "object"/g) || []).length, f + ": every object is closed");
    }
  });
});

describe("createToolCall", () => {
  const tool = (stop = "tool_use") => ({ stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "thinking", thinking: "" }, { type: "tool_use", name: "t", input: { ok: 1 } }] });
  const prose = (stop = "end_turn") => ({ stop_reason: stop, usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: "text", text: "here you go" }] });
  function fake(queue) {
    const sent = [];
    return { sent, messages: { create: async (req) => { sent.push(req); const r = queue.shift(); if (r instanceof Error) throw r; return r; } } };
  }

  it("sends tool_choice auto and returns a direct tool call (thinking block first)", async () => {
    const c = fake([tool()]);
    const m = await claude.createToolCall(c, { model: "x", messages: [{ role: "user", content: "q" }], tools: [] }, "t");
    assert.deepEqual(c.sent[0].tool_choice, { type: "auto" });
    assert.equal(c.sent.length, 1);
    assert.deepEqual(claude.toolUseOf(m, "t").input, { ok: 1 });
  });
  it("re-asks ONCE after a prose answer, append-only, and sums usage", async () => {
    const c = fake([prose(), tool()]);
    const m = await claude.createToolCall(c, { model: "x", messages: [{ role: "user", content: "q" }], tools: [] }, "t");
    assert.equal(c.sent.length, 2);
    const msgs = c.sent[1].messages;
    assert.equal(msgs.length, 3);
    assert.equal(msgs[1].role, "assistant");
    assert.deepEqual(msgs[1].content, prose().content);
    assert.match(msgs[2].content, /Call the t tool now/);
    assert.deepEqual(m.usage, { input_tokens: 17, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });
  it("does not re-ask after max_tokens or a refusal", async () => {
    for (const stop of ["max_tokens", "refusal"]) {
      const c = fake([prose(stop)]);
      await claude.createToolCall(c, { model: "x", messages: [{ role: "user", content: "q" }], tools: [] }, "t");
      assert.equal(c.sent.length, 1, stop);
    }
  });
  it("a failed re-ask keeps the first response (its usage is still charged)", async () => {
    const c = fake([prose(), new Error("boom")]);
    const m = await claude.createToolCall(c, { model: "x", messages: [{ role: "user", content: "q" }], tools: [] }, "t");
    assert.equal(m.usage.input_tokens, 7);
  });
  it("textOf skips thinking blocks", () => {
    assert.equal(claude.textOf({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
  });
  it("effortParams", () => {
    assert.deepEqual(claude.effortParams("extract"), { output_config: { effort: "low" } });
    assert.deepEqual(claude.effortParams("analyze"), { output_config: { effort: "medium" } });
  });
});
