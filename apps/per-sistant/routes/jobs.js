// ============================================================================
// Per-sistant — Job Radar Routes (db/021_jobs.sql)
// ============================================================================
// Pulls job listings from sanctioned APIs (Adzuna aggregator + direct ATS
// boards over the curated job_target_companies allowlist), dedups on a content
// hash, runs a TRUST pass (source weight + ghost-job freshness decay +
// cross-source corroboration + apply-domain check + regex scam heuristics; the
// embedding near-dup collapse + Claude fit/legitimacy passes land in Batch 2),
// and surfaces high-fit/high-trust roles via gatherJobRadarSummary.
//
// Batch 1 = ingest → dedup → trust → aggregate → schedule (no AI / embeddings).
// fit_score / embedding / legitimacy_reasons columns exist but stay NULL until
// the Batch 2 fit pass populates them. The pure helpers (content hash, scam,
// domain, trust, near-dup, normalize*) are attached AFTER the factory (INV-19)
// so the router assignment doesn't drop them.

const express = require("express");
const crypto = require("crypto");
const { serverError } = require("../errors");

// ---- Thresholds (tunable; surfaced as constants so they're easy to find) ----
const TRUST_MAIN = 60;     // main list floor
const FIT_MAIN = 65;       // main list fit floor (Batch 2; NULL fit doesn't block in Batch 1)
const TRUST_VERIFY = 40;   // "verify first" bucket floor (below this, hidden unless saved)
const NEARDUP_THRESHOLD = 0.92;
const MAX_TEXT = 20000;    // description cap stored

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests; attached after the factory — INV-19)
// ---------------------------------------------------------------------------

