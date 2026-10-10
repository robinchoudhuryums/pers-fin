// Real-Postgres contract tests: the Per-sistant KNOWLEDGE pipeline — vault sync
// (through a fake GitHub API injected via syncVault's fetchImpl), notes sync,
// keyword retrieval, structured facts with validity windows, the secret tier
// and an incremental re-sync that removes a deleted file. No Voyage key and no
// AI key, so this is the degraded path every deploy falls back to (INV-28/29):
// documents and facts still ingest and are keyword-searchable. Closes the "no
// contract coverage for Knowledge" gap left by Batch 15.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, persistentDb, persistentApp } = require("./_setup");

// --- fake GitHub ------------------------------------------------------------
const FILES = {
  "notes/insurance.md": "---\ntitle: Home insurance\ntags: [insurance]\n---\n# Home insurance\nThe homeowners policy is with Acme Mutual. The deductible applies per claim.\n",
  "facts/policy.md": "---\ntype: fact\nentity: home insurance\ndeductible: $1,000\nrenewal_date: 2099-03-01\n---\n",
  "facts/old.md": "---\ntype: fact\nentity: old lease\nrent: $900\nvalid_to: 2001-01-01\n---\n",
  "private/wifi.md": "---\nsensitivity: secret\n---\nGuest wifi password is zebra-lantern-42\n",
  "notes/garden.md": "# Garden\nTomatoes need watering every second day.\n",
};
let head = "sha1";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
function fakeFetch(url) {
  const u = new URL(url);
  const p = u.pathname;
  const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (p.endsWith("/branches/main")) return json({ commit: { sha: head } });
  if (p.includes("/git/trees/")) return json({ truncated: false, tree: Object.keys(FILES).map((path) => ({ path, type: "blob" })) });
  if (p.includes("/compare/")) return json({ files: [{ filename: "notes/garden.md", status: "removed" }] });
  const m = p.match(/\/contents\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    if (!(path in FILES)) return json({ message: "Not Found" }, 404);
    return json({ encoding: "base64", content: b64(FILES[path]) });
  }
  return json({ message: "unexpected " + p }, 404);
}

describe("Knowledge pipeline on real Postgres (keyword path)", { skip: SKIP }, () => {
  let pool, app, vault;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.VAULT_GITHUB_TOKEN = "contract-read-token";
    pool = await persistentDb("knowledge");
    app = persistentApp(pool);
    vault = require("../../apps/per-sistant/services/vault-sync");
    await q("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    await supertest(app).patch("/api/settings").send({ vault_enabled: true, vault_repo: "me/vault", vault_branch: "main" }).expect(200);
  });
  after(async () => { if (pool) await pool.end(); });

  it("a full sync ingests prose documents and fact files without Voyage/pgvector embeddings", async () => {
    const r = await vault.syncVault(pool, { fetchImpl: fakeFetch, full: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const docs = (await q("SELECT source_ref, sensitivity FROM documents WHERE source='vault' AND deleted_at IS NULL ORDER BY 1")).rows;
    assert.deepEqual(docs.map((d) => [d.source_ref, d.sensitivity]), [
      ["notes/garden.md", "normal"], ["notes/insurance.md", "normal"], ["private/wifi.md", "secret"],
    ]);
    const facts = (await q("SELECT entity, attribute, value FROM facts ORDER BY entity, attribute")).rows;
    assert.ok(facts.some((f) => f.entity === "home insurance" && f.attribute === "deductible" && f.value === "$1,000"), JSON.stringify(facts));
    const st = (await q("SELECT vault_last_sha, vault_last_synced_at IS NOT NULL AS ok, vault_last_error FROM user_settings")).rows[0];
    assert.deepEqual(st, { vault_last_sha: "sha1", ok: true, vault_last_error: null });
  });

  it("a repeat sync at the same head is a no-op", async () => {
    const r = await vault.syncVault(pool, { fetchImpl: fakeFetch });
    assert.equal(r.up_to_date, true, JSON.stringify(r));
  });

  it("notes sync + keyword search find vault documents and notes, never the secret item", async () => {
    await supertest(app).post("/api/notes").send({ title: "Insurance call", content: "Called Acme Mutual about the deductible." }).expect(200);
    await vault.syncNotes(pool);
    const r = (await supertest(app).get("/api/rag/search?q=" + encodeURIComponent("Acme Mutual deductible")).expect(200)).body;
    const kinds = r.results.map((x) => x.kind).sort();
    assert.ok(kinds.includes("document") && kinds.includes("note"), JSON.stringify(r.results));
    const w = (await supertest(app).get("/api/rag/search?q=wifi%20password").expect(200)).body;
    assert.ok(!JSON.stringify(w).includes("zebra"), "secret content never comes back from retrieval (INV-27)");
  });

  it("the secret tier is reachable only through the local secret lookup", async () => {
    const r = (await supertest(app).get("/api/rag/secret-lookup?q=wifi").expect(200)).body;
    assert.ok(JSON.stringify(r.results).includes("zebra-lantern-42"));
  });

  it("facts: current by default, expired only with all=1; verify round-trips", async () => {
    const cur = (await supertest(app).get("/api/rag/facts").expect(200)).body.facts;
    assert.ok(cur.some((f) => f.entity === "home insurance"));
    assert.ok(!cur.some((f) => f.entity === "old lease"), "an expired fact isn't current (SK5)");
    const all = (await supertest(app).get("/api/rag/facts?all=1").expect(200)).body.facts;
    assert.ok(all.some((f) => f.entity === "old lease"));
    await supertest(app).post("/api/rag/facts/verify").send({ entity: "home insurance", attribute: "deductible", value: "$1,000" }).expect(200);
    const v = (await supertest(app).get("/api/rag/facts?entity=home").expect(200)).body.facts.find((f) => f.attribute === "deductible");
    assert.equal(v.verified, true);
  });

  it("query without AI returns the facts document + retrieved sources (INV-29 degrade)", async () => {
    const r = await supertest(app).post("/api/rag/query").send({ query: "what is the home insurance deductible" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = JSON.stringify(r.body);
    assert.ok(s.includes("fact") && s.includes("insurance"), s.slice(0, 400));
    assert.ok(!s.includes("zebra"));
  });

  it("status reports the ingest", async () => {
    const st = (await supertest(app).get("/api/rag/status").expect(200)).body;
    assert.ok(JSON.stringify(st).includes("me/vault"));
  });

  it("an incremental sync to a new head applies the compare diff (deleted file removed)", async () => {
    const before = (await supertest(app).get("/api/rag/search?q=tomatoes").expect(200)).body.results;
    assert.equal(before.length, 1, "found while the file exists");
    head = "sha2";
    delete FILES["notes/garden.md"];
    const r = await vault.syncVault(pool, { fetchImpl: fakeFetch });
    assert.equal(r.ok, true, JSON.stringify(r));
    const gone = (await q("SELECT COUNT(*)::int AS n FROM documents WHERE source_ref='notes/garden.md' AND deleted_at IS NULL")).rows[0].n;
    assert.equal(gone, 0);
    const hit = (await supertest(app).get("/api/rag/search?q=tomatoes").expect(200)).body.results;
    assert.equal(hit.length, 0, "a deleted vault file is no longer retrieved (KR-1)");
    assert.equal((await q("SELECT vault_last_sha FROM user_settings")).rows[0].vault_last_sha, "sha2");
  });
});
