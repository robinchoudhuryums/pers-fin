// ============================================================================
// Roadmap T2.3 C1 — the capped AI wrappers (ai.js)
// ============================================================================
// cappedAI / cappedCitations over a fake Anthropic client with the cap reads
// stubbed: under the cap → one model call and one charged row (cache tokens
// included); at / over the cap → CAP with the figures, no model call, nothing
// charged; a refusal charged; a thrown call not charged; a failed charge never
// losing the answer; an unreadable spend → CAP_CHECK_FAILED, no model call.
// monthlyAiSpendCents over a fake pool: the APP_TIMEZONE month start (two
// zones whose dates differ from UTC's, an invalid zone → UTC) and a read error
// thrown, not read as $0. Job Radar's cappedCall delegating to cappedAI.
// ============================================================================
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const ai = require("../ai");
const jobs = require("../routes/jobs");

const saved = { b: ai.getAiBudgetCents, s: ai.monthlyAiSpendCents, r: ai.recordAiUsage, c: ai.cappedAI };
afterEach(() => {
  ai.getAiBudgetCents = saved.b; ai.monthlyAiSpendCents = saved.s; ai.recordAiUsage = saved.r; ai.cappedAI = saved.c;
});

function stubCap({ budget = 100, spent = 0, spentThrows = false, chargeThrows = false } = {}) {
  const charged = [];
  ai.getAiBudgetCents = async () => budget;
  ai.monthlyAiSpendCents = async () => { if (spentThrows) throw new Error("db down"); return spent; };
  ai.recordAiUsage = async (_pool, row) => {
    if (chargeThrows) throw new Error("insert failed");
    charged.push(row);
    return ai.estimateCostCents(row.model, row.usage);
  };
  return charged;
}
function fakeClient(resp, { throws = false } = {}) {
  const sent = [];
  return { sent, messages: { create: async (p) => { sent.push(p); if (throws) throw new Error("529 overloaded"); return resp; } } };
}
const OK = { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Draft ready" }],
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 } };
async function quiet(fn) {
  const orig = console.error; const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try { return { value: await fn(), lines }; } finally { console.error = orig; }
}

