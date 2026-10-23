// ============================================================================
// Roadmap T1.5 — Batch C (Per-sistant quick wins)
// ============================================================================
//  C1  an email's attachments are sent with it (manual Send and the scheduler),
//      or the send fails with the reason — never sent without them
//  C2  a failed email shows its error in the Emails list with a Retry
//  C3  the AI routes answer 501 without ANTHROPIC_API_KEY (after their own
//      400s, before any model call); the Review page skips its AI calls
// The real-Postgres half is tests/contract/persistent-batchc.contract.test.js.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const config = require("../config");
const db = require("../db");
const attachments = require("../routes/attachments");

let realDbQuery = null;
function stubDb(fn) { if (!realDbQuery) realDbQuery = db.pool.query; db.pool.query = fn; }
afterEach(() => { if (realDbQuery) { db.pool.query = realDbQuery; realDbQuery = null; } });

function poolWith(rows) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } };
}

// ---------------------------------------------------------------------------
describe("C1 — loadEmailAttachments", () => {
  it("returns every stored attachment as a nodemailer attachment, in id order", async () => {
    const pool = poolWith([
      { id: 1, filename: "1-a.pdf", original_name: "a.pdf", mime_type: "application/pdf", data: Buffer.from("AAA") },
      { id: 2, filename: "2-b.txt", original_name: "b.txt", mime_type: null, data: Buffer.from("BB") },
    ]);
    const out = await attachments.loadEmailAttachments(pool, 42);
    assert.deepEqual(out.map((a) => [a.filename, a.contentType, a.content.toString()]),
      [["a.pdf", "application/pdf", "AAA"], ["b.txt", "application/octet-stream", "BB"]]);
    assert.match(pool.calls[0].sql, /entity_type = 'email' AND entity_id = \$1 ORDER BY id/);
    assert.deepEqual(pool.calls[0].params, [42]);
  });

  it("reads a legacy row's file from disk, and refuses one whose file is gone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "att-"));
    fs.writeFileSync(path.join(dir, "9-old.txt"), "legacy");
    const ok = await attachments.loadEmailAttachments(
      poolWith([{ id: 9, filename: "9-old.txt", original_name: "old.txt", mime_type: "text/plain", data: null }]), 1, { dir });
    assert.equal(ok[0].content.toString(), "legacy");
    await assert.rejects(
      attachments.loadEmailAttachments(poolWith([{ id: 3, filename: "3-gone.txt", original_name: "gone.txt", data: null }]), 1, { dir }),
      (err) => err.code === "ATTACHMENT_MISSING" && /"gone\.txt" is no longer available/.test(err.message));
  });

  it("refuses a total over the cap, and an email with none sends none", async () => {
    const big = { id: 1, filename: "x", original_name: "x.bin", mime_type: "x/y", data: Buffer.alloc(6) };
    await assert.rejects(attachments.loadEmailAttachments(poolWith([big, { ...big, id: 2 }]), 1, { maxBytes: 10 }),
      (err) => err.code === "ATTACHMENT_TOO_LARGE");
    assert.deepEqual(await attachments.loadEmailAttachments(poolWith([]), 1), []);
    assert.equal(attachments.MAX_EMAIL_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  });

  it("both senders load them: Send Now before its claim, the scheduler inside its try", () => {
    const emails = fs.readFileSync(path.join(__dirname, "..", "routes", "emails.js"), "utf8");
    const send = emails.slice(emails.indexOf('router.post("/api/emails/:id/send"'));
    assert.ok(send.indexOf("loadEmailAttachments(pool, email.id)") < send.indexOf("UPDATE emails SET status = 'sent'"),
      "loaded before the row is claimed, so a refusal leaves the email unsent");
    assert.match(send, /if \(err\.code === "ATTACHMENT_MISSING" \|\| err\.code === "ATTACHMENT_TOO_LARGE"\) return res\.status\(400\)/);
    assert.match(send, /if \(attachments\.length\) mail\.attachments = attachments;/);
    const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const sched = server.slice(server.indexOf("async function processScheduledEmails()"), server.indexOf("// Lifecycle"));
    assert.ok(sched.indexOf("loadEmailAttachments(pool, email.id)") > sched.indexOf("try {\n        const transporter"),
      "inside the try, so a refusal marks the row failed with the reason");
    assert.match(sched, /if \(attachments\.length\) mail\.attachments = attachments;/);
  });

  it("Send Now answers 400 with the reason and doesn't claim the email when an attachment is missing", async () => {
    process.env.SMTP_HOST = process.env.SMTP_HOST || "smtp.invalid";
    const calls = [];
    const pool = {
      query: async (sql, params) => {
        calls.push(sql);
        if (/SELECT \* FROM emails WHERE id = \$1/.test(sql)) return { rows: [{ id: 5, status: "draft", recipient_email: "a@example.com", subject: "s", body: "b" }] };
        if (/FROM attachments WHERE entity_type = 'email'/.test(sql)) return { rows: [{ id: 1, filename: "1-gone.pdf", original_name: "gone.pdf", data: null }] };
        return { rows: [], rowCount: 0 };
      },
    };
    const app = express();
    app.use(express.json());
    app.use(require("../routes/emails")({ pool, config, helpers: { fireWebhooks: async () => {}, sendSlackNotification: async () => {}, runAutomations: async () => {} } }));
    const r = await supertest(app).post("/api/emails/5/send").expect(400);
    assert.match(r.body.error, /"gone\.pdf" is no longer available/);
    assert.ok(!calls.some((s) => /UPDATE emails SET status = 'sent'/.test(s)), "not claimed");
  });
});

