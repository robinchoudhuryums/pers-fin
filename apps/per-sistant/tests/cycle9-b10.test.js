// ============================================================================
// Cycle 9 Batch 10 (F8) — nodemailer 10 through a real SMTP conversation
// ============================================================================
// nodemailer went from 8 to 10 (two majors) to clear its advisories. Every
// other test stubs createTransport, so none of them would notice the library
// no longer talking SMTP the way the app asks it to. Here Send Now runs through
// the REAL emails route and the REAL nodemailer against a small SMTP server in
// this process: the transport options the app builds (host / port / secure /
// auth), the message it hands over (from, to, subject, text, html) and the
// stored attachments must arrive as sent.
// ============================================================================
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const express = require("express");
const supertest = require("supertest");

const config = require("../config");

// A minimal SMTP server: EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT.
// Records each delivered message; no TLS (the app sets secure only on 465).
function smtpSink({ rejectAuth = false } = {}) {
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => { /* the client hanging up mid-test is fine */ });
    let buf = "", inData = false, data = [];
    let msg = { auth: null, from: null, to: [] };
    sock.write("220 sink.test ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push({ ...msg, data: data.join("\r\n") });
            msg = { auth: msg.auth, from: null, to: [] };
            data = [];
            sock.write("250 2.0.0 queued\r\n");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith("EHLO") || up.startsWith("HELO")) sock.write("250-sink.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        else if (up.startsWith("AUTH PLAIN")) {
          if (rejectAuth) { sock.write("535 5.7.8 credentials rejected\r\n"); continue; }
          msg.auth = Buffer.from(line.slice("AUTH PLAIN ".length), "base64").toString("utf8").split("\0").slice(1);
          sock.write("235 2.7.0 ok\r\n");
        } else if (up.startsWith("MAIL FROM:")) { msg.from = line.slice(10).split(" ")[0]; sock.write("250 ok\r\n"); }
        else if (up.startsWith("RCPT TO:")) { msg.to.push(line.slice(8).split(" ")[0]); sock.write("250 ok\r\n"); }
        else if (up === "DATA") { inData = true; sock.write("354 end with .\r\n"); }
        else if (up === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else if (up === "RSET" || up === "NOOP") sock.write("250 ok\r\n");
        else sock.write("502 not implemented\r\n");
      }
    });
  });
  return {
    messages,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

// The emails router over a pool that holds one email and its attachments.
function emailApp({ email, attachments = [] }) {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (/SELECT \* FROM emails WHERE id = \$1/.test(sql)) return { rows: [email] };
      if (/FROM attachments WHERE entity_type = 'email'/.test(sql)) return { rows: attachments };
      if (/UPDATE emails SET status = 'sent'/.test(sql)) return { rows: [{ id: email.id }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(require("../routes/emails")({ pool, config, helpers: { fireWebhooks: async () => {}, sendSlackNotification: async () => {}, runAutomations: async () => {} } }));
  return { app, calls };
}

describe("F8 — Send Now delivers through SMTP on the installed nodemailer", () => {
  const saved = {};
  const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"];
  let origError;
  before(() => { for (const k of KEYS) saved[k] = process.env[k]; origError = console.error; });
  after(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    console.error = origError;
  });
  const smtpEnv = (port) => Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_USER: "mailer@example.com", SMTP_PASS: "app-password", SMTP_FROM: "me@example.com",
  });

  it("nodemailer is the version the lock file names, loaded through require()", () => {
    const nodemailer = require("nodemailer");
    assert.equal(typeof nodemailer.createTransport, "function");
    const [major] = require("fs").readFileSync(require.resolve("nodemailer/package.json"), "utf8").match(/"version":\s*"(\d+)/).slice(1).map(Number);
    assert.ok(major >= 10, "nodemailer " + major);
  });

  it("the message, its text and HTML parts and both stored attachments arrive as sent", async () => {
    const sink = smtpSink();
    smtpEnv(await sink.listen());
    try {
      const { app, calls } = emailApp({
        email: { id: 5, status: "draft", recipient_email: "friend@example.com", subject: "Dinner on Friday",
          body: "See you at seven.\nBring the map.", body_html: "<p>See you at <b>seven</b>.</p>" },
        attachments: [
          { id: 1, filename: "1-map.txt", original_name: "map.txt", mime_type: "text/plain", data: Buffer.from("turn left at the bakery") },
          { id: 2, filename: "2-menu.pdf", original_name: "menu.pdf", mime_type: "application/pdf", data: Buffer.from("%PDF-1.4 fake menu bytes") },
        ],
      });
      const res = await supertest(app).post("/api/emails/5/send");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { ok: true, message: "Email sent successfully." });

      assert.equal(sink.messages.length, 1, "exactly one message was delivered");
      const m = sink.messages[0];
      assert.deepEqual(m.auth, ["mailer@example.com", "app-password"], "the app's SMTP credentials were presented");
      assert.equal(m.from, "<me@example.com>");
      assert.deepEqual(m.to, ["<friend@example.com>"]);
      assert.match(m.data, /^Subject: Dinner on Friday$/m);
      assert.match(m.data, /^From: me@example\.com$/m);
      assert.match(m.data, /^To: friend@example\.com$/m);
      assert.match(m.data, /See you at seven\./);
      assert.match(m.data, /Bring the map\./);
      assert.match(m.data, /<p>See you at <b>seven<\/b>\.<\/p>/);
      // Each attachment: its name, its type and its bytes.
      assert.match(m.data, /Content-Type: text\/plain; name=map\.txt/);
      assert.match(m.data, /Content-Disposition: attachment; filename=map\.txt/);
      assert.match(m.data, /Content-Type: application\/pdf; name=menu\.pdf/);
      const body = m.data.replace(/\r\n/g, "");
      assert.ok(m.data.includes("turn left at the bakery") || body.includes(Buffer.from("turn left at the bakery").toString("base64")), "the text attachment's bytes");
      assert.ok(body.includes(Buffer.from("%PDF-1.4 fake menu bytes").toString("base64")), "the PDF's bytes, base64");
      // The row was claimed before the send and never reverted.
      assert.ok(calls.some((c) => /UPDATE emails SET status = 'sent'/.test(c.sql)));
      assert.ok(!calls.some((c) => /SET status = 'failed'/.test(c.sql)));
    } finally { await sink.close(); }
  });

  it("a plain-text email with no attachments is delivered too", async () => {
    const sink = smtpSink();
    smtpEnv(await sink.listen());
    try {
      const { app } = emailApp({ email: { id: 6, status: "scheduled", recipient_email: "a@example.org", subject: "Hi", body: "Just text." } });
      await supertest(app).post("/api/emails/6/send").expect(200);
      assert.equal(sink.messages.length, 1);
      assert.match(sink.messages[0].data, /Just text\./);
      assert.doesNotMatch(sink.messages[0].data, /Content-Disposition: attachment/);
    } finally { await sink.close(); }
  });

  it("a server that rejects the credentials marks the email failed with the reason", async () => {
    console.error = () => {};
    const sink = smtpSink({ rejectAuth: true });
    smtpEnv(await sink.listen());
    try {
      const { app, calls } = emailApp({ email: { id: 7, status: "draft", recipient_email: "a@example.org", subject: "Hi", body: "x" } });
      const res = await supertest(app).post("/api/emails/7/send");
      assert.equal(res.status, 500);
      assert.equal(sink.messages.length, 0, "nothing was delivered");
      const failed = calls.find((c) => /UPDATE emails SET status = 'failed'/.test(c.sql));
      assert.ok(failed, "the claimed row is put back as failed");
      assert.match(String(failed.params[0]), /535|credentials|auth/i, "with the SMTP reason");
    } finally { await sink.close(); console.error = origError; }
  });

  it("the scheduler builds its transport with the same options as Send Now", () => {
    const fs = require("fs"), path = require("path");
    const opts = /createTransport\(\{\s*host: (?:process\.env\.SMTP_HOST|smtpHost),\s*port: parseInt\(process\.env\.SMTP_PORT \|\| "587", 10\),\s*secure: process\.env\.SMTP_PORT === "465",\s*auth: \{ user: process\.env\.SMTP_USER, pass: process\.env\.SMTP_PASS \},\s*\}\)/;
    assert.match(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"), opts);
    assert.match(fs.readFileSync(path.join(__dirname, "..", "routes", "emails.js"), "utf8"), opts);
  });
});
