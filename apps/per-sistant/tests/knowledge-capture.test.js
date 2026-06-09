// ============================================================================
// Per-sistant — Capture-to-vault (Phase 3) tests
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const vault = require("../services/vault-sync");
const rag = require("../routes/rag");

describe("Capture — slugify", () => {
  it("lowercases, dashes, trims, and caps length", () => {
    assert.equal(vault.slugify("Car Insurance Policy!"), "car-insurance-policy");
    assert.equal(vault.slugify("  "), "note");
    assert.equal(vault.slugify("a".repeat(80)).length, 50);
  });
});

describe("Capture — buildCaptureMarkdown", () => {
  it("builds a note with title + tags", () => {
    const md = vault.buildCaptureMarkdown({ type: "note", title: "Trip ideas", tags: ["travel"], body: "Visit Rome." });
    assert.match(md, /^---\ntitle: Trip ideas\ntags: \[travel\]\n---\n\nVisit Rome\.$/);
  });
  it("builds a fact file with entity + flat fields", () => {
    const md = vault.buildCaptureMarkdown({ type: "fact", entity: "Car Insurance", fields: { provider: "Geico", deductible: "$1000" }, tags: [] });
    assert.match(md, /type: fact/);
    assert.match(md, /entity: Car Insurance/);
    assert.match(md, /provider: Geico/);
    assert.match(md, /deductible: \$1000/); // unquoted — no YAML-breaking chars
  });
  it("quotes YAML values containing special chars", () => {
    const md = vault.buildCaptureMarkdown({ type: "note", title: "Re: lunch", body: "x" });
    assert.match(md, /title: "Re: lunch"/);
  });
});

describe("Capture — commitVaultFile", () => {
  it("PUTs base64 content to the contents API", async () => {
    let captured;
    const fetchImpl = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, json: async () => ({ content: { html_url: "https://github.com/x/y/blob/main/captures/a.md" } }) };
    };
    const out = await vault.commitVaultFile("me/vault", "main", "captures/a.md", "hello", "msg", { token: "tok", fetchImpl });
    assert.match(captured.url, /\/repos\/me\/vault\/contents\/captures\/a\.md$/);
    assert.equal(captured.opts.method, "PUT");
    const body = JSON.parse(captured.opts.body);
    assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "hello");
    assert.equal(body.branch, "main");
    assert.equal(out.content.html_url, "https://github.com/x/y/blob/main/captures/a.md");
  });
  it("throws on a non-ok response", async () => {
    const fetchImpl = async () => ({ ok: false, status: 422, text: async () => "exists" });
    await assert.rejects(() => vault.commitVaultFile("me/vault", "main", "a.md", "x", "m", { token: "t", fetchImpl }));
  });
});

describe("Capture — POST /api/rag/capture guards", () => {
  function makeApp(mockPool) {
    const app = express();
    app.use(express.json());
    app.use(rag({ pool: mockPool }));
    return app;
  }
  const pool = { query: async () => ({ rows: [{ vault_repo: "me/vault", vault_branch: "main" }] }) };

  it("400 without text", async () => {
    await supertest(makeApp(pool)).post("/api/rag/capture").send({}).expect(400);
  });

  it("400 when no write token is configured", async () => {
    const saved = process.env.VAULT_GITHUB_WRITE_TOKEN;
    delete process.env.VAULT_GITHUB_WRITE_TOKEN;
    try {
      const res = await supertest(makeApp(pool)).post("/api/rag/capture").send({ text: "hi" }).expect(400);
      assert.match(res.body.error, /VAULT_GITHUB_WRITE_TOKEN/);
    } finally {
      if (saved !== undefined) process.env.VAULT_GITHUB_WRITE_TOKEN = saved;
    }
  });
});
