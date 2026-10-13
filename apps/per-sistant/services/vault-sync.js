// ============================================================================
// Per-sistant — Obsidian Vault Sync + Embedding Ingest (Phase 1)
// ============================================================================
// The Obsidian vault (a private GitHub repo) is the master corpus. This module
// pulls changed markdown via the GitHub Contents/Trees API (no clone, no
// public webhook — fits Render's ephemeral/sleeping runtime), parses
// frontmatter, chunks, embeds via Voyage, and upserts into documents + chunks.
// Existing notes are embedded too (polymorphic chunks: source_kind='note').
//
// Privacy: frontmatter `embed: false` / `private: true` / `sensitivity:`
// (private|secret) marks a file NON-embeddable AND non-retrievable — it is
// stored as a document row but never chunked/embedded, and excluded from
// retrieval (see routes/rag.js). Only `normal` sensitivity is embedded.
//
// Documents and facts are ingested even without Voyage/pgvector (keyword
// retrieval + facts work without embeddings); embedding is an extra step,
// with a backfill pass for anything ingested while it was unavailable.
//
// Network functions take an injectable { token, fetchImpl } so tests can stub
// GitHub; the pure helpers (parseFrontmatter, chunkMarkdown, …) are exported.
// ============================================================================

const crypto = require("crypto");
const { basename } = require("path");
const embeddings = require("./embeddings");

const GH_API = "https://api.github.com";
const INDEXABLE_RE = /\.(md|markdown|txt)$/i;

