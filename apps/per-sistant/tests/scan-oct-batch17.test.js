// ============================================================================
// Cycle-7 (Oct 2026) Batch 17 — Knowledge parse version (ST4, Per-sistant side)
// ============================================================================
// A successful FULL vault sync records VAULT_PARSE_VERSION in
// user_settings.vault_parse_version (db/029); an incremental or a failed sync
// doesn't. Perfin's operator checks compare the two and ask for one full
// reindex while the stored version is older (root tests/scan-oct-batch17).
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const vault = require("../services/vault-sync");

async function withEnv(env, fn) {
  const keys = Object.keys(env);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) { if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
function gh(routes) {
  return async (url) => {
    const u = String(url).replace("https://api.github.com", "");
    for (const [re, body] of routes) {
      if (re.test(u)) {
        if (typeof body === "number") return { ok: false, status: body, text: async () => "boom", json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body, text: async () => "" };
      }
    }
    throw new Error("unexpected GitHub call " + u);
  };
}
const file = (text) => ({ encoding: "base64", content: Buffer.from(text).toString("base64") });
function vaultPool({ lastSha = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/vault_enabled, vault_repo/.test(sql)) return { rows: [{ vault_enabled: true, vault_repo: "me/vault", vault_branch: "main", vault_last_sha: lastSha }] };
      if (/to_regclass/.test(sql)) return { rows: [{ t: null }] };
      if (/SELECT source_ref FROM documents/.test(sql)) return { rows: [] };
      if (/INSERT INTO documents/.test(sql)) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
    connect: async () => ({ query: async (sql, params) => { calls.push({ sql, params, tx: true }); return { rows: [] }; }, release() {} }),
  };
}
const stamped = (pool) => pool.calls.filter((c) => /SET vault_parse_version = \$1/.test(c.sql)).map((c) => c.params[0]);

describe("ST4 — the vault parse version", () => {
  it("db/029 adds the column; the constant is exported", () => {
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "029_vault_parse_version.sql"), "utf8");
    assert.match(sql, /ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vault_parse_version INT/);
    assert.equal(Number.isInteger(vault.VAULT_PARSE_VERSION) && vault.VAULT_PARSE_VERSION >= 2, true);
  });

  it("a successful full sync stamps it", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const pool = vaultPool();
      const r = await vault.syncVault(pool, {
        full: true,
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "H1" } }],
          [/\/git\/trees\/H1/, { tree: [{ type: "blob", path: "a.md" }] }],
          [/\/contents\/a\.md/, file("hello")],
        ]),
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.full, true);
      assert.deepEqual(stamped(pool), [vault.VAULT_PARSE_VERSION]);
    }));

  it("an incremental sync does not, and neither does a failed full sync", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const inc = vaultPool({ lastSha: "OLD" });
      const r = await vault.syncVault(inc, {
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "NEW" } }],
          [/\/compare\/OLD\.\.\.NEW/, { status: "ahead", files: [{ status: "modified", filename: "a.md" }] }],
          [/\/contents\/a\.md/, file("hello")],
        ]),
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.full, false);
      assert.deepEqual(stamped(inc), []);

      const bad = vaultPool();
      const f = await vault.syncVault(bad, {
        full: true,
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "H1" } }],
          [/\/git\/trees\/H1/, { tree: [{ type: "blob", path: "a.md" }] }],
          [/\/contents\/a\.md/, 500],
        ]),
      });
      assert.equal(f.ok, false);
      assert.deepEqual(stamped(bad), []);
    }));
});