describe("cappedAI", () => {
  it("under the cap: one model call, one charged row with all four token counters", async () => {
    const charged = stubCap({ budget: 100, spent: 99.9 });
    const c = fakeClient(OK);
    const meta = {};
    const r = await ai.cappedAI({}, { entry_type: "email_draft", model: "haiku", prompt: "p", system: "s", maxTokens: 300, effort: "medium", meta, client: c });
    assert.equal(r.text, "Draft ready");
    assert.equal(r.stop_reason, "end_turn");
    assert.equal(meta.stop_reason, "end_turn");
    assert.equal(c.sent.length, 1);
    assert.deepEqual(c.sent[0].output_config, { effort: "medium" });
    assert.equal(c.sent[0].max_tokens, 300 + 2048);
    assert.equal(charged.length, 1);
    assert.equal(charged[0].entry_type, "email_draft");
    assert.equal(charged[0].model, "haiku");
    assert.deepEqual(charged[0].usage, { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 });
  });

  it("at or over the cap: CAP with the figures, no model call, nothing charged", async () => {
    for (const spent of [100, 150]) {
      const charged = stubCap({ budget: 100, spent });
      const c = fakeClient(OK);
      await assert.rejects(() => ai.cappedAI({}, { entry_type: "email_draft", model: "haiku", prompt: "p", client: c }), (e) => {
        assert.equal(e.code, "CAP");
        assert.equal(e.spent_cents, spent);
        assert.equal(e.budget_cents, 100);
        assert.match(e.message, /^Monthly AI budget reached \(\$\d+\.\d\d of \$1\.00\)$/);
        return true;
      });
      assert.equal(c.sent.length, 0);
      assert.equal(charged.length, 0);
    }
  });

  it("a refusal is still charged (empty text)", async () => {
    const charged = stubCap();
    const r = await ai.cappedAI({}, { entry_type: "quick_add", model: "haiku", prompt: "p",
      client: fakeClient({ stop_reason: "refusal", content: [], usage: { input_tokens: 9, output_tokens: 2 } }) });
    assert.equal(r.text, "");
    assert.equal(charged.length, 1);
    assert.equal(charged[0].usage.input_tokens, 9);
  });

  it("a model call that throws is not charged and the error propagates", async () => {
    const charged = stubCap();
    await assert.rejects(() => ai.cappedAI({}, { entry_type: "quick_add", model: "haiku", prompt: "p", client: fakeClient(OK, { throws: true }) }), /529/);
    assert.equal(charged.length, 0);
  });

  it("a failed charge is logged and never loses the answer", async () => {
    stubCap({ chargeThrows: true });
    const { value, lines } = await quiet(() => ai.cappedAI({}, { entry_type: "note_tagging", model: "haiku", prompt: "p", client: fakeClient(OK) }));
    assert.equal(value.text, "Draft ready");
    assert.ok(lines.some((l) => /AI usage charge error \(note_tagging\): insert failed/.test(l)));
  });

  it("an unreadable spend refuses the call: CAP_CHECK_FAILED, no model call", async () => {
    const charged = stubCap({ spentThrows: true });
    const c = fakeClient(OK);
    const { lines } = await quiet(() => assert.rejects(
      () => ai.cappedAI({}, { entry_type: "email_draft", model: "haiku", prompt: "p", client: c }),
      (e) => e.code === "CAP_CHECK_FAILED" && /couldn't be checked/.test(e.message)));
    assert.equal(c.sent.length, 0);
    assert.equal(charged.length, 0);
    assert.ok(lines.some((l) => /AI cap check failed: db down/.test(l)));
  });

  it("an entry_type is required", async () => {
    stubCap();
    await assert.rejects(() => ai.cappedAI({}, { model: "haiku", prompt: "p", client: fakeClient(OK) }), /entry_type is required/);
  });

  it("checkAiCap reports the figures", async () => {
    stubCap({ budget: 250, spent: 40 });
    assert.deepEqual(await ai.checkAiCap({}), { ok: true, spent: 40, budget: 250 });
    stubCap({ budget: 250, spent: 250 });
    assert.equal((await ai.checkAiCap({})).ok, false);
  });
});

describe("cappedCitations", () => {
  const CITED = { stop_reason: "end_turn", usage: { input_tokens: 800, output_tokens: 60 },
    content: [{ type: "text", text: "Deductible is $500", citations: [{ document_index: 0, cited_text: "$500" }] }] };

  it("answers, returns usage and charges one row", async () => {
    const charged = stubCap();
    const out = await ai.cappedCitations({}, { entry_type: "rag_query", model: "sonnet", system: "s", query: "q",
      documents: [{ title: "Policy", content: "Deductible $500" }], client: fakeClient(CITED) });
    assert.equal(out.text, "Deductible is $500");
    assert.deepEqual(out.citedIndexes, [0]);
    assert.equal(out.usage.input_tokens, 800);
    assert.equal(charged.length, 1);
    assert.equal(charged[0].entry_type, "rag_query");
    assert.equal(charged[0].model, "sonnet");
  });

  it("a refusal throws REFUSAL and is still charged", async () => {
    const charged = stubCap();
    await assert.rejects(() => ai.cappedCitations({}, { entry_type: "rag_query", model: "sonnet", query: "q", documents: [],
      client: fakeClient({ stop_reason: "refusal", content: [], usage: { input_tokens: 70, output_tokens: 1 } }) }), (e) => e.code === "REFUSAL");
    assert.equal(charged.length, 1);
    assert.equal(charged[0].usage.input_tokens, 70);
  });

  it("over the cap: CAP, no call", async () => {
    const charged = stubCap({ spent: 500 });
    const c = fakeClient(CITED);
    await assert.rejects(() => ai.cappedCitations({}, { entry_type: "rag_query", model: "sonnet", query: "q", documents: [], client: c }), (e) => e.code === "CAP");
    assert.equal(c.sent.length, 0);
    assert.equal(charged.length, 0);
  });
});

describe("monthlyAiSpendCents — the APP_TIMEZONE month", () => {
  const origTz = process.env.APP_TIMEZONE;
  afterEach(() => { if (origTz === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = origTz; });
  const zoneMonth = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).slice(0, 7) + "-01";

  it("counts from the zone's month start, converted in SQL", async () => {
    for (const tz of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
      process.env.APP_TIMEZONE = tz;
      let sql, params;
      const v = await saved.s({ query: async (s, p) => { sql = s; params = p; return { rows: [{ c: "12.5" }] }; } });
      assert.equal(v, 12.5);
      assert.match(sql, /FROM ai_usage WHERE created_at >= \(\$1::date::timestamp AT TIME ZONE \$2\)/);
      assert.doesNotMatch(sql, /date_trunc/);
      assert.deepEqual(params, [zoneMonth(tz), tz]);
    }
  });

  it("an invalid zone falls back to UTC", async () => {
    process.env.APP_TIMEZONE = "Not/AZone";
    let params;
    await saved.s({ query: async (_s, p) => { params = p; return { rows: [{ c: 0 }] }; } });
    assert.deepEqual(params, [zoneMonth("UTC"), "UTC"]);
  });

  it("a read error is thrown, not read as $0", async () => {
    await assert.rejects(() => saved.s({ query: async () => { throw new Error("relation \"ai_usage\" does not exist"); } }), /ai_usage/);
  });
});

describe("Job Radar's cappedCall is cappedAI", () => {
  it("delegates with its entry_type and options", async () => {
    let got;
    ai.cappedAI = async (pool, o) => { got = { pool, o }; return { text: "{}", usage: {} }; };
    const pool = { tag: "p" };
    await jobs.cappedCall(pool, { entry_type: "job_fit", model: "haiku", prompt: "x", system: "s", maxTokens: 200, client: "c" });
    assert.equal(got.pool, pool);
    assert.deepEqual(got.o, { entry_type: "job_fit", model: "haiku", prompt: "x", system: "s", maxTokens: 200, client: "c" });
  });

  it("an unreadable spend stops the fit pass like the cap does", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../routes/jobs.js"), "utf8");
    assert.equal((src.match(/e\.code === "CAP" \|\| e\.code === "CAP_CHECK_FAILED"/g) || []).length, 2);
  });
});
