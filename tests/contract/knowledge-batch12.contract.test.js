// Real-Postgres contract tests for the cycle-7 Batch 12 Knowledge ingest fixes:
// upcomingFacts announcing only CURRENT facts against a passed-in (APP_TIMEZONE)
// date (F131); a vault file with a "--- " opener and a repeated sensitivity key
// stored as secret (F132); a file over 1 MB read through the blobs API keeping
// its facts (F128); a truncated tree reported and the SHA held (F127); and a
// force-pushed (diverged) history removing a file from the dropped commits (F133).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, persistentDb, persistentApp } = require("./_setup");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
let FILES = {};
let head = "h1";
let truncated = false;
let compare = null;
const BIG = new Set();
function fakeFetch(url) {
  const p = new URL(url).pathname;
  const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (p.endsWith("/branches/main")) return json({ commit: { sha: head } });
  if (p.includes("/git/trees/")) return json({ truncated, tree: Object.keys(FILES).map((path) => ({ path, type: "blob" })) });
  if (p.includes("/compare/")) return json(compare);
  const blob = p.match(/\/git\/blobs\/(.+)$/);
  if (blob) return json({ encoding: "base64", content: b64(FILES[decodeURIComponent(blob[1])]) });
  const m = p.match(/\/contents\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    if (!(path in FILES)) return json({ message: "Not Found" }, 404);
    if (BIG.has(path)) return json({ encoding: "none", content: "", size: 1_200_000, sha: encodeURIComponent(path) });
    return json({ encoding: "base64", content: b64(FILES[path]) });
  }
  return json({ message: "unexpected " + p }, 404);
}

describe("Knowledge Batch 12 on real Postgres", { skip: SKIP }, () => {
  let pool, app, vault, rag;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.VAULT_GITHUB_TOKEN = "contract-read-token";
    pool = await persistentDb("knowledge12");
    app = persistentApp(pool);
    vault = require("../../apps/per-sistant/services/vault-sync");
    rag = require("../../apps/per-sistant/routes/rag");
    await q("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    await supertest(app).patch("/api/settings").send({ vault_enabled: true, vault_repo: "me/vault", vault_branch: "main" }).expect(200);
  });
  after(async () => { if (pool) await pool.end(); });

  it("F131: only current facts are announced, relative to the given day", async () => {
    await q(`INSERT INTO facts (entity, attribute, value, valid_from, valid_to) VALUES
      ('Car', 'renewal_date', '2030-06-25', NULL, NULL),
      ('Old car', 'renewal_date', '2030-06-20', NULL, '2030-06-01'),
      ('New car', 'renewal_date', '2030-06-22', '2030-07-01', NULL),
      ('Lease', 'rent', '900', NULL, '2030-06-18')`);
    const rows = await rag.upcomingFacts(pool, 30, "2030-06-15");
    assert.deepEqual(rows.map((r) => [r.entity, r.kind, Number(r.days_away)]), [
      ["Lease", "expires", 3],
      ["Car", "renewal_date", 10],
    ]);
  });

  it("F132 + F128: a '--- ' file with a repeated sensitivity key is secret; a 1 MB fact file keeps its facts", async () => {
    FILES = {
      "private/pin.md": "--- \nsensitivity: secret\nsensitivity: normal\n---\nAlarm code 4471\n",
      "facts/boat.md": "---\ntype: fact\nentity: Boat\nmooring: B12\n---\n" + "x".repeat(50),
      "notes/a.md": "# A\nhello\n",
    };
    BIG.add("facts/boat.md");
    const r = await vault.syncVault(pool, { fetchImpl: fakeFetch, full: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const pin = (await q("SELECT sensitivity FROM documents WHERE source_ref = 'private/pin.md'")).rows[0];
    assert.equal(pin.sensitivity, "secret");
    const boat = (await q("SELECT value FROM facts WHERE entity = 'Boat' AND attribute = 'mooring'")).rows;
    assert.deepEqual(boat, [{ value: "B12" }]);
  });

  it("F127: a truncated tree is reported and the SHA holds", async () => {
    head = "h2";
    truncated = true;
    FILES["notes/b.md"] = "# B\nworld\n";
    const r = await vault.syncVault(pool, { fetchImpl: fakeFetch, full: true });
    assert.equal(r.ok, false);
    const st = (await q("SELECT vault_last_sha, vault_last_error FROM user_settings")).rows[0];
    assert.equal(st.vault_last_sha, "h1");
    assert.match(st.vault_last_error, /truncated/);
    assert.equal((await q("SELECT count(*)::int AS n FROM documents WHERE source_ref = 'notes/b.md'")).rows[0].n, 1, "listed files still ingest");
    truncated = false;
  });

  it("F133: a diverged compare after a force-push removes a file from the dropped commits", async () => {
    // Sync cleanly at h2 first so vault_last_sha = h2.
    assert.equal((await vault.syncVault(pool, { fetchImpl: fakeFetch, full: true })).ok, true);
    head = "h3";
    delete FILES["notes/b.md"]; // existed only in the commits the force-push dropped
    compare = { status: "diverged", files: [{ status: "modified", filename: "notes/a.md" }] };
    const r = await vault.syncVault(pool, { fetchImpl: fakeFetch });
    assert.equal(r.ok, true, JSON.stringify(r));
    const b = (await q("SELECT deleted_at IS NOT NULL AS gone FROM documents WHERE source_ref = 'notes/b.md'")).rows[0];
    assert.equal(b.gone, true);
    assert.equal((await q("SELECT vault_last_sha FROM user_settings")).rows[0].vault_last_sha, "h3");
  });
});
