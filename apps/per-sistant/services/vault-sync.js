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
// title/tags. Not a full YAML implementation by design.
function parseFrontmatter(text) {
  const s = String(text || "");
  const m = s.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: s };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!mm) continue;
    const key = mm[1].toLowerCase();
    let val = mm[2].trim();
    if (val === "") { meta[key] = ""; continue; }
    if (/^(true|false)$/i.test(val)) meta[key] = /^true$/i.test(val);
    else if (/^\[.*\]$/.test(val)) {
      meta[key] = val.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else meta[key] = val.replace(/^["']|["']$/g, "");
  }
  return { meta, body: s.slice(m[0].length) };
}

function resolveSensitivity(meta) {
  const m = meta || {};
  const explicit = m.sensitivity && String(m.sensitivity).toLowerCase();
  if (explicit && ["normal", "private", "secret"].includes(explicit)) return explicit;
  if (m.embed === false || m.private === true) return "private";
  return "normal";
}

// Heading-aware chunker (~512 tokens ≈ ~2000 chars) with overlap.
function chunkMarkdown(text, opts = {}) {
  const maxChars = opts.maxChars || 2000;
  const overlap = opts.overlap || 200;
  const clean = String(text || "").trim();
  if (!clean) return [];
  const sections = clean.split(/\n(?=#{1,6}\s)/); // keep each heading with its body
  const chunks = [];
  for (const section of sections) {
    const sec = section.trim();
    if (!sec) continue;
    if (sec.length <= maxChars) { chunks.push(sec); continue; }
    let buf = "";
    for (const para of sec.split(/\n\s*\n/)) {
      if (buf && buf.length + para.length + 2 > maxChars) {
        chunks.push(buf.trim());
        buf = overlap > 0 ? buf.slice(-overlap) + "\n\n" + para : para;
      } else {
        buf = buf ? buf + "\n\n" + para : para;
      }
      while (buf.length > maxChars) {
        chunks.push(buf.slice(0, maxChars).trim());
        buf = buf.slice(maxChars - overlap);
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  return chunks.filter(Boolean);
}

function titleFromPath(path) {
  return basename(path).replace(INDEXABLE_RE, "");
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
    "SELECT vault_enabled, vault_repo, vault_branch, vault_last_sha, vault_last_synced_at, vault_last_error FROM user_settings WHERE id = 1"
  );
  return r.rows[0] || {};
}

async function clearSource(pool, kind, id) {
  await pool.query("DELETE FROM chunks WHERE source_kind = $1 AND source_id = $2", [kind, id]);
  await pool.query("DELETE FROM embed_state WHERE source_kind = $1 AND source_id = $2", [kind, id]);
}

// Chunk + embed a single source, skipping work when the content hash is
// unchanged. Replaces all chunks for the source atomically.
async function embedSource(pool, kind, id, text) {
  const body = String(text || "");
  const sha = sha256(body);
  const st = await pool.query("SELECT content_sha FROM embed_state WHERE source_kind = $1 AND source_id = $2", [kind, id]);
  if (st.rows[0] && st.rows[0].content_sha === sha) return { skipped: true };

  const parts = chunkMarkdown(body);
  if (!parts.length) {
    await clearSource(pool, kind, id);
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
     RETURNING id`,
    [path, title, content, tags && tags.length ? tags : null, sensitivity]
  );
  return r.rows[0].id;
}

async function removeVaultDocument(pool, path) {
  const r = await pool.query(
    "UPDATE documents SET deleted_at = now() WHERE source = 'vault' AND source_ref = $1 AND deleted_at IS NULL RETURNING id",
    [path]
  );
  if (r.rows[0]) await clearSource(pool, "document", r.rows[0].id);
}

// Replace all facts for a vault file (one file = many fact rows).
async function upsertFacts(pool, sourceRef, facts) {
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

async function listIndexableFiles(repo, sha, ctx) {
  const j = await ghJson(`/repos/${repo}/git/trees/${sha}?recursive=1`, ctx);
  return (j.tree || []).filter((t) => t.type === "blob" && shouldIndex(t.path)).map((t) => t.path);
}

async function getFileText(repo, path, ref, ctx) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const j = await ghJson(`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, ctx);
  if (j.encoding === "base64") return Buffer.from(j.content || "", "base64").toString("utf8");
  return j.content || "";
}

async function listChangedFiles(repo, base, head, ctx) {
  const j = await ghJson(`/repos/${repo}/compare/${base}...${head}`, ctx);
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

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
// syncVault(pool, { full?, fetchImpl? }) — incremental by default (diff
// last-indexed SHA → HEAD); full re-walks the whole tree. Idempotent.
async function syncVault(pool, opts = {}) {
  if (_syncing) return { ok: false, reason: "busy" };
  const cfg = await getVaultConfig(pool);
  const token = process.env.VAULT_GITHUB_TOKEN;
  if (!cfg.vault_enabled || !cfg.vault_repo || !token) return { ok: false, reason: "not_configured" };
  if (!embeddings.isConfigured()) return { ok: false, reason: "embeddings_not_configured" };
  if (!(await vectorReady(pool))) return { ok: false, reason: "vector_unavailable" };

  const ctx = { token, fetchImpl: opts.fetchImpl };
  const repo = cfg.vault_repo;
  const branch = cfg.vault_branch || "main";
  _syncing = true;
  try {
    const head = await getHeadSha(repo, branch, ctx);
    const full = !!opts.full || !cfg.vault_last_sha;
    let changed = [];
    let removed = [];
    if (full) {
      changed = await listIndexableFiles(repo, head, ctx);
    } else if (cfg.vault_last_sha === head) {
      await pool.query("UPDATE user_settings SET vault_last_synced_at = now(), vault_last_error = NULL WHERE id = 1");
      return { ok: true, up_to_date: true, changed: 0, removed: 0, embedded: 0, skipped: 0, head };
    } else {
      const cmp = await listChangedFiles(repo, cfg.vault_last_sha, head, ctx);
      changed = cmp.changed;
      removed = cmp.removed;
    }

    let embedded = 0;
    let skipped = 0;
    let factFiles = 0;
    for (const path of changed) {
      const text = await getFileText(repo, path, head, ctx);
      const { meta, body } = parseFrontmatter(text);

      // Fact file: structured records only. Replace its facts and drop any
      // prior prose document/chunks for the same path.
      if (isFactFile(meta)) {
        await upsertFacts(pool, path, extractFacts(meta, path));
        await removeVaultDocument(pool, path);
        factFiles++;
        continue;
      }

      const sensitivity = resolveSensitivity(meta);
      const title = (meta.title && String(meta.title)) || titleFromPath(path);
      const tags = Array.isArray(meta.tags) ? meta.tags : meta.tags ? [String(meta.tags)] : null;
      const docId = await upsertVaultDocument(pool, path, title, body, sensitivity, tags);
      if (sensitivity === "normal") {
        const r = await embedSource(pool, "document", docId, body);
        if (r.skipped) skipped++;
        else embedded++;
      } else {
        // private/secret: kept as a document row but never embedded/retrievable.
        await clearSource(pool, "document", docId);
      }
    }
    for (const path of removed) {
      await removeVaultDocument(pool, path);
      await clearFacts(pool, path);
    }

    await pool.query(
      "UPDATE user_settings SET vault_last_sha = $1, vault_last_synced_at = now(), vault_last_error = NULL WHERE id = 1",
      [head]
    );
    return { ok: true, changed: changed.length, removed: removed.length, embedded, skipped, facts: factFiles, head };
  } catch (e) {
    await pool
      .query("UPDATE user_settings SET vault_last_error = $1, vault_last_synced_at = now() WHERE id = 1", [
        String(e.message).slice(0, 500),
      ])
      .catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    _syncing = false;
  }
}

// Embed existing notes into the same polymorphic chunk store, and prune chunks
// for notes that were deleted. Cheap on re-run thanks to the content-hash skip.
async function syncNotes(pool) {
  if (!embeddings.isConfigured() || !(await vectorReady(pool))) return { ok: false, reason: "not_ready" };
  let embedded = 0;
  let skipped = 0;
  const notes = await pool.query("SELECT id, title, content FROM notes WHERE deleted_at IS NULL");
  for (const n of notes.rows) {
    const text = (n.title ? n.title + "\n\n" : "") + (n.content || "");
    const r = await embedSource(pool, "note", n.id, text);
    if (r.skipped) skipped++;
    else embedded++;
  }
  await pool.query("DELETE FROM chunks WHERE source_kind = 'note' AND source_id NOT IN (SELECT id FROM notes WHERE deleted_at IS NULL)");
  await pool.query("DELETE FROM embed_state WHERE source_kind = 'note' AND source_id NOT IN (SELECT id FROM notes WHERE deleted_at IS NULL)");
  return { ok: true, embedded, skipped, total: notes.rows.length };
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
  shouldIndex,
  sha256,
  titleFromPath,
  isFactFile,
  extractFacts,
  normalizeDate,
};