// ---------------------------------------------------------------------------
describe("C2 — failed emails show their error and a Retry", () => {
  let html = "";
  require("../pages/emails")()({}, { send: (h) => { html = h; } });

  it("a failed row carries its error and a single-flight Retry the click sweep skips", () => {
    assert.ok(html.includes("e.status==='failed'?'<div class=\"email-error\""));
    assert.ok(html.includes("Not sent: '+esc(e.error_message||'unknown error')"));
    assert.ok(html.includes("data-action=\"retry-email\" data-id=\"'+e.id+'\" data-e2e-skip"), "Retry sends real mail — the e2e sweep must not press it");
    assert.match(html, /async function retryEmail\(id, btn\) \{\s*return withPending\(btn, 'retry-email-'\+id,/);
    assert.match(html, /writeOk\(await tryFetch\('\/api\/emails\/'\+id\+'\/send', \{method:'POST'\}\), 'Could not send the email'\)/);
    assert.match(html, /else if\(act==='retry-email'\)retryEmail\(id, btn\);/);
  });

  it("the emitted page script parses", () => {
    const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/g).map((b) => b.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
    // eslint-disable-next-line no-new-func
    for (const js of scripts) if (js.trim()) new Function(js);
  });
});

// ---------------------------------------------------------------------------
describe("C3 — AI routes answer 501 without a key", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  function aiApp() {
    stubDb(async () => ({ rows: [{ model: "haiku" }] }));
    const app = express();
    app.use(express.json());
    app.use(require("../routes/ai")({ pool: { query: async () => ({ rows: [] }) } }));
    return app;
  }

  it("each model-calling route answers 501 with ai_unavailable (inputs valid)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const app = aiApp();
      const cases = [
        ["post", "/api/ai/draft-email", { prompt: "x" }],
        ["post", "/api/ai/task-breakdown", { title: "x" }],
        ["post", "/api/ai/parse-todo", { input: "x" }],
        ["post", "/api/ai/review-summary", { stats: { tasks_completed: 1 } }],
        ["post", "/api/ai/adjust-tone", { body: "x", tone: "shorter" }],
        ["get", "/api/ai/daily-briefing", null],
        ["post", "/api/ai/suggest-tags", { content: "x" }],
      ];
      for (const [method, url, body] of cases) {
        const req = supertest(app)[method](url);
        const r = await (body ? req.send(body) : req);
        assert.equal(r.status, 501, url);
        assert.equal(r.body.ai_unavailable, true, url);
        assert.match(r.body.error, /ANTHROPIC_API_KEY/, url);
      }
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("their own 400s (missing input) still come first", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await supertest(aiApp()).post("/api/ai/review-summary").send({}).expect(400);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("the Review page asks /api/ai/models first and skips the AI calls when unavailable", () => {
    let html = "";
    require("../pages/review")()({}, { send: (h) => { html = h; } });
    const gate = html.indexOf("if (!ai.available) return;");
    assert.ok(gate > 0);
    assert.ok(html.indexOf("fetch('/api/ai/models')") < gate);
    assert.ok(gate < html.indexOf("fetch('/api/ai/review-summary'"));
    assert.ok(gate < html.lastIndexOf("fetch('/api/ai/query'"), "the page's theme call (the shared Ask popover has its own, earlier)");
  });

  it("the e2e page run no longer tolerates the review-summary 500", () => {
    const spec = fs.readFileSync(path.join(__dirname, "..", "..", "..", "e2e", "pages.spec.js"), "utf8");
    assert.doesNotMatch(spec, /review-summary\$\//);
  });
});