// Stable dedup key: a re-fetch of the same posting hashes identically.
function computeContentHash(listing) {
  const parts = [listing.company, listing.title, listing.location, listing.apply_url]
    .map((x) => String(x == null ? "" : x).trim().toLowerCase());
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Word-boundary scam heuristics (INV-10 — never substring LIKE). Returns a list
// of flag strings; the trust pass penalizes per hit and clamps legitimacy.
const SCAM_PATTERNS = [
  { flag: "personal_email", re: /\b[\w.+-]+@(?:gmail|yahoo|hotmail|outlook|proton|protonmail|aol|icloud)\.com\b/i },
  { flag: "upfront_payment", re: /\b(?:processing fee|registration fee|application fee|pay(?:ment)? (?:a )?fee|send (?:money|payment|funds)|wire transfer|gift cards?|bitcoin|crypto payment)\b/i },
  { flag: "sensitive_data", re: /\b(?:social security number|ssn|bank account (?:details|number|info)|routing number)\b/i },
  { flag: "offplatform_contact", re: /\b(?:telegram|whatsapp|signal app|text me at)\b/i },
];
const COMP_ABOVE_MARKET = 600000; // coarse static ceiling; Batch 2 could use percentiles
function scamHeuristics(listing) {
  const text = `${listing.title || ""} ${listing.description || ""}`;
  const hits = [];
  for (const p of SCAM_PATTERNS) if (p.re.test(text)) hits.push(p.flag);
  if (Number(listing.salary_max) > COMP_ABOVE_MARKET) hits.push("comp_above_market");
  return hits;
}

// Apply-domain trust: ATS/company domains good, link-shorteners bad, else neutral.
const GOOD_DOMAINS = ["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "myworkdayjobs.com", "smartrecruiters.com", "jobvite.com"];
const BAD_DOMAINS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "rb.gy", "is.gd", "cutt.ly"];
function applyDomainScore(domain) {
  if (!domain) return -10;
  const d = String(domain).toLowerCase();
  if (GOOD_DOMAINS.some((g) => d === g || d.endsWith("." + g))) return 10;
  if (BAD_DOMAINS.some((b) => d === b)) return -20;
  return 0;
}

// Trust score 0-100 + a coarse legitimacy bucket. Never trusts the source's
// claimed posted_at — ghost-job decay keys off our own first_seen age.
function computeTrustScore({ sourceWeight = 50, firstSeenDaysAgo = 0, corroborationCount = 0, domainScore = 0, scamHits = [] } = {}) {
  let score = Number(sourceWeight) || 0;
  score -= Math.min(30, Math.max(0, firstSeenDaysAgo) * 0.5); // freshness/ghost decay
  score += Math.min(15, Math.max(0, corroborationCount) * 15); // cross-source corroboration
  score += domainScore;                                        // -20..+10
  score -= (scamHits ? scamHits.length : 0) * 25;
  score = Math.max(0, Math.min(100, Math.round(score)));
  let legitimacy;
  if ((scamHits && scamHits.length >= 2) || score < 20) legitimacy = "scam";
  else if ((scamHits && scamHits.length >= 1) || score < 45) legitimacy = "suspect";
  else legitimacy = "real";
  return { trust_score: score, legitimacy };
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Near-dup collapse via embeddings (post-embed, D5). Pure: keeps the most
// authoritative copy of each cluster (higher `authority` = ATS/company over
// aggregator), returns the dropped ids mapped to their canonical. No-op when
// no embeddings are present (Batch 1 — the fit pass populates them in Batch 2).
function collapseNearDups(listings, threshold = NEARDUP_THRESHOLD) {
  const withEmb = (listings || []).filter((l) => Array.isArray(l.embedding) && l.embedding.length);
  const ordered = withEmb.slice().sort((a, b) => (b.authority || 0) - (a.authority || 0));
  const kept = [];
  const dropped = [];
  for (const l of ordered) {
    const canon = kept.find((k) => cosineSim(l.embedding, k.embedding) >= threshold);
    if (canon) dropped.push({ id: l.id, canonical_id: canon.id });
    else kept.push(l);
  }
  return { kept: kept.map((k) => k.id), dropped };
}

// ---- Normalizers: provider raw → common shape -----------------------------
// Common shape: { source_key, source_job_id, title, company, location, remote,
//   salary_min, salary_max, apply_url, description, posted_at }
const REMOTE_RE = /\bremote\b/i;
function looksRemote(...vals) {
  return vals.some((v) => v && REMOTE_RE.test(String(v)));
}
function clip(s) {
  return s == null ? null : String(s).slice(0, MAX_TEXT);
}

function normalizeAdzuna(raw) {
  return {
    source_key: "adzuna",
    source_job_id: raw.id != null ? String(raw.id) : null,
    title: raw.title || null,
    company: raw.company && raw.company.display_name ? raw.company.display_name : null,
    location: raw.location && raw.location.display_name ? raw.location.display_name : null,
    remote: looksRemote(raw.title, raw.location && raw.location.display_name),
    salary_min: raw.salary_min != null ? Number(raw.salary_min) : null,
    salary_max: raw.salary_max != null ? Number(raw.salary_max) : null,
    apply_url: raw.redirect_url || null,
    description: clip(raw.description),
    posted_at: raw.created || null,
  };
}

function normalizeGreenhouse(raw, company) {
  const loc = raw.location && raw.location.name ? raw.location.name : null;
  return {
    source_key: "greenhouse",
    source_job_id: raw.id != null ? String(raw.id) : null,
    title: raw.title || null,
    company: (raw.company_name || company) || null,
    location: loc,
    remote: looksRemote(raw.title, loc),
    salary_min: null,
    salary_max: null,
    apply_url: raw.absolute_url || null,
    description: clip(raw.content),
    posted_at: raw.updated_at || raw.first_published || null,
  };
}

function normalizeLever(raw, company) {
  const loc = raw.categories && raw.categories.location ? raw.categories.location : null;
  return {
    source_key: "lever",
    source_job_id: raw.id != null ? String(raw.id) : null,
    title: raw.text || null,
    company: company || null,
    location: loc,
    remote: looksRemote(raw.text, loc, raw.workplaceType),
    salary_min: null,
    salary_max: null,
    apply_url: raw.hostedUrl || raw.applyUrl || null,
    description: clip(raw.descriptionPlain || raw.description),
    posted_at: raw.createdAt ? new Date(Number(raw.createdAt)).toISOString() : null,
  };
}

function normalizeAshby(raw, company) {
  const comp = raw.compensation && raw.compensation.compensationTierSummary;
  return {
    source_key: "ashby",
    source_job_id: raw.id != null ? String(raw.id) : null,
    title: raw.title || null,
    company: company || null,
    location: raw.location || null,
    remote: raw.isRemote === true || looksRemote(raw.title, raw.location),
    salary_min: null,
    salary_max: null,
    apply_url: raw.jobUrl || raw.applyUrl || null,
    description: clip(raw.descriptionPlain || raw.descriptionHtml),
    posted_at: raw.publishedDate || raw.updatedAt || null,
    _comp_note: comp || null,
  };
}

function normalizeWorkable(raw, company) {
  const loc = raw.location
    ? [raw.location.city, raw.location.region, raw.location.country].filter(Boolean).join(", ") || null
    : null;
  return {
    source_key: "workable",
    source_job_id: raw.shortcode || (raw.id != null ? String(raw.id) : null),
    title: raw.title || null,
    company: company || null,
    location: loc,
    remote: raw.remote === true || looksRemote(raw.title, loc),
    salary_min: null,
    salary_max: null,
    apply_url: raw.application_url || raw.url || null,
    description: clip(raw.description),
    posted_at: raw.published_on || raw.created_at || null,
  };
}

// ---------------------------------------------------------------------------
// Ingest (fail-soft per source) — A3
// ---------------------------------------------------------------------------
async function httpJson(url, opts = {}) {
  const f = opts.fetchImpl || globalThis.fetch;
  const res = await f(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchAdzuna(opts = {}) {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return [];
  const queries = opts.adzunaQueries || [{ what: "software engineer", where: "" }];
  const country = opts.adzunaCountry || "us";
  const out = [];
  for (const q of queries) {
    const u = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
    u.searchParams.set("app_id", id);
    u.searchParams.set("app_key", key);
    u.searchParams.set("results_per_page", "25");
    if (q.what) u.searchParams.set("what", q.what);
    if (q.where) u.searchParams.set("where", q.where);
    const json = await httpJson(u.toString(), opts);
    for (const r of json.results || []) out.push(normalizeAdzuna(r));
  }
  return out;
}

async function fetchAts(ats, slug, opts = {}) {
  if (ats === "greenhouse") {
    const json = await httpJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`, opts);
    return (json.jobs || []).map((j) => normalizeGreenhouse(j, slug));
  }
  if (ats === "lever") {
    const json = await httpJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`, opts);
    return (Array.isArray(json) ? json : []).map((j) => normalizeLever(j, slug));
  }
  if (ats === "ashby") {
    const json = await httpJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`, opts);
    return (json.jobs || []).map((j) => normalizeAshby(j, slug));
  }
  if (ats === "workable") {
    const json = await httpJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`, opts);
    return (json.jobs || []).map((j) => normalizeWorkable(j, slug));
  }
  return [];
}

async function runIngest(pool, opts = {}) {
  const out = [];
  const enabled = new Set((await pool.query("SELECT key FROM job_sources WHERE enabled = true")).rows.map((r) => r.key));
  if (enabled.has("adzuna")) {
    try { out.push(...await fetchAdzuna(opts)); }
    catch (e) { console.error("job-radar adzuna ingest:", e.message); }
  }
  if (["greenhouse", "lever", "ashby", "workable"].some((k) => enabled.has(k))) {
    const companies = (await pool.query("SELECT slug, ats FROM job_target_companies WHERE active = true")).rows;
    for (const c of companies) {
      if (!enabled.has(c.ats)) continue;
      try { out.push(...await fetchAts(c.ats, c.slug, opts)); }
      catch (e) { console.error(`job-radar ats ${c.ats}/${c.slug}:`, e.message); }
    }
  }
  return out.filter((n) => n && n.apply_url && (n.title || n.company));
}

// ---------------------------------------------------------------------------
// Dedup / persist — A4. Upsert on content_hash; bump last_seen; the
// `(xmax = 0)` flag (Perfin INV-01) makes "added" count only genuine inserts,
// so a re-run with no new postings adds 0 (idempotent).
// ---------------------------------------------------------------------------
async function dedupPersist(pool, normalized) {
  const newIds = [];
  let seen = 0;
  const srcCache = new Map();
  const sourceId = async (key) => {
    if (srcCache.has(key)) return srcCache.get(key);
    const r = await pool.query("SELECT id FROM job_sources WHERE key = $1", [key]);
    const id = r.rows.length ? r.rows[0].id : null;
    srcCache.set(key, id);
    return id;
  };
  for (const n of normalized) {
    const hash = computeContentHash(n);
    const domain = hostnameOf(n.apply_url);
    const src = await sourceId(n.source_key);
    const r = await pool.query(
      `INSERT INTO job_listings
         (source_id, source_job_id, content_hash, title, company, location, remote,
          salary_min, salary_max, apply_url, apply_domain, description, posted_at, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
       ON CONFLICT (content_hash) DO UPDATE SET last_seen = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [src, n.source_job_id, hash, n.title, n.company, n.location, n.remote,
       n.salary_min, n.salary_max, n.apply_url, domain, n.description, n.posted_at]
    );
    seen++;
    if (r.rows[0].inserted) newIds.push(r.rows[0].id);
  }
  return { newIds, seen };
}

// ---------------------------------------------------------------------------
// Trust pass — A5. Computes corroboration (distinct source KINDS for the same
// company+title) + the trust score, writes trust_score/legitimacy.
// ---------------------------------------------------------------------------
async function runTrustPass(pool, ids) {
  if (!ids || !ids.length) return { scored: 0 };
  const rows = (await pool.query(
    `SELECT jl.id, jl.title, jl.company, jl.description, jl.apply_domain, jl.salary_max, jl.first_seen,
            COALESCE(js.trust_weight, 50) AS trust_weight
     FROM job_listings jl LEFT JOIN job_sources js ON js.id = jl.source_id
     WHERE jl.id = ANY($1)`, [ids])).rows;
  for (const row of rows) {
    const corr = await pool.query(
      `SELECT COUNT(DISTINCT js.kind)::int AS kinds
       FROM job_listings jl JOIN job_sources js ON js.id = jl.source_id
       WHERE LOWER(COALESCE(jl.company,'')) = LOWER(COALESCE($1,''))
         AND LOWER(COALESCE(jl.title,'')) = LOWER(COALESCE($2,''))`,
      [row.company, row.title]);
    const corroborationCount = Math.max(0, (corr.rows[0].kinds || 1) - 1);
    const scamHits = scamHeuristics(row);
    const domainScore = applyDomainScore(row.apply_domain);
    const firstSeenDaysAgo = (Date.now() - new Date(row.first_seen).getTime()) / 86400000;
    const { trust_score, legitimacy } = computeTrustScore({
      sourceWeight: row.trust_weight, firstSeenDaysAgo, corroborationCount, domainScore, scamHits,
    });
    await pool.query(
      "UPDATE job_listings SET trust_score = $1, legitimacy = $2, corroboration_count = $3 WHERE id = $4",
      [trust_score, legitimacy, corroborationCount, row.id]);
  }
  return { scored: rows.length };
}

// ---------------------------------------------------------------------------
// Retention — A11. Strip the heavy `description` from old new/dismissed
// (unsaved) listings while KEEPING the row (hash + status) as a dedup tombstone
// so a re-ingested dismissed job stays dismissed and never re-surfaces. saved/
// applied rows are retained in full.
// ---------------------------------------------------------------------------
async function purgeRetention(pool, days = 90) {
  const r = await pool.query(
    `UPDATE job_listings SET description = NULL
     WHERE status IN ('new','dismissed')
       AND description IS NOT NULL
       AND last_seen < now() - make_interval(days => $1)`,
    [days]);
  return { purged: r.rowCount };
}

// ---------------------------------------------------------------------------
// Orchestration — the full weekly refresh (no AI in Batch 1).
// ---------------------------------------------------------------------------
async function runRefresh(pool, opts = {}) {
  const normalized = await runIngest(pool, opts);
  const { newIds, seen } = await dedupPersist(pool, normalized);
  const trust = await runTrustPass(pool, newIds);
  const purge = await purgeRetention(pool, opts.retentionDays || 90);
  return { fetched: normalized.length, seen, added: newIds.length, scored: trust.scored, purged: purge.purged };
}

// ---------------------------------------------------------------------------
// Shared aggregator — A6. SINGLE fail-soft source feeding the /jobs page, the
// notification check, and the AI daily briefing (the gatherHealthSummary
// mirror). main = high-trust/high-fit; verify_first = borderline-trust so a
// strict filter never silently eats a real lead.
// ---------------------------------------------------------------------------
async function gatherJobRadarSummary(pool, limit = 20) {
  try {
    const rows = (await pool.query(
      `SELECT id, title, company, location, remote, salary_min, salary_max, apply_url, apply_domain,
              fit_score, fit_rationale, trust_score, legitimacy, corroboration_count, status, first_seen
       FROM job_listings
       WHERE status IN ('new','saved')
       ORDER BY fit_score DESC NULLS LAST, trust_score DESC NULLS LAST, first_seen DESC
       LIMIT $1`, [Math.max(1, limit) * 3])).rows;
    const main = [], verify = [];
    for (const r of rows) {
      const trust = r.trust_score == null ? 0 : r.trust_score;
      const fitOk = r.fit_score == null || r.fit_score >= FIT_MAIN; // Batch 1: fit not yet computed ⇒ not a blocker
      if (trust >= TRUST_MAIN && fitOk) main.push(r);
      else if (trust >= TRUST_VERIFY) verify.push(r);
    }
    return {
      generated_at: new Date().toISOString(),
      counts: { main: main.length, verify_first: verify.length, scanned: rows.length },
      main: main.slice(0, limit),
      verify_first: verify.slice(0, limit),
      top_pick: main[0] || null,
    };
  } catch (err) {
    console.error("gatherJobRadarSummary error:", err.message);
    return {
      generated_at: new Date().toISOString(),
      counts: { main: 0, verify_first: 0, scanned: 0 },
      main: [], verify_first: [], top_pick: null, error: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const VALID_STATUS = ["new", "saved", "applied", "dismissed"];
const VALID_ATS = ["greenhouse", "lever", "ashby", "workable"];
const VALID_REMOTE_PREF = ["remote", "hybrid", "onsite", "any"];

// ---------------------------------------------------------------------------
// Router (factory) — helpers attached AFTER (INV-19)
// ---------------------------------------------------------------------------
module.exports = function ({ pool }) {
  const router = express.Router();

  // Manual refresh trigger (also hit by the weekly cron + the Actions backstop).
  router.post("/api/jobs/refresh", async (_req, res) => {
    try {
      const result = await runRefresh(pool, {});
      res.json({ ok: true, ...result });
    } catch (err) { serverError(res, err); }
  });

  // The single surface read — main + verify-first buckets.
  router.get("/api/jobs", async (_req, res) => {
    try { res.json(await gatherJobRadarSummary(pool)); }
    catch (err) { serverError(res, err); }
  });

  // Single-row profile.
  router.get("/api/job-profile", async (_req, res) => {
    try {
      const r = await pool.query(
        "SELECT id, resume_text, preferences_text, min_salary, locations, remote_pref, updated_at FROM job_profile WHERE id = 1");
      res.json(r.rows[0] || { id: 1 });
    } catch (err) { serverError(res, err); }
  });

  router.patch("/api/job-profile", async (req, res) => {
    const b = req.body || {};
    const sets = [], vals = [];
    const errors = [];
    if (b.resume_text !== undefined) {
      if (b.resume_text !== null && typeof b.resume_text !== "string") errors.push("resume_text must be a string.");
      else { vals.push(b.resume_text == null ? null : String(b.resume_text).slice(0, MAX_TEXT)); sets.push(`resume_text = $${vals.length}`); }
    }
    if (b.preferences_text !== undefined) {
      if (b.preferences_text !== null && typeof b.preferences_text !== "string") errors.push("preferences_text must be a string.");
      else { vals.push(b.preferences_text == null ? null : String(b.preferences_text).slice(0, MAX_TEXT)); sets.push(`preferences_text = $${vals.length}`); }
    }
    if (b.min_salary !== undefined) {
      if (b.min_salary === null) { vals.push(null); sets.push(`min_salary = $${vals.length}`); }
      else if (!Number.isFinite(Number(b.min_salary)) || Number(b.min_salary) < 0) errors.push("min_salary must be a non-negative number.");
      else { vals.push(Number(b.min_salary)); sets.push(`min_salary = $${vals.length}`); }
    }
    if (b.locations !== undefined) {
      if (b.locations !== null && !Array.isArray(b.locations)) errors.push("locations must be an array.");
      else { vals.push(b.locations == null ? null : b.locations.map(String).slice(0, 25)); sets.push(`locations = $${vals.length}`); }
    }
    if (b.remote_pref !== undefined) {
      if (b.remote_pref !== null && !VALID_REMOTE_PREF.includes(b.remote_pref)) errors.push("remote_pref must be one of: " + VALID_REMOTE_PREF.join(", "));
      else { vals.push(b.remote_pref || null); sets.push(`remote_pref = $${vals.length}`); }
    }
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });
    if (!sets.length) return res.status(400).json({ error: "No fields to update." });
    try {
      await pool.query("INSERT INTO job_profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
      const r = await pool.query(
        `UPDATE job_profile SET ${sets.join(", ")}, updated_at = now() WHERE id = 1
         RETURNING id, resume_text, preferences_text, min_salary, locations, remote_pref, updated_at`, vals);
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  // Listing status — archive-not-delete (dismissed is a status, not a row drop).
  router.patch("/api/jobs/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
    const status = req.body && req.body.status;
    if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: "status must be one of: " + VALID_STATUS.join(", ") });
    try {
      const r = await pool.query("UPDATE job_listings SET status = $1 WHERE id = $2 RETURNING id, status", [status, id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  // Curated ATS allowlist CRUD (D4 — UI-editable alongside the db/021 seed).
  router.get("/api/job-companies", async (_req, res) => {
    try {
      const r = await pool.query("SELECT id, slug, ats, display_name, active, created_at FROM job_target_companies ORDER BY ats, slug");
      res.json({ companies: r.rows });
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/job-companies", async (req, res) => {
    const b = req.body || {};
    const slug = typeof b.slug === "string" ? b.slug.trim() : "";
    if (!slug) return res.status(400).json({ error: "slug is required." });
    if (!VALID_ATS.includes(b.ats)) return res.status(400).json({ error: "ats must be one of: " + VALID_ATS.join(", ") });
    try {
      const r = await pool.query(
        `INSERT INTO job_target_companies (slug, ats, display_name, active)
         VALUES ($1,$2,$3, true)
         ON CONFLICT (ats, slug) DO UPDATE SET active = true, display_name = COALESCE(EXCLUDED.display_name, job_target_companies.display_name)
         RETURNING id, slug, ats, display_name, active`,
        [slug, b.ats, b.display_name ? String(b.display_name).slice(0, 200) : null]);
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/job-companies/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
    try {
      const r = await pool.query("DELETE FROM job_target_companies WHERE id = $1 RETURNING id", [id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { serverError(res, err); }
  });

  return router;
};

// Helper exports attached AFTER the factory assignment (INV-19 — assigning
// module.exports above would otherwise drop these).
module.exports.computeContentHash = computeContentHash;
module.exports.hostnameOf = hostnameOf;
module.exports.scamHeuristics = scamHeuristics;
module.exports.applyDomainScore = applyDomainScore;
module.exports.computeTrustScore = computeTrustScore;
module.exports.cosineSim = cosineSim;
module.exports.collapseNearDups = collapseNearDups;
module.exports.normalizeAdzuna = normalizeAdzuna;
module.exports.normalizeGreenhouse = normalizeGreenhouse;
module.exports.normalizeLever = normalizeLever;
module.exports.normalizeAshby = normalizeAshby;
module.exports.normalizeWorkable = normalizeWorkable;
module.exports.dedupPersist = dedupPersist;
module.exports.runTrustPass = runTrustPass;
module.exports.purgeRetention = purgeRetention;
module.exports.runRefresh = runRefresh;
module.exports.runIngest = runIngest;
module.exports.gatherJobRadarSummary = gatherJobRadarSummary;
