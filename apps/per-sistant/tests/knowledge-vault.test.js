// ============================================================================
// Per-sistant — Knowledge / Vault (Phase 1) tests
// ============================================================================
// Pure helpers (frontmatter, chunking, sensitivity, indexable) + embeddings
// literal + syncVault config guards via a mock pool. No network/DB/API key.
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const vault = require("../services/vault-sync");
const embeddings = require("../services/embeddings");

describe("Vault — parseFrontmatter", () => {
  it("returns body unchanged when there is no frontmatter", () => {
    const { meta, body } = vault.parseFrontmatter("# Title\n\nhello");
    assert.deepEqual(meta, {});
    assert.equal(body, "# Title\n\nhello");
  });

  it("parses keys, booleans, and arrays; strips the block from the body", () => {
    const text = "---\ntitle: My Note\nembed: false\ntags: [a, b, c]\n---\nBody here";
    const { meta, body } = vault.parseFrontmatter(text);
    assert.equal(meta.title, "My Note");
    assert.equal(meta.embed, false);
    assert.deepEqual(meta.tags, ["a", "b", "c"]);
    assert.equal(body, "Body here");
  });
});

describe("Vault — resolveSensitivity", () => {
  it("defaults to normal", () => assert.equal(vault.resolveSensitivity({}), "normal"));
  it("embed:false -> private", () => assert.equal(vault.resolveSensitivity({ embed: false }), "private"));
  it("private:true -> private", () => assert.equal(vault.resolveSensitivity({ private: true }), "private"));
  it("explicit sensitivity wins", () => assert.equal(vault.resolveSensitivity({ sensitivity: "secret" }), "secret"));
  it("ignores invalid sensitivity values", () => assert.equal(vault.resolveSensitivity({ sensitivity: "bogus" }), "normal"));
});

describe("Vault — shouldIndex", () => {
  it("indexes md/markdown/txt", () => {
    assert.ok(vault.shouldIndex("notes/a.md"));
    assert.ok(vault.shouldIndex("b.markdown"));
    assert.ok(vault.shouldIndex("c.txt"));
  });
  it("skips other extensions and dotfiles/dirs", () => {
    assert.ok(!vault.shouldIndex("img.png"));
    assert.ok(!vault.shouldIndex(".obsidian/config.md"));
    assert.ok(!vault.shouldIndex(".hidden.md"));
  });
});

describe("Vault — chunkMarkdown", () => {
  it("returns [] for empty/whitespace", () => {
    assert.deepEqual(vault.chunkMarkdown(""), []);
    assert.deepEqual(vault.chunkMarkdown("   \n  "), []);
  });
  it("keeps short text as a single chunk", () => {
    const c = vault.chunkMarkdown("just a short note");
    assert.equal(c.length, 1);
  });
  it("splits long text into multiple chunks under the size cap", () => {
    const big = ("word ".repeat(600)).trim(); // ~3000 chars
    const c = vault.chunkMarkdown(big, { maxChars: 1000, overlap: 100 });
    assert.ok(c.length >= 3, `expected multiple chunks, got ${c.length}`);
    for (const ch of c) assert.ok(ch.length <= 1000 + 5, "chunk within cap");
  });
  it("splits on headings", () => {
    const md = "# A\n\nalpha\n\n# B\n\nbravo";
    const c = vault.chunkMarkdown(md, { maxChars: 100 });
    assert.equal(c.length, 2);
    assert.match(c[0], /^# A/);
    assert.match(c[1], /^# B/);
  });
});

describe("Embeddings — toVectorLiteral", () => {
  it("formats a pgvector literal", () => {
    assert.equal(embeddings.toVectorLiteral([0.1, 0.2, -0.3]), "[0.1,0.2,-0.3]");
  });
  it("isConfigured reflects VOYAGE_API_KEY", () => {
    const saved = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    try {
      assert.equal(embeddings.isConfigured(), false);
      process.env.VOYAGE_API_KEY = "pa-test";
      assert.equal(embeddings.isConfigured(), true);
    } finally {
      if (saved === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = saved;
    }
  });
});

describe("Vault — syncVault config guards", () => {
  it("returns not_configured when vault disabled / no token", async () => {
    const saved = process.env.VAULT_GITHUB_TOKEN;
    delete process.env.VAULT_GITHUB_TOKEN;
    try {
      const mockPool = { query: async () => ({ rows: [{ vault_enabled: false, vault_repo: null, vault_branch: "main" }] }) };
      const r = await vault.syncVault(mockPool);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "not_configured");
    } finally {
      if (saved !== undefined) process.env.VAULT_GITHUB_TOKEN = saved;
    }
  });

  it("returns vector_unavailable when configured but chunks table is missing", async () => {
    const savedTok = process.env.VAULT_GITHUB_TOKEN;
    const savedVoy = process.env.VOYAGE_API_KEY;
    process.env.VAULT_GITHUB_TOKEN = "ghp_test";
    process.env.VOYAGE_API_KEY = "pa-test";
    try {
      const mockPool = {
        query: async (sql) => {
          if (/vault_enabled/.test(sql)) return { rows: [{ vault_enabled: true, vault_repo: "me/vault", vault_branch: "main", vault_last_sha: null }] };
          if (/to_regclass/.test(sql)) return { rows: [{ t: null }] }; // chunks table absent
          return { rows: [] };
        },
      };
      const r = await vault.syncVault(mockPool);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "vector_unavailable");
    } finally {
      if (savedTok === undefined) delete process.env.VAULT_GITHUB_TOKEN; else process.env.VAULT_GITHUB_TOKEN = savedTok;
      if (savedVoy === undefined) delete process.env.VOYAGE_API_KEY; else process.env.VOYAGE_API_KEY = savedVoy;
    }
  });
});
