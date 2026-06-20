// ============================================================================
// Job Radar — Batch 1 (db/021 + routes/jobs.js pipeline)
// ============================================================================
// Pure-helper tests + mock-pool behavioral tests (no network, no real DB).
// Pins: dedup idempotency (2nd run adds 0), trust scoring (corroboration /
// apply-domain / scam), near-dup collapse, retention purge, gatherJobRadarSummary
// fail-soft + bucketing, normalizer shape, and migration idempotency markers.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const jobs = require("../routes/jobs");
const {
  computeContentHash, hostnameOf, scamHeuristics, applyDomainScore, computeTrustScore,
  cosineSim, collapseNearDups, normalizeGreenhouse, normalizeLever, normalizeAdzuna,
  dedupPersist, runTrustPass, purgeRetention, gatherJobRadarSummary,
} = jobs;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("computeContentHash", () => {
  it("is stable + case/whitespace-insensitive (re-fetch hashes identically)", () => {
    const a = { company: "Stripe", title: "SWE", location: "Remote", apply_url: "https://x/y" };
    const b = { company: "  stripe ", title: "swe", location: "remote", apply_url: "https://x/y" };
    assert.equal(computeContentHash(a), computeContentHash(b));
  });
  it("differs for genuinely different roles", () => {
    const a = { company: "Stripe", title: "SWE", location: "Remote", apply_url: "https://x/1" };
    const b = { company: "Stripe", title: "PM", location: "Remote", apply_url: "https://x/2" };
    assert.notEqual(computeContentHash(a), computeContentHash(b));
  });
});

describe("hostnameOf / applyDomainScore", () => {
  it("extracts a www-stripped hostname; bad urls → null", () => {
    assert.equal(hostnameOf("https://www.boards.greenhouse.io/stripe/jobs/1"), "boards.greenhouse.io");
    assert.equal(hostnameOf("not a url"), null);
  });
  it("scores ATS domains up, shorteners down, unknown neutral, missing negative", () => {
    assert.equal(applyDomainScore("boards.greenhouse.io"), 10);
    assert.equal(applyDomainScore("jobs.lever.co"), 10);
    assert.equal(applyDomainScore("bit.ly"), -20);
    assert.equal(applyDomainScore("careers.randomco.com"), 0);
    assert.equal(applyDomainScore(null), -10);
  });
});

describe("scamHeuristics (word-boundary, INV-10)", () => {
  it("flags personal email, up-front payment, sensitive-data, off-platform contact", () => {
    const hits = scamHeuristics({ title: "Data Entry", description: "Email recruiter@gmail.com, pay a $50 registration fee, contact us on Telegram, send your SSN" });
    assert.ok(hits.includes("personal_email"));
    assert.ok(hits.includes("upfront_payment"));
    assert.ok(hits.includes("sensitive_data"));
    assert.ok(hits.includes("offplatform_contact"));
  });
  it("flags comp far above market", () => {
    assert.ok(scamHeuristics({ description: "great role", salary_max: 900000 }).includes("comp_above_market"));
  });
  it("a clean corporate listing yields no flags", () => {
    assert.deepEqual(scamHeuristics({ title: "Senior Engineer", description: "Join our team. Apply via our careers site.", salary_max: 200000 }), []);
  });
});

describe("computeTrustScore", () => {
  it("ATS-weight clean listing → high score, 'real'", () => {
    const r = computeTrustScore({ sourceWeight: 90, firstSeenDaysAgo: 1, domainScore: 10 });
    assert.ok(r.trust_score >= 90);
    assert.equal(r.legitimacy, "real");
  });
  it("corroboration raises, ghost-age decays", () => {
    const fresh = computeTrustScore({ sourceWeight: 70, firstSeenDaysAgo: 0, corroborationCount: 1 });
    const stale = computeTrustScore({ sourceWeight: 70, firstSeenDaysAgo: 60 });
    assert.ok(fresh.trust_score > stale.trust_score);
  });
  it("scam hits crater the score + force suspect/scam", () => {
    assert.equal(computeTrustScore({ sourceWeight: 90, scamHits: ["personal_email"] }).legitimacy, "suspect");
    assert.equal(computeTrustScore({ sourceWeight: 90, scamHits: ["a", "b"] }).legitimacy, "scam");
  });
});