// Single in-process lock so the hourly cron, manual "Reindex now", and the
// GitHub-Actions trigger can't run overlapping syncs against the same tables.
// It is CLAIMED synchronously, before the first await (KR-8): checking it and
// only setting it after the config/vector-readiness queries left a window in
// which two callers could both pass the check and run concurrently.
let _syncing = false;
function isSyncing() {
  return _syncing;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------
function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function shouldIndex(path) {
  if (!path || typeof path !== "string") return false;
  if (path.split("/").some((seg) => seg.startsWith("."))) return false; // skip dotfiles/dirs
  return INDEXABLE_RE.test(path);
}

// Minimal YAML-ish frontmatter parser — enough for embed/private/sensitivity/
// title/tags. Not a full YAML implementation by design, but it follows the
// YAML rules Obsidian users actually hit (KR-2): a trailing ` # comment` is
// not part of the value, and a key with an empty value followed by `- item`
// lines is a block list (what Obsidian's Properties UI writes for lists).
function stripYamlComment(val) {
  const q = val[0];
  if (q === '"' || q === "'") {
    // Quoted scalar: the value ends at the closing quote; anything after it
    // (e.g. `"secret" # note`) is dropped. A `#` INSIDE the quotes is kept.
    for (let i = 1; i < val.length; i++) {
      if (val[i] === q && (q === "'" || val[i - 1] !== "\\")) return val.slice(0, i + 1);
    }
    return val;
  }
  if (val[0] === "#") return ""; // `key: # comment` → empty value
  // Plain scalar / flow list: a comment starts at `#` preceded by whitespace
  // (so `https://x.com/a#frag` and `C#` are kept intact).
  return val.replace(/\s+#.*$/, "").trim();
}

function parseFrontmatter(text) {
  const s = String(text || "");
  const m = s.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: s };
  const meta = {};
  let listKey = null; // key whose empty value may be followed by `- item` lines
  for (const line of m[1].split(/\r?\n/)) {
    const item = listKey !== null && line.match(/^\s*-\s+(.*)$/);
    if (item) {
      const v = stripYamlComment(item[1].trim()).replace(/^["']|["']$/g, "");
      if (!Array.isArray(meta[listKey])) meta[listKey] = [];
      if (v) meta[listKey].push(v);
      continue;
    }
    listKey = null;
    const mm = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!mm) continue;
    const key = mm[1].toLowerCase();
    const val = stripYamlComment(mm[2].trim());
    if (val === "") { meta[key] = ""; listKey = key; continue; }
    if (/^(true|false)$/i.test(val)) meta[key] = /^true$/i.test(val);
    else if (/^\[.*\]$/.test(val)) {
      meta[key] = val.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else meta[key] = val.replace(/^["']|["']$/g, "");
  }
  return { meta, body: s.slice(m[0].length) };
}

// resolveSensitivity FAILS CLOSED (KR-2, INV-27). It used to fail OPEN: any
// value it didn't recognize (`private: yes`, `embed: no`, a typo like
// `secrets`, a list, a leftover comment) resolved to "normal", so content the
// user explicitly marked restricted was embedded and sent to Voyage/Claude.
// Now: the MOST restrictive signal wins, YAML-1.1 truthy/falsy words are
// understood, and a present-but-unrecognized sensitivity/embed/private value
// is treated as "private" (never embedded, never retrieved).
const SENSITIVITY_RANK = { normal: 0, private: 1, secret: 2 };
const TRUTHY_RE = /^(true|yes|on|y|1)$/i;
const FALSY_RE = /^(false|no|off|n|0)$/i;

// true | false | null (absent/blank) | "unknown"
function frontmatterFlag(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length ? "unknown" : null;
  const t = String(v).trim().replace(/^["']|["']$/g, "");
  if (TRUTHY_RE.test(t)) return true;
  if (FALSY_RE.test(t)) return false;
  return "unknown";
}

function resolveSensitivity(meta) {
  const m = meta || {};
  let level = "normal";
  const raise = (l) => { if (SENSITIVITY_RANK[l] > SENSITIVITY_RANK[level]) level = l; };
  if (m.sensitivity !== undefined && m.sensitivity !== null && m.sensitivity !== "") {
    const values = Array.isArray(m.sensitivity) ? m.sensitivity : [m.sensitivity];
    for (const raw of values) {
      const v = String(raw).trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (Object.prototype.hasOwnProperty.call(SENSITIVITY_RANK, v)) raise(v);
      else raise("private"); // unrecognized → fail closed
    }
  }
  const embed = frontmatterFlag(m.embed);
  if (embed === false || embed === "unknown") raise("private");
  const priv = frontmatterFlag(m.private);
  if (priv === true || priv === "unknown") raise("private");
  return level;
}

// ---------------------------------------------------------------------------
// Token-aware chunker (RAG v2). Budgets are in ESTIMATED tokens, not chars:
// the old chars/4 assumption under-counted dense content (code blocks, URLs
// tokenize near 3 chars/token) so those chunks overshot the embedding
// window, and it sliced mid-word when a paragraph ran long. Estimation needs
// no tokenizer dep: max(words × 1.32, chars / 4) — the word term tracks
// prose, the char term catches dense text. Splitting cascades heading →
// paragraph → sentence → word, so a chunk never breaks mid-word.
//
// CHUNKING_VERSION is baked into the embed_state content hash (embedSource):
// bumping it invalidates every hash and forces a clean re-embed on the next
// sync — the mechanism that makes future chunker changes safe to ship.
const CHUNKING_VERSION = 2;
const DEFAULT_MAX_TOKENS = 480;   // comfortably inside voyage-3.5's window
const DEFAULT_OVERLAP_TOKENS = 60;

function estimateTokens(text) {
  const t = String(text || "");
  if (!t.trim()) return 0;
  const words = (t.match(/\S+/g) || []).length;
  return Math.max(Math.ceil(words * 1.32), Math.ceil(t.length / 4));
}

function splitSentences(text) {
  return String(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/);
}

// Tail of `text` worth ~overlapTokens, on a word boundary (context carry-over
// between adjacent chunks).
function overlapTail(text, overlapTokens) {
  if (!overlapTokens) return "";
  const words = String(text).split(/\s+/);
  const keep = Math.max(1, Math.floor(overlapTokens / 1.32));
  return words.slice(-keep).join(" ");
}

function chunkMarkdown(text, opts = {}) {
  // Legacy {maxChars, overlap} options map at the old chars/4 assumption so
  // existing callers keep a comparable budget.
  const maxTokens = opts.maxTokens
    || (opts.maxChars ? Math.ceil(opts.maxChars / 4) : DEFAULT_MAX_TOKENS);
  const overlapTokens = opts.overlapTokens !== undefined ? opts.overlapTokens
    : (opts.overlap !== undefined ? Math.ceil(opts.overlap / 4) : DEFAULT_OVERLAP_TOKENS);
  const clean = String(text || "").trim();
  if (!clean) return [];

  const chunks = [];
  let buf = "";
  function flush() {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  }
  // Append a unit (paragraph/sentence/word run) that itself fits the budget.
  function append(unit, sep) {
    if (!buf) { buf = unit; return; }
    if (estimateTokens(buf) + estimateTokens(unit) > maxTokens) {
      const tail = overlapTail(buf, overlapTokens);
      flush();
      buf = tail ? tail + sep + unit : unit;
    } else {
      buf = buf + sep + unit;
    }
  }
  // Break an over-budget unit down a level and append the pieces.
  function appendOversized(unit, level) {
    const parts = level === "sentence" ? splitSentences(unit) : unit.split(/\s+/);
    for (const part of parts) {
      if (!part) continue;
      if (estimateTokens(part) <= maxTokens) {
        append(part, level === "sentence" ? " " : " ");
      } else if (level === "sentence") {
        appendOversized(part, "word"); // run-on sentence → word packing
      } else {
        // single "word" beyond the budget (a megabyte URL?) — hard-split
        flush();
        chunks.push(part.slice(0, maxTokens * 4));
      }
    }
  }

  const sections = clean.split(/\n(?=#{1,6}\s)/); // keep each heading with its body
  for (const section of sections) {
    const sec = section.trim();
    if (!sec) continue;
    flush(); // heading boundaries never share a chunk
    if (estimateTokens(sec) <= maxTokens) { chunks.push(sec); continue; }
    for (const para of sec.split(/\n\s*\n/)) {
      const pt = para.trim();
      if (!pt) continue;
      if (estimateTokens(pt) <= maxTokens) append(pt, "\n\n");
      else appendOversized(pt, "sentence");
    }
    flush();
  }
  flush();
  return chunks.filter(Boolean);
}

function titleFromPath(path) {
  return basename(path).replace(INDEXABLE_RE, "");
}

// --- Capture-to-vault (Phase 3) --------------------------------------------
// Build a markdown file (frontmatter + body) for a captured note/fact, and
// commit it to the vault repo. Writing uses a SEPARATE write-scoped token
// (VAULT_GITHUB_WRITE_TOKEN) so the read-only sync token stays least-privilege.
function slugify(s) {
  return (
    String(s || "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "note"
  );
}

// Quote a YAML scalar only when it contains characters that would break the
// flat frontmatter parser.
function yamlScalar(v) {
  const s = Array.isArray(v) ? v.join(", ") : String(v);
  return /[:#\n"']/.test(s) ? JSON.stringify(s) : s;
}

// KR-10: `fields` come from the model, so a field named `type`, `sensitivity`,
// `embed`, `private`, `valid_to`… would have written a SECOND copy of a
// metadata key (turning a fact file into a note, or downgrading/overriding
// the sensitivity). Reserved keys are dropped from fields; the metadata is
// written only from the trusted arguments. `sensitivity` (normal | private |
// secret) is the user's choice on the capture form.
const CAPTURE_SENSITIVITIES = new Set(["normal", "private", "secret"]);

function buildCaptureMarkdown({ type, title, entity, fields, tags, body, sensitivity }) {
  const fm = [];
  if (type === "fact") {
    fm.push("type: fact");
    if (entity) fm.push(`entity: ${yamlScalar(entity)}`);
    for (const [k, v] of Object.entries(fields || {})) {
      if (v == null || v === "") continue;
      const key = String(k).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
      if (key && !RESERVED_FACT_KEYS.has(key)) fm.push(`${key}: ${yamlScalar(v)}`);
    }
  } else if (title) {
    fm.push(`title: ${yamlScalar(title)}`);
  }
  if (sensitivity && sensitivity !== "normal" && CAPTURE_SENSITIVITIES.has(sensitivity)) {
    fm.push(`sensitivity: ${sensitivity}`);
  }
  if (tags && tags.length) fm.push(`tags: [${tags.map((t) => yamlScalar(t)).join(", ")}]`);
  const front = fm.length ? `---\n${fm.join("\n")}\n---\n\n` : "";
  return front + (body || "");
}

// --- Structured facts (Phase 2c) -------------------------------------------
// A vault file is a "fact file" when its frontmatter has `type: fact`/`facts`.
// Reserved keys control metadata; every other flat key becomes a fact row.
const RESERVED_FACT_KEYS = new Set([
  "type", "entity", "title", "valid_from", "valid_to", "valid",
  "sensitivity", "tags", "embed", "private", "context", "aliases",
]);

function isFactFile(meta) {
  const t = meta && meta.type && String(meta.type).toLowerCase();
  return t === "fact" || t === "facts";
}

function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// extractFacts(meta, sourceRef) -> [{ entity, attribute, value, valid_from,
// valid_to, sensitivity, tags, source_ref }]. One row per non-reserved key.
function extractFacts(meta, sourceRef) {
  const m = meta || {};
  const entity = (m.entity && String(m.entity)) || (sourceRef ? titleFromPath(sourceRef) : "Unknown");
  const sensitivity = resolveSensitivity(m);
  const tags = Array.isArray(m.tags) ? m.tags : m.tags ? [String(m.tags)] : null;
  const valid_from = normalizeDate(m.valid_from);
  const valid_to = normalizeDate(m.valid_to);
  const out = [];
  for (const [k, v] of Object.entries(m)) {
    if (RESERVED_FACT_KEYS.has(k)) continue;
    if (v === "" || v == null) continue;
    const value = Array.isArray(v) ? v.join(", ") : String(v);
    out.push({ entity, attribute: k, value, valid_from, valid_to, sensitivity, tags, source_ref: sourceRef });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
async function vectorReady(pool) {
  try {
    const r = await pool.query("SELECT to_regclass('public.chunks') AS t");
    return !!(r.rows[0] && r.rows[0].t);
  } catch {
    return false;
  }
}

async function getVaultConfig(pool) {
  const r = await pool.query(
    "SELECT vault_enabled, vault_repo, vault_branch, vault_last_sha, vault_last_synced_at, vault_last_error, vault_last_attempt_at FROM user_settings WHERE id = 1"
  );
  return r.rows[0] || {};
}

async function clearSource(pool, kind, id) {
  await pool.query("DELETE FROM chunks WHERE source_kind = $1 AND source_id = $2", [kind, id]);
  await pool.query("DELETE FROM embed_state WHERE source_kind = $1 AND source_id = $2", [kind, id]);
}

// Forget a source's embedding when it can't be (re-)embedded right now — no
// Voyage key or no pgvector (KR-3). Dropping embed_state marks the document
// "unembedded", so the backfill pass re-embeds it once embeddings are
// available, and any chunks of its OLD content stop being retrievable. The
// chunks table may not exist at all without pgvector; embed_state always does.
async function forgetEmbedding(pool, kind, id, vectorTable) {
  if (vectorTable) await pool.query("DELETE FROM chunks WHERE source_kind = $1 AND source_id = $2", [kind, id]);
  await pool.query("DELETE FROM embed_state WHERE source_kind = $1 AND source_id = $2", [kind, id]);
}

// Vault documents that should have an embedding but don't — ingested while
// embeddings were unavailable, or whose embed failed (KR-3/KR-7). Bounded per
// run; the next sync picks up the rest.
const BACKFILL_LIMIT = 200;

// CHUNKING_VERSION salts the hash: a chunker change invalidates every
// stored hash → clean re-embed on next sync, no manual migration.
function embedHash(text) {
  const body = String(text || "");
  return sha256("chunkv" + CHUNKING_VERSION + "\n" + body);
}

// True when the stored embedding was made from exactly this text.
async function embeddingIsCurrent(pool, kind, id, text) {
  const st = await pool.query("SELECT content_sha FROM embed_state WHERE source_kind = $1 AND source_id = $2", [kind, id]);
  return !!(st.rows[0] && st.rows[0].content_sha === embedHash(text));
}

// Chunk + embed a single source, skipping work when the content hash is
// unchanged. Replaces all chunks for the source atomically.
async function embedSource(pool, kind, id, text) {
  const body = String(text || "");
  const sha = embedHash(body);
  const st = await pool.query("SELECT content_sha FROM embed_state WHERE source_kind = $1 AND source_id = $2", [kind, id]);
  if (st.rows[0] && st.rows[0].content_sha === sha) return { skipped: true };

  const parts = chunkMarkdown(body);
  if (!parts.length) {
    // K5: no chunks to embed, but RECORD the content hash so an unchanged empty
    // source isn't re-processed every sync (the early-return above engages next
    // time). Drop any prior chunks, then upsert embed_state with chunk_count 0.
    // (Plain clearSource deleted the embed_state row too, so the hash was never
    // remembered and every sync re-ran this branch.)
    await pool.query("DELETE FROM chunks WHERE source_kind = $1 AND source_id = $2", [kind, id]);
    await pool.query(
      `INSERT INTO embed_state (source_kind, source_id, content_sha, chunk_count, embedded_at)
       VALUES ($1, $2, $3, 0, now())
       ON CONFLICT (source_kind, source_id)
       DO UPDATE SET content_sha = EXCLUDED.content_sha, chunk_count = 0, embedded_at = now()`,
      [kind, id, sha]
    );
    return { chunks: 0 };
  }
  const vectors = await embeddings.embed(parts, { inputType: "document" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM chunks WHERE source_kind = $1 AND source_id = $2", [kind, id]);
    for (let i = 0; i < parts.length; i++) {
      await client.query(
        "INSERT INTO chunks (source_kind, source_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)",
        [kind, id, i, parts[i], embeddings.toVectorLiteral(vectors[i])]
      );
    }
    await client.query(
      `INSERT INTO embed_state (source_kind, source_id, content_sha, chunk_count, embedded_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (source_kind, source_id)
       DO UPDATE SET content_sha = EXCLUDED.content_sha, chunk_count = EXCLUDED.chunk_count, embedded_at = now()`,
      [kind, id, sha, parts.length]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { chunks: parts.length };
}

async function upsertVaultDocument(pool, path, title, content, sensitivity, tags) {
  const r = await pool.query(
    `INSERT INTO documents (source, source_ref, title, content, tags, sensitivity, deleted_at, updated_at)
     VALUES ('vault', $1, $2, $3, $4, $5, NULL, now())
     ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
     DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, tags = EXCLUDED.tags,
       sensitivity = EXCLUDED.sensitivity, deleted_at = NULL, updated_at = now()
     -- KR-5: only rewrite a row whose content actually changed. Every full
     -- reindex used to bump updated_at on EVERY document, which changed the
     -- answer-cache corpus version and wiped the cache twice a day for nothing.
     WHERE (documents.title, documents.content, documents.tags, documents.sensitivity, documents.deleted_at)
           IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.content, EXCLUDED.tags, EXCLUDED.sensitivity, NULL::timestamptz)
     RETURNING id`,
    [path, title, content, tags && tags.length ? tags : null, sensitivity]
  );
  if (r.rows[0]) return r.rows[0].id;
  // Unchanged → the conditional DO UPDATE returned no row; look the id up.
  const existing = await pool.query(
    "SELECT id FROM documents WHERE source = 'vault' AND source_ref = $1",
    [path]
  );
  return existing.rows[0].id;
}

async function removeVaultDocument(pool, path, vectorTable = true) {
  const r = await pool.query(
    "UPDATE documents SET deleted_at = now() WHERE source = 'vault' AND source_ref = $1 AND deleted_at IS NULL RETURNING id",
    [path]
  );
  if (r.rows[0]) await forgetEmbedding(pool, "document", r.rows[0].id, vectorTable);
}

// Order-independent signature of a fact set (KR-5 change detection).
function factSetSignature(rows) {
  const day = (v) => (v == null || v === "" ? null : (v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
    : String(v).slice(0, 10)));
  return JSON.stringify(rows.map((f) => [
    String(f.entity), String(f.attribute), String(f.value), day(f.valid_from), day(f.valid_to),
    String(f.sensitivity || "normal"), (f.tags && f.tags.length ? [...f.tags].map(String).sort() : []),
  ]).map((x) => JSON.stringify(x)).sort());
}

// Replace all facts for a vault file (one file = many fact rows). Skipped when
// the file's fact set is unchanged (KR-5): delete + re-insert on every sync
// bumped the facts' updated_at → a new corpus version → the answer cache was
// flushed even though nothing changed.
async function upsertFacts(pool, sourceRef, facts) {
  try {
    const cur = await pool.query(
      `SELECT entity, attribute, value, valid_from, valid_to, sensitivity, tags
       FROM facts WHERE source = 'vault' AND source_ref = $1 AND deleted_at IS NULL`,
      [sourceRef]
    );
    if (cur.rows.length === facts.length && factSetSignature(cur.rows) === factSetSignature(facts)) {
      return { unchanged: true };
    }
  } catch { /* fall through to the full replace */ }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM facts WHERE source = 'vault' AND source_ref = $1", [sourceRef]);
    for (const f of facts) {
      await client.query(
        `INSERT INTO facts (source, source_ref, entity, attribute, value, valid_from, valid_to, sensitivity, tags)
         VALUES ('vault', $1, $2, $3, $4, $5, $6, $7, $8)`,
        [sourceRef, f.entity, f.attribute, f.value, f.valid_from, f.valid_to, f.sensitivity, f.tags && f.tags.length ? f.tags : null]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function clearFacts(pool, sourceRef) {
  await pool.query("DELETE FROM facts WHERE source = 'vault' AND source_ref = $1", [sourceRef]);
}

// ---------------------------------------------------------------------------
// GitHub client (injectable for tests)
// ---------------------------------------------------------------------------
async function ghJson(pathUrl, ctx) {
  const f = (ctx && ctx.fetchImpl) || globalThis.fetch;
  const res = await f(GH_API + pathUrl, {
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "per-sistant-vault-sync",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} ${pathUrl}: ${String(b).slice(0, 200)}`);
  }
  return res.json();
}

async function getHeadSha(repo, branch, ctx) {
  const j = await ghJson(`/repos/${repo}/branches/${encodeURIComponent(branch)}`, ctx);
  return j.commit.sha;
}

// Full tree listing. `truncated` is GitHub's flag for a tree too large to
// return whole — the caller must then NOT treat "absent from the listing" as
// "deleted from the vault" (KR-1 sweep guard).
async function listIndexableFiles(repo, sha, ctx) {
  const j = await ghJson(`/repos/${repo}/git/trees/${sha}?recursive=1`, ctx);
  // A response without a `tree` array is malformed, not "an empty vault" —
  // report it as truncated so the sweep never deletes the whole index on it.
  if (!Array.isArray(j.tree)) return { paths: [], truncated: true };
  const paths = j.tree.filter((t) => t.type === "blob" && shouldIndex(t.path)).map((t) => t.path);
  return { paths, truncated: !!j.truncated };
}

async function getFileText(repo, path, ref, ctx) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const j = await ghJson(`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, ctx);
  if (j.encoding === "base64") return Buffer.from(j.content || "", "base64").toString("utf8");
  return j.content || "";
}

// GitHub's compare API lists at most 300 files; a diff that hits the cap is
// silently incomplete (changes AND removals beyond it are lost), so the
// caller falls back to a full sync instead (KR-1).
const COMPARE_FILE_CAP = 300;

async function listChangedFiles(repo, base, head, ctx) {
  const j = await ghJson(`/repos/${repo}/compare/${base}...${head}`, ctx);
  if ((j.files || []).length >= COMPARE_FILE_CAP) return { incomplete: true, changed: [], removed: [] };
  const changed = [];
  const removed = [];
  for (const f of j.files || []) {
    if (f.status === "removed") {
      if (shouldIndex(f.filename)) removed.push(f.filename);
    } else {
      if (shouldIndex(f.filename)) changed.push(f.filename);
      if (f.previous_filename && shouldIndex(f.previous_filename)) removed.push(f.previous_filename);
    }
  }
  return { changed, removed };
}

// Create a file in the vault repo (write-scoped token). Unique paths avoid
// the need for a prior-sha update, so this is always a create.
async function commitVaultFile(repo, branch, path, content, message, ctx) {
  const f = (ctx && ctx.fetchImpl) || globalThis.fetch;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await f(`${GH_API}/repos/${repo}/contents/${encoded}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "per-sistant-vault-sync",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(String(content), "utf8").toString("base64"),
      branch,
    }),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status}: ${String(b).slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
// syncVault(pool, { full?, fetchImpl? }) — incremental by default (diff
// last-indexed SHA → HEAD); full re-walks the whole tree. Idempotent.
//
// Documents and facts are ingested even without embeddings (KR-3): facts need
// none, and documents are keyword-retrievable — embedding is an extra step
// that runs only when VOYAGE_API_KEY is set AND pgvector is present, and a
// backfill pass embeds anything ingested while it wasn't.
//
// Failure handling (KR-7): removals run first, then each file is processed in
// its own try/catch, so one bad file or a Voyage error no longer aborts the
// whole sync. When any file failed, vault_last_sha is NOT advanced (the next
// sync retries the same range; unchanged files are cheap thanks to the
// content-hash / unchanged-row skips) and the run reports ok:false.
// vault_last_synced_at is stamped only on success; vault_last_attempt_at on
// every run (KR-11).
async function syncVault(pool, opts = {}) {
  if (_syncing) return { ok: false, reason: "busy" };
  _syncing = true; // KR-8: claimed before the first await
  try {
    return await runVaultSync(pool, opts);
  } finally {
    _syncing = false;
  }
}

async function runVaultSync(pool, opts) {
  const cfg = await getVaultConfig(pool);
  const token = process.env.VAULT_GITHUB_TOKEN;
  if (!cfg.vault_enabled || !cfg.vault_repo || !token) return { ok: false, reason: "not_configured" };
  const vectorTable = await vectorReady(pool);
  const canEmbed = embeddings.isConfigured() && vectorTable;

  const ctx = { token, fetchImpl: opts.fetchImpl };
  const repo = cfg.vault_repo;
  const branch = cfg.vault_branch || "main";
  await pool.query("UPDATE user_settings SET vault_last_attempt_at = now() WHERE id = 1").catch(() => {});
  try {
    const head = await getHeadSha(repo, branch, ctx);
    let full = !!opts.full || !cfg.vault_last_sha;
    let changed = [];
    let removed = [];
    if (!full && cfg.vault_last_sha === head) {
      const backfill = canEmbed ? await backfillEmbeddings(pool) : { embedded: 0, failed: [] };
      if (backfill.failed.length) return await finishWithFailures(pool, backfill.failed, { up_to_date: true, head, embeddings: canEmbed });
      await pool.query("UPDATE user_settings SET vault_last_synced_at = now(), vault_last_error = NULL WHERE id = 1");
      return { ok: true, up_to_date: true, changed: 0, removed: 0, embedded: backfill.embedded, skipped: 0, head, embeddings: canEmbed };
    }
    if (!full) {
      // An incremental diff can't be trusted when the base commit is gone
      // (force-push/history rewrite → compare 404/422) or GitHub capped the
      // file list — fall back to a full walk + sweep rather than silently
      // skipping those changes and deletions forever (KR-1).
      let cmp = null;
      try {
        cmp = await listChangedFiles(repo, cfg.vault_last_sha, head, ctx);
      } catch (e) {
        if (!/^GitHub (404|422) /.test(String(e.message))) throw e;
      }
      if (!cmp || cmp.incomplete) full = true;
      else { changed = cmp.changed; removed = cmp.removed; }
    }
    if (full) {
      const tree = await listIndexableFiles(repo, head, ctx);
      changed = tree.paths;
      // Mark-and-sweep (KR-1): a full walk only sees files that EXIST, so a
      // vault file deleted/renamed since the last sync (or everything from a
      // previously configured repo) was never removed — its facts kept being
      // injected as "Known facts" and its chunks kept being sent to Claude,
      // while vault_last_sha advanced past the deletion. Anything we have
      // indexed that the tree no longer contains is removed via the normal
      // removal path. Skipped when GitHub truncated the tree (absence would
      // not mean deletion).
      if (!tree.truncated) {
        const present = new Set(tree.paths);
        const indexed = await pool.query(
          `SELECT source_ref FROM documents WHERE source = 'vault' AND deleted_at IS NULL AND source_ref IS NOT NULL
           UNION
           SELECT source_ref FROM facts WHERE source = 'vault' AND source_ref IS NOT NULL`
        );
        removed = indexed.rows.map((r) => r.source_ref).filter((ref) => !present.has(ref));
      }
    }

    // Removals FIRST (KR-7): they used to run after the file loop, so while any
    // file kept failing, deleted notes and facts were never removed.
    const failed = [];
    const removedSet = new Set(removed);
    for (const path of removed) {
      try {
        await removeVaultDocument(pool, path, vectorTable);
        await clearFacts(pool, path);
      } catch (e) {
        failed.push({ path, error: e.message });
      }
    }

    let embedded = 0;
    let skipped = 0;
    let factFiles = 0;
    for (const path of changed) {
      if (removedSet.has(path)) continue;
      try {
        const r = await ingestFile(pool, repo, path, head, ctx, { canEmbed, vectorTable });
        if (r.fact) factFiles++;
        if (r.embedded) embedded++;
        if (r.skipped) skipped++;
      } catch (e) {
        failed.push({ path, error: e.message });
      }
    }
    if (canEmbed) {
      const backfill = await backfillEmbeddings(pool);
      embedded += backfill.embedded;
      failed.push(...backfill.failed);
    }

    const summary = { changed: changed.length, removed: removed.length, embedded, skipped, facts: factFiles, head, embeddings: canEmbed };
    if (failed.length) return await finishWithFailures(pool, failed, summary);
    await pool.query(
      "UPDATE user_settings SET vault_last_sha = $1, vault_last_synced_at = now(), vault_last_error = NULL WHERE id = 1",
      [head]
    );
    return { ok: true, ...summary };
  } catch (e) {
    // KR-11: a failed run records the error but NOT vault_last_synced_at (it
    // used to stamp it, so a sync failing for days still looked fresh).
    await pool
      .query("UPDATE user_settings SET vault_last_error = $1 WHERE id = 1", [String(e.message).slice(0, 500)])
      .catch(() => {});
    return { ok: false, error: e.message };
  }
}

// One vault file → documents/facts (+ chunks when embeddings are available).
async function ingestFile(pool, repo, path, head, ctx, { canEmbed, vectorTable }) {
  const text = await getFileText(repo, path, head, ctx);
  const { meta, body } = parseFrontmatter(text);

  // Fact file: structured records only. Replace its facts and drop any
  // prior prose document/chunks for the same path.
  if (isFactFile(meta)) {
    await upsertFacts(pool, path, extractFacts(meta, path));
    await removeVaultDocument(pool, path, vectorTable);
    return { fact: true };
  }

  const sensitivity = resolveSensitivity(meta);
  const title = (meta.title && String(meta.title)) || titleFromPath(path);
  const tags = Array.isArray(meta.tags) ? meta.tags : meta.tags ? [String(meta.tags)] : null;
  // K1: this path is NOT a fact file. If it WAS one previously (the user
  // dropped `type: fact`), its extracted fact rows would otherwise linger
  // and keep being injected into answers as authoritative "Known facts" —
  // the fact→prose transition was unhandled (only repo-removal cleared
  // facts). Clear them here so the conversion is symmetric with prose→fact
  // (which calls removeVaultDocument). No-op when the file was never a fact file.
  await clearFacts(pool, path);
  const docId = await upsertVaultDocument(pool, path, title, body, sensitivity, tags);
  if (sensitivity !== "normal") {
    // private/secret: kept as a document row but never embedded/retrievable.
    await forgetEmbedding(pool, "document", docId, vectorTable);
    return {};
  }
  if (!canEmbed) {
    // Keyword-retrievable now; the backfill embeds it once embeddings work.
    // An embedding of exactly this text (from when Voyage was configured) is
    // kept — only a stale one is dropped, so a temporarily missing key doesn't
    // wipe the index and force a full paid re-embed.
    if (!(await embeddingIsCurrent(pool, "document", docId, body))) {
      await forgetEmbedding(pool, "document", docId, vectorTable);
    }
    return {};
  }
  const r = await embedSource(pool, "document", docId, body);
  return r.skipped ? { skipped: true } : { embedded: true };
}

async function backfillEmbeddings(pool) {
  const out = { embedded: 0, failed: [] };
  let rows = [];
  try {
    rows = (await pool.query(
      `SELECT d.id, d.source_ref, d.content FROM documents d
       WHERE d.source = 'vault' AND d.deleted_at IS NULL AND d.sensitivity = 'normal'
         AND NOT EXISTS (SELECT 1 FROM embed_state e WHERE e.source_kind = 'document' AND e.source_id = d.id)
       ORDER BY d.id
       LIMIT $1`,
      [BACKFILL_LIMIT]
    )).rows;
  } catch (e) {
    out.failed.push({ path: "(backfill)", error: e.message });
    return out;
  }
  for (const d of rows) {
    try {
      const r = await embedSource(pool, "document", d.id, d.content);
      if (!r.skipped) out.embedded++;
    } catch (e) {
      out.failed.push({ path: d.source_ref || `document ${d.id}`, error: e.message });
    }
  }
  return out;
}

async function finishWithFailures(pool, failed, summary) {
  const first = failed[0];
  const msg = `${failed.length} file(s) failed to sync; first: ${first.path}: ${first.error}`;
  await pool.query("UPDATE user_settings SET vault_last_error = $1 WHERE id = 1", [msg.slice(0, 500)]).catch(() => {});
  return { ok: false, partial: true, failed: failed.length, failures: failed.slice(0, 20), error: msg, ...summary };
}

// Embed existing notes into the same polymorphic chunk store, and prune chunks
// for notes that were deleted. Cheap on re-run thanks to the content-hash skip.
async function syncNotes(pool) {
  // K4: hold the same single-flight lock syncVault uses so the hourly cron and a
  // concurrent POST /api/rag/reindex can't run overlapping note-embeds. The cron
  // only checks isSyncing() once (before syncVault), leaving a window during its
  // syncNotes phase where a reindex could slip in; self-locking here closes it.
  // Writes are idempotent regardless, so a busy no-op is safely retried next tick.
  // Claimed before the first await (KR-8).
  if (_syncing) return { ok: false, reason: "busy" };
  _syncing = true;
  try {
    if (!embeddings.isConfigured() || !(await vectorReady(pool))) return { ok: false, reason: "not_ready" };
    let embedded = 0;
    let skipped = 0;
    const notes = await pool.query("SELECT id, title, content FROM notes WHERE deleted_at IS NULL");
    let failed = 0;
    let firstError = null;
    for (const n of notes.rows) {
      const text = (n.title ? n.title + "\n\n" : "") + (n.content || "");
      // KR-7: one note failing to embed (e.g. a Voyage error after retries)
      // no longer aborts the rest; it is retried next run (no embed_state row).
      try {
        const r = await embedSource(pool, "note", n.id, text);
        if (r.skipped) skipped++;
        else embedded++;
      } catch (e) {
        failed++;
        if (!firstError) firstError = e.message;
      }
    }
    await pool.query("DELETE FROM chunks WHERE source_kind = 'note' AND source_id NOT IN (SELECT id FROM notes WHERE deleted_at IS NULL)");
    await pool.query("DELETE FROM embed_state WHERE source_kind = 'note' AND source_id NOT IN (SELECT id FROM notes WHERE deleted_at IS NULL)");
    if (failed) return { ok: false, partial: true, failed, error: firstError, embedded, skipped, total: notes.rows.length };
    return { ok: true, embedded, skipped, total: notes.rows.length };
  } finally {
    _syncing = false;
  }
}

// Full reconcile — re-walk the entire vault + all notes (content-hash skip
// keeps it cheap when nothing changed).
async function reindexAll(pool, opts = {}) {
  const vault = await syncVault(pool, { full: true, fetchImpl: opts.fetchImpl });
  const notes = await syncNotes(pool);
  return { vault, notes };
}

module.exports = {
  syncVault,
  syncNotes,
  reindexAll,
  vectorReady,
  getVaultConfig,
  isSyncing,
  // pure helpers (tests)
  parseFrontmatter,
  resolveSensitivity,
  chunkMarkdown,
  estimateTokens,
  CHUNKING_VERSION,
  shouldIndex,
  sha256,
  titleFromPath,
  isFactFile,
  extractFacts,
  normalizeDate,
  slugify,
  buildCaptureMarkdown,
  commitVaultFile,
  upsertVaultDocument,
  upsertFacts,
  factSetSignature,
  backfillEmbeddings,
};
