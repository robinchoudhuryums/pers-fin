// ============================================================================
// Per-sistant — Sept 2026 broad-scan Batch 1 regression tests
// ============================================================================
//   PD-1  "Save Draft" stays a draft: POST /api/emails honors an explicit
//         client status (behavioral) and the page sends status:'draft'
//   PUI-1 datetime-local fill is local-time, so open+save never shifts a
//         scheduled email / note reminder (behavioral, TZ-independent)
//   PUI-2 "Send now" always persists the form before sending (source)
//   KR-*  Knowledge privacy fixes — see the "KR-" describes below
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");

function emailsApp(onInsert) {
  const mockPool = {
    query: async (sql, params) => {
      if (/INSERT INTO emails/.test(sql)) { onInsert(params); return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(require("../routes/emails")({ pool: mockPool, config: require("../config"), helpers: { runAutomations: async () => {} } })); // PD-6: POST runs email_created automations
  return app;
}
const baseEmail = { recipient_email: "a@b.com", subject: "s", body: "b", scheduled_at: "2026-10-01T13:00:00.000Z" };

// ---------------------------------------------------------------------------
// PD-1 — Save Draft must not schedule (and so send) the email
// ---------------------------------------------------------------------------
describe("PD-1 — POST /api/emails honors an explicit draft status", () => {
  it("status:'draft' with a schedule time stays a draft (the cron won't send it)", async () => {
    let params;
    await supertest(emailsApp((p) => { params = p; })).post("/api/emails").send({ ...baseEmail, status: "draft" }).expect(200);
    assert.equal(params[5], "draft");
    assert.equal(params[6], baseEmail.scheduled_at, "the chosen time is kept for later scheduling");
  });

  it("no status → still inferred from scheduled_at (backward compatible)", async () => {
    let params;
    await supertest(emailsApp((p) => { params = p; })).post("/api/emails").send(baseEmail).expect(200);
    assert.equal(params[5], "scheduled");
  });

  it("rejects non-creatable statuses and 'scheduled' without a time", async () => {
    const app = emailsApp(() => assert.fail("must not insert"));
    await supertest(app).post("/api/emails").send({ ...baseEmail, status: "sent" }).expect(400);
    const { scheduled_at, ...noTime } = baseEmail;
    await supertest(app).post("/api/emails").send({ ...noTime, status: "scheduled" }).expect(400);
  });

  it("the page's saveEmail sends status:'draft'", () => {
    const src = fs.readFileSync(path.join(ROOT, "pages/emails.js"), "utf8");
    const fn = src.slice(src.indexOf("async function saveEmail"), src.indexOf("async function saveAndSchedule"));
    assert.match(fn, /data\.status = 'draft';/);
  });
});

// ---------------------------------------------------------------------------
// PUI-2 — Send now persists edits first
// ---------------------------------------------------------------------------
describe("PUI-2 — Send now saves the form before sending", () => {
  it("sendNow always awaits saveEmail() (not only for new emails)", () => {
    const src = fs.readFileSync(path.join(ROOT, "pages/emails.js"), "utf8");
    const fn = src.slice(src.indexOf("async function sendNow"), src.indexOf("async function deleteEmail"));
    assert.match(fn, /var id = await saveEmail\(\);/);
    assert.doesNotMatch(fn, /if \(!id\) \{ id = await saveEmail\(\); \}/, "old save-only-when-new path is gone");
  });
});

// ---------------------------------------------------------------------------
// PUI-1 — local datetime-local fill
// ---------------------------------------------------------------------------
describe("PUI-1 — datetime-local fill round-trips without a UTC shift", () => {
  const bundle = require("../views/js");
  const start = bundle.indexOf("function toLocalDatetimeInput");
  const end = bundle.indexOf("\n}\n", start) + 2;
  const fnSrc = bundle.slice(start, end);
  // eslint-disable-next-line no-new-func
  const toLocalDatetimeInput = new Function(fnSrc + "; return toLocalDatetimeInput;")();

  it("open + save (new Date(localValue).toISOString()) reproduces the stored instant", () => {
    for (const iso of ["2026-09-27T19:30:00.000Z", "2026-01-01T00:05:00.000Z", "2026-03-08T10:00:00.000Z"]) {
      const filled = toLocalDatetimeInput(iso);
      assert.match(filled, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      assert.equal(new Date(filled).toISOString(), iso, `round-trip for ${iso} (TZ=${process.env.TZ || "system"})`);
    }
  });

  it("empty / invalid input yields an empty field", () => {
    assert.equal(toLocalDatetimeInput(null), "");
    assert.equal(toLocalDatetimeInput("not a date"), "");
  });

  it("both edit forms use the helper (no raw iso.slice(0,16) fills remain)", () => {
    for (const f of ["pages/emails.js", "pages/notes.js"]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      assert.doesNotMatch(src, /_at\.slice\(0,\s*16\)/, f);
      assert.match(src, /toLocalDatetimeInput\(/, f);
    }
  });

  it("the EMITTED shared bundle still parses (template-literal gotcha)", () => {
    const tmp = path.join(os.tmpdir(), `ps-shared-js-${process.pid}.js`);
    fs.writeFileSync(tmp, bundle);
    try { execFileSync(process.execPath, ["--check", tmp]); } finally { fs.unlinkSync(tmp); }
  });
});

// ---------------------------------------------------------------------------
// KR-2 — frontmatter sensitivity fails CLOSED (INV-27)
// ---------------------------------------------------------------------------
describe("KR-2 — sensitivity parsing fails closed", () => {
  const vault = require("../services/vault-sync");
  const level = (fm) => vault.resolveSensitivity(vault.parseFrontmatter(`---\n${fm}\n---\nbody`).meta);

  const cases = [
    ["sensitivity: secret # never share", "secret"],     // trailing YAML comment
    ['sensitivity: "secret" # offline only', "secret"],  // quoted + comment
    ["sensitivity:\n  - secret", "secret"],              // Obsidian block list
    ["sensitivity: [private]", "private"],               // flow list
    ["private: yes", "private"],                         // YAML 1.1 truthy
    ['private: "true"', "private"],                      // quoted boolean
    ["embed: no", "private"],                            // YAML 1.1 falsy
    ["embed: off", "private"],
    ["sensitivity: secrets", "private"],                 // typo → fail closed
    ["embed: maybe", "private"],                         // unrecognized flag → fail closed
    ["sensitivity: normal\nprivate: true", "private"],   // most restrictive wins
    ["sensitivity: normal", "normal"],
    ["embed: true\nprivate: no", "normal"],
    ["title: Plain note", "normal"],
  ];
  for (const [fm, want] of cases) {
    it(`${JSON.stringify(fm)} → ${want}`, () => assert.equal(level(fm), want));
  }

  it("comment stripping keeps '#' that isn't a YAML comment", () => {
    const { meta } = vault.parseFrontmatter('---\nsource: https://x.com/a#frag\nlang: C#\nnote: "call #2" # c\n---\nx');
    assert.equal(meta.source, "https://x.com/a#frag");
    assert.equal(meta.lang, "C#");
    assert.equal(meta.note, "call #2");
  });

  it("block lists parse for any key (e.g. tags) and don't swallow the next key", () => {
    const { meta } = vault.parseFrontmatter("---\ntags:\n  - a\n  - b # x\ntitle: T\n---\nx");
    assert.deepEqual(meta.tags, ["a", "b"]);
    assert.equal(meta.title, "T");
  });
});

// ---------------------------------------------------------------------------
// KR-1 — full vault sync sweeps deleted files; unreliable diffs fall back
// ---------------------------------------------------------------------------
describe("KR-1 — vault sync mark-and-sweep", () => {
  const vault = require("../services/vault-sync");

  function gh(routes) {
    return async (url) => {
      const u = String(url).replace("https://api.github.com", "");
      for (const [re, body] of routes) {
        if (re.test(u)) {
          if (typeof body === "number") return { ok: false, status: body, text: async () => "gone", json: async () => ({}) };
          return { ok: true, status: 200, json: async () => body, text: async () => "" };
        }
      }
      throw new Error("unexpected GitHub call " + u);
    };
  }
  const privateFile = { encoding: "base64", content: Buffer.from("---\nsensitivity: private\n---\nbody").toString("base64") };

  function mockPool({ lastSha = null, indexed = [] } = {}) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/vault_enabled/.test(sql)) return { rows: [{ vault_enabled: true, vault_repo: "me/vault", vault_branch: "main", vault_last_sha: lastSha }] };
        if (/to_regclass/.test(sql)) return { rows: [{ t: "chunks" }] };
        if (/SELECT source_ref FROM documents/.test(sql)) return { rows: indexed.map((source_ref) => ({ source_ref })) };
        if (/INSERT INTO documents/.test(sql)) return { rows: [{ id: 1 }] };
        if (/UPDATE documents SET deleted_at/.test(sql)) return { rows: [{ id: 9 }] };
        return { rows: [] };
      },
    };
  }
  const removedRefs = (pool) => pool.calls.filter((c) => /UPDATE documents SET deleted_at/.test(c.sql)).map((c) => c.params[0]);
  const clearedFacts = (pool) => pool.calls.filter((c) => /DELETE FROM facts/.test(c.sql)).map((c) => c.params[0]);

  async function withEnv(fn) {
    const saved = { t: process.env.VAULT_GITHUB_TOKEN, v: process.env.VOYAGE_API_KEY };
    process.env.VAULT_GITHUB_TOKEN = "ghp_test";
    process.env.VOYAGE_API_KEY = "pa-test";
    try { return await fn(); } finally {
      if (saved.t === undefined) delete process.env.VAULT_GITHUB_TOKEN; else process.env.VAULT_GITHUB_TOKEN = saved.t;
      if (saved.v === undefined) delete process.env.VOYAGE_API_KEY; else process.env.VOYAGE_API_KEY = saved.v;
    }
  }

  it("full sync removes indexed docs/facts whose file no longer exists in the tree", () => withEnv(async () => {
    const pool = mockPool({ indexed: ["a.md", "deleted.md", "old-fact.md"] });
    const r = await vault.syncVault(pool, {
      full: true,
      fetchImpl: gh([
        [/\/branches\/main$/, { commit: { sha: "HEAD1" } }],
        [/\/git\/trees\/HEAD1/, { tree: [{ type: "blob", path: "a.md" }], truncated: false }],
        [/\/contents\/a\.md/, privateFile],
      ]),
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.removed, 2);
    assert.deepEqual(removedRefs(pool).sort(), ["deleted.md", "old-fact.md"]);
    assert.ok(clearedFacts(pool).includes("old-fact.md"), "stale fact rows are deleted too");
    assert.ok(!removedRefs(pool).includes("a.md"), "a file still in the tree is kept");
  }));

  it("a TRUNCATED tree never sweeps (absence ≠ deletion)", () => withEnv(async () => {
    const pool = mockPool({ indexed: ["a.md", "maybe-beyond-truncation.md"] });
    const r = await vault.syncVault(pool, {
      full: true,
      fetchImpl: gh([
        [/\/branches\/main$/, { commit: { sha: "HEAD1" } }],
        [/\/git\/trees\/HEAD1/, { tree: [{ type: "blob", path: "a.md" }], truncated: true }],
        [/\/contents\/a\.md/, privateFile],
      ]),
    });
    assert.equal(r.ok, true);
    assert.equal(r.removed, 0);
    assert.deepEqual(removedRefs(pool), []);
  }));

  it("a malformed tree response (no tree array) is treated as truncated — never sweeps everything", () => withEnv(async () => {
    const pool = mockPool({ indexed: ["a.md", "b.md"] });
    const r = await vault.syncVault(pool, {
      full: true,
      fetchImpl: gh([
        [/\/branches\/main$/, { commit: { sha: "HEAD1" } }],
        [/\/git\/trees\/HEAD1/, { message: "unexpected" }],
      ]),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(removedRefs(pool), []);
  }));

  it("incremental sync falls back to full + sweep when the base commit is gone (compare 404)", () => withEnv(async () => {
    const pool = mockPool({ lastSha: "OLD", indexed: ["a.md", "deleted.md"] });
    const r = await vault.syncVault(pool, {
      fetchImpl: gh([
        [/\/branches\/main$/, { commit: { sha: "HEAD1" } }],
        [/\/compare\/OLD\.\.\.HEAD1/, 404],
        [/\/git\/trees\/HEAD1/, { tree: [{ type: "blob", path: "a.md" }] }],
        [/\/contents\/a\.md/, privateFile],
      ]),
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(removedRefs(pool), ["deleted.md"]);
  }));

  it("incremental sync falls back to full when GitHub caps the compare file list (300)", () => withEnv(async () => {
    const pool = mockPool({ lastSha: "OLD", indexed: ["a.md", "deleted.md"] });
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.md`, status: "modified" }));
    const r = await vault.syncVault(pool, {
      fetchImpl: gh([
        [/\/branches\/main$/, { commit: { sha: "HEAD1" } }],
        [/\/compare\/OLD\.\.\.HEAD1/, { files }],
        [/\/git\/trees\/HEAD1/, { tree: [{ type: "blob", path: "a.md" }] }],
        [/\/contents\/a\.md/, privateFile],
      ]),
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.changed, 1, "re-walked the tree instead of trusting the capped diff");
    assert.deepEqual(removedRefs(pool), ["deleted.md"]);
  }));

  it("other compare errors still fail the sync (no silent fallback on auth/5xx)", () => withEnv(async () => {
    const pool = mockPool({ lastSha: "OLD" });
    const r = await vault.syncVault(pool, {
      fetchImpl: gh([
        [/\/branches\/main$/, { commit: { sha: "HEAD1" } }],
        [/\/compare\/OLD\.\.\.HEAD1/, 401],
      ]),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /GitHub 401/);
  }));

  it("PATCH /api/settings resets vault_last_sha in ONE assignment when repo/branch change", async () => {
    let captured;
    const pool = { query: async (sql, params) => { captured = { sql, params }; return { rows: [{}] }; } };
    const app = express();
    app.use(express.json());
    app.use(require("../routes/settings")({ pool, config: require("../config") }));
    await supertest(app).patch("/api/settings").send({ vault_repo: "me/new-vault", vault_branch: "dev" }).expect(200);
    assert.equal((captured.sql.match(/vault_last_sha =/g) || []).length, 1, "SET must not name the column twice");
    assert.match(captured.sql, /vault_last_sha = CASE WHEN vault_repo IS DISTINCT FROM \$\d+::text OR vault_branch IS DISTINCT FROM \$\d+::text THEN NULL ELSE vault_last_sha END/);
  });
});

// ---------------------------------------------------------------------------
// KR-6 — hard-deleted notes are never retrieved and their chunks are purged
// ---------------------------------------------------------------------------
describe("KR-6 — hard-deleted notes leave Knowledge retrieval", () => {
  it("VECTOR_SQL requires the joined source row to EXIST (LEFT JOIN NULL ≠ not-deleted)", () => {
    const src = fs.readFileSync(path.join(ROOT, "routes/rag.js"), "utf8");
    assert.match(src, /c\.source_kind = 'note' AND n\.id IS NOT NULL AND n\.deleted_at IS NULL/);
    assert.match(src, /c\.source_kind = 'document' AND d\.id IS NOT NULL AND d\.deleted_at IS NULL AND d\.sensitivity = 'normal'/);
  });

  function trashApp(handler) {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); } };
    const app = express();
    app.use(express.json());
    app.use(require("../routes/trash")({ pool }));
    return { app, calls };
  }
  const purged = (calls) => calls.filter((c) => /DELETE FROM (chunks|embed_state) WHERE source_kind = 'note'/.test(c.sql));

  it("permanent delete of a note purges its chunks + embed_state", async () => {
    const { app, calls } = trashApp((sql) => (/DELETE FROM notes/.test(sql) ? { rows: [{ id: 5 }] } : { rows: [] }));
    await supertest(app).delete("/api/trash/note/5").expect(200);
    const p = purged(calls);
    assert.equal(p.length, 2);
    for (const c of p) assert.deepEqual(c.params, [[5]]);
  });

  it("emptying the trash purges chunks for every deleted note", async () => {
    const { app, calls } = trashApp((sql) => (/DELETE FROM notes/.test(sql) ? { rows: [{ id: 5 }, { id: 8 }] } : { rows: [] }));
    await supertest(app).post("/api/trash/empty").expect(200);
    const p = purged(calls);
    assert.equal(p.length, 2);
    for (const c of p) assert.deepEqual(c.params, [[5, 8]]);
  });

  it("non-note deletes don't touch chunks; a purge failure doesn't fail the delete", async () => {
    const t1 = trashApp((sql) => (/DELETE FROM todos/.test(sql) ? { rows: [{ id: 1 }] } : { rows: [] }));
    await supertest(t1.app).delete("/api/trash/todo/1").expect(200);
    assert.equal(purged(t1.calls).length, 0);
    const t2 = trashApp((sql) => {
      if (/DELETE FROM notes/.test(sql)) return { rows: [{ id: 5 }] };
      if (/chunks|embed_state/.test(sql)) throw new Error("relation \"chunks\" does not exist");
      return { rows: [] };
    });
    await supertest(t2.app).delete("/api/trash/note/5").expect(200);
  });
});