describe("cosineSim / collapseNearDups", () => {
  it("cosine of identical vectors is ~1, orthogonal ~0", () => {
    assert.ok(Math.abs(cosineSim([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9);
  });
  it("keeps the most authoritative copy of a near-dup cluster", () => {
    const r = collapseNearDups([
      { id: 1, authority: 1, embedding: [1, 0, 0] },        // aggregator
      { id: 2, authority: 9, embedding: [0.99, 0.01, 0] },  // ATS (near-dup of 1, higher authority)
      { id: 3, authority: 5, embedding: [0, 1, 0] },        // distinct role
    ], 0.9);
    assert.ok(r.kept.includes(2), "kept the ATS copy");
    assert.ok(r.kept.includes(3), "kept the distinct role");
    assert.ok(!r.kept.includes(1), "dropped the aggregator near-dup");
    assert.equal(r.dropped[0].canonical_id, 2);
  });
  it("is a no-op when no embeddings are present (Batch 1)", () => {
    assert.deepEqual(collapseNearDups([{ id: 1 }, { id: 2 }]), { kept: [], dropped: [] });
  });
});

describe("normalizers map provider raw → common shape", () => {
  it("greenhouse", () => {
    const n = normalizeGreenhouse({ id: 7, title: "Staff Eng", location: { name: "Remote - US" }, absolute_url: "https://boards.greenhouse.io/x/7", content: "<p>hi</p>", updated_at: "2026-06-01" }, "x");
    assert.equal(n.source_key, "greenhouse");
    assert.equal(n.source_job_id, "7");
    assert.equal(n.company, "x");
    assert.equal(n.remote, true);
    assert.equal(n.apply_url, "https://boards.greenhouse.io/x/7");
  });
  it("lever (epoch createdAt → ISO)", () => {
    const n = normalizeLever({ id: "abc", text: "PM", categories: { location: "NYC" }, hostedUrl: "https://jobs.lever.co/x/abc", descriptionPlain: "role", createdAt: 1700000000000 }, "x");
    assert.equal(n.source_key, "lever");
    assert.equal(n.title, "PM");
    assert.match(n.posted_at, /^20\d\d-/);
  });
  it("adzuna", () => {
    const n = normalizeAdzuna({ id: 5, title: "Remote SWE", company: { display_name: "Acme" }, location: { display_name: "Remote" }, salary_min: 100, salary_max: 200, redirect_url: "https://adzuna/5", description: "x", created: "2026-06-01" });
    assert.equal(n.company, "Acme");
    assert.equal(n.salary_max, 200);
    assert.equal(n.remote, true);
  });
});

// ---------------------------------------------------------------------------
// dedupPersist idempotency (mock pool simulating content_hash upsert)
// ---------------------------------------------------------------------------
function makeUpsertPool() {
  const hashes = new Set();
  let nextId = 1;
  return {
    hashes,
    query: async (sql, params) => {
      if (/FROM job_sources WHERE key/.test(sql)) return { rows: [{ id: 1 }] };
      if (/INSERT INTO job_listings/.test(sql)) {
        const hash = params[2];
        const inserted = !hashes.has(hash);
        if (inserted) hashes.add(hash);
        return { rows: [{ id: nextId++, inserted }] }; // mirrors (xmax = 0)
      }
      return { rows: [] };
    },
  };
}

describe("dedupPersist", () => {
  const normalized = [
    { source_key: "greenhouse", source_job_id: "1", title: "SWE", company: "Acme", location: "Remote", apply_url: "https://boards.greenhouse.io/acme/1" },
    { source_key: "greenhouse", source_job_id: "2", title: "PM", company: "Acme", location: "NYC", apply_url: "https://boards.greenhouse.io/acme/2" },
  ];
  it("first run adds all; second run over identical input adds 0 (idempotent)", async () => {
    const pool = makeUpsertPool();
    const r1 = await dedupPersist(pool, normalized);
    assert.equal(r1.newIds.length, 2);
    assert.equal(r1.seen, 2);
    const r2 = await dedupPersist(pool, normalized);
    assert.equal(r2.newIds.length, 0, "2nd run adds nothing");
    assert.equal(r2.seen, 2, "still saw both (last_seen bumped)");
  });
});

// ---------------------------------------------------------------------------
// runTrustPass writes a score/legitimacy; purgeRetention counts
// ---------------------------------------------------------------------------
describe("runTrustPass", () => {
  it("scores a clean ATS row 'real' and writes trust_score", async () => {
    const updates = [];
    const pool = {
      query: async (sql, params) => {
        if (/WHERE jl\.id = ANY/.test(sql)) return { rows: [{ id: 10, title: "Eng", company: "Acme", description: "Apply on our site.", apply_domain: "boards.greenhouse.io", salary_max: 200000, first_seen: new Date().toISOString(), trust_weight: 90 }] };
        if (/COUNT\(DISTINCT js\.kind\)/.test(sql)) return { rows: [{ kinds: 1 }] };
        if (/UPDATE job_listings SET trust_score/.test(sql)) { updates.push(params); return { rows: [] }; }
        return { rows: [] };
      },
    };
    const r = await runTrustPass(pool, [10]);
    assert.equal(r.scored, 1);
    assert.equal(updates.length, 1);
    assert.ok(updates[0][0] >= 90, "trust_score high");
    assert.equal(updates[0][1], "real");
  });
  it("no ids → no work", async () => {
    const r = await runTrustPass({ query: async () => { throw new Error("should not query"); } }, []);
    assert.equal(r.scored, 0);
  });
});

describe("purgeRetention", () => {
  it("strips old new/dismissed descriptions and reports the count", async () => {
    let captured = null;
    const pool = { query: async (sql, params) => { captured = { sql, params }; return { rowCount: 3 }; } };
    const r = await purgeRetention(pool, 90);
    assert.equal(r.purged, 3);
    assert.match(captured.sql, /status IN \('new','dismissed'\)/);
    assert.match(captured.sql, /description = NULL/);
    assert.equal(captured.params[0], 90);
  });
});

// ---------------------------------------------------------------------------
// gatherJobRadarSummary — bucketing + fail-soft
// ---------------------------------------------------------------------------
describe("gatherJobRadarSummary", () => {
  it("splits main (trust>=60) from verify_first (40-59); below 40 excluded", async () => {
    const pool = {
      query: async () => ({ rows: [
        { id: 1, trust_score: 80, fit_score: null, status: "new" },
        { id: 2, trust_score: 50, fit_score: null, status: "new" },
        { id: 3, trust_score: 20, fit_score: null, status: "new" },
      ] }),
    };
    const s = await gatherJobRadarSummary(pool);
    assert.equal(s.counts.main, 1);
    assert.equal(s.counts.verify_first, 1);
    assert.equal(s.top_pick.id, 1);
    assert.ok(!s.main.concat(s.verify_first).some((r) => r.id === 3), "trust<40 excluded");
  });
  it("is fail-soft — a query error returns the safe empty shape", async () => {
    const s = await gatherJobRadarSummary({ query: async () => { throw new Error("db down"); } });
    assert.equal(s.error, true);
    assert.deepEqual(s.main, []);
    assert.equal(s.top_pick, null);
  });
});

// ---------------------------------------------------------------------------
// Endpoints (mock pool + supertest) — archive-not-delete + 400 guards
// ---------------------------------------------------------------------------
function buildApp(queryImpl) {
  const app = express();
  app.use(express.json());
  app.use(jobs({ pool: { query: queryImpl } }));
  return app;
}

describe("job routes — validation + archive-not-delete", () => {
  it("PATCH /api/jobs/:id rejects an invalid status, accepts 'dismissed' (archive)", async () => {
    const app = buildApp(async (sql, params) => {
      if (/UPDATE job_listings SET status/.test(sql)) return { rows: [{ id: params[1], status: params[0] }] };
      return { rows: [] };
    });
    await supertest(app).patch("/api/jobs/5").send({ status: "bogus" }).expect(400);
    const ok = await supertest(app).patch("/api/jobs/5").send({ status: "dismissed" }).expect(200);
    assert.equal(ok.body.status, "dismissed");
  });
  it("PATCH /api/job-profile validates min_salary + remote_pref", async () => {
    const app = buildApp(async () => ({ rows: [{ id: 1 }] }));
    await supertest(app).patch("/api/job-profile").send({ min_salary: -5 }).expect(400);
    await supertest(app).patch("/api/job-profile").send({ remote_pref: "spaceship" }).expect(400);
    await supertest(app).patch("/api/job-profile").send({}).expect(400); // no fields
  });
  it("POST /api/job-companies validates ats + slug", async () => {
    const app = buildApp(async (sql, params) => ({ rows: [{ id: 1, slug: params[0], ats: params[1] }] }));
    await supertest(app).post("/api/job-companies").send({ slug: "x", ats: "nope" }).expect(400);
    await supertest(app).post("/api/job-companies").send({ ats: "lever" }).expect(400);
    await supertest(app).post("/api/job-companies").send({ slug: "netflix", ats: "lever" }).expect(200);
  });
});

// ---------------------------------------------------------------------------
// Migration idempotency markers (the migration runs inside the fatal-on-error
// boot transaction; CI runs it twice — every statement must be idempotent)
// ---------------------------------------------------------------------------
describe("db/021_jobs.sql is idempotent + pgvector-defensive", () => {
  const sql = read("db", "021_jobs.sql");
  it("uses CREATE TABLE IF NOT EXISTS for all four tables", () => {
    for (const t of ["job_sources", "job_target_companies", "job_listings", "job_profile"]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`), `${t} guarded`);
    }
  });
  it("seeds via ON CONFLICT DO NOTHING (re-run safe)", () => {
    assert.match(sql, /INSERT INTO job_sources[\s\S]*ON CONFLICT \(key\) DO NOTHING/);
    assert.match(sql, /INSERT INTO job_target_companies[\s\S]*ON CONFLICT \(ats, slug\) DO NOTHING/);
  });
  it("guards the vector column + HNSW index behind the pg_available_extensions check (db/014 pattern)", () => {
    assert.match(sql, /DO \$vec\$/);
    assert.match(sql, /pg_available_extensions WHERE name = 'vector'/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS embedding vector\(1024\)/);
    assert.match(sql, /USING hnsw \(embedding vector_cosine_ops\)/);
  });
  it("adds the Job Fit model column idempotently", () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS ai_model_job_fit/);
  });
});
