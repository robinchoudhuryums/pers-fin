// ============================================================================
// Per-sistant — Embeddings (Voyage AI)
// ============================================================================
// Single swappable embedding function behind which the provider lives. Phase 1
// uses Voyage (hosted) via native fetch — no SDK dependency. To switch
// providers later, reimplement embed()/EMBED_DIM here; everything else
// (vault-sync, retrieval) only knows embed() + toVectorLiteral().
//
// NOTE: EMBED_DIM (1024) is baked into the `chunks.embedding vector(1024)`
// column. Changing it means a re-embed migration, not a config flip.
// ============================================================================

const VOYAGE_MODEL = process.env.VOYAGE_MODEL || "voyage-3.5";
const EMBED_DIM = 1024;
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
// Voyage accepts up to 128 inputs/request; stay well under to bound payloads.
const MAX_BATCH = 64;

function isConfigured() {
  return !!process.env.VOYAGE_API_KEY;
}

async function embedBatch(texts, inputType, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const res = await f(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: inputType || null, // "document" when indexing, "query" when searching
      output_dimension: EMBED_DIM,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voyage ${res.status}: ${String(body).slice(0, 200)}`);
  }
  const json = await res.json();
  // Sort by index defensively — Voyage returns data in input order, but don't rely on it.
  return (json.data || [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// embed(texts, { inputType?, fetchImpl? }) -> number[][]
async function embed(texts, opts = {}) {
  if (!isConfigured()) throw new Error("VOYAGE_API_KEY not set");
  const arr = Array.isArray(texts) ? texts : [texts];
  if (!arr.length) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += MAX_BATCH) {
    const batch = arr.slice(i, i + MAX_BATCH);
    const vecs = await embedBatch(batch, opts.inputType, opts.fetchImpl);
    out.push(...vecs);
  }
  return out;
}

// pgvector text literal: [0.1,0.2,...] — bind as $n::vector.
function toVectorLiteral(vec) {
  return `[${vec.join(",")}]`;
}

module.exports = { embed, isConfigured, toVectorLiteral, VOYAGE_MODEL, EMBED_DIM };
