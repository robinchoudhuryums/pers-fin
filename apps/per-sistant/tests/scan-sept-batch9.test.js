// ============================================================================
// Broad-scan (Sept 2026) Batch 9 — Per-sistant platform hardening
// ============================================================================
// PB-14  SSRF: CIDR check incl. IPv4-mapped IPv6, DNS resolution, no redirects
// PB-15  standalone auth lets Perfin's HMAC-signed webhook through
// PB-21  embedded "Log Out" ends the SHELL session
// ============================================================================

// Standalone auth on for PB-15 (read by config at require time).
process.env.SESSION_PIN = process.env.SESSION_PIN || "424242";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const dns = require("dns");
const express = require("express");
const supertest = require("supertest");

const config = require("../config");

// ---------------------------------------------------------------------------
describe("PB-14 — isValidWebhookUrl closes the IPv6 spellings", () => {
  const blocked = [
    "http://[::ffff:169.254.169.254]/latest/meta-data/", // normalizes to [::ffff:a9fe:a9fe]
    "http://[::ffff:a9fe:a9fe]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::]/", "http://[::1]/", "http://[::a9fe:a9fe]/",
    "http://[fd12::1]/", "http://[fe80::1]/", "http://[64:ff9b::a9fe:a9fe]/",
    "http://100.64.0.1/", "http://0.0.0.0/", "http://2130706433/", "http://0x7f.1/",
  ];
  for (const u of blocked) it("blocks " + u, () => assert.equal(config.isValidWebhookUrl(u), false));

  it("still allows public addresses and names", () => {
    for (const u of ["https://hooks.slack.com/x", "http://8.8.8.8/x", "http://[2606:4700::1111]/", "http://[::ffff:8.8.8.8]/"]) {
      assert.equal(config.isValidWebhookUrl(u), true, u);
    }
  });

  it("isPrivateAddress unwraps mapped IPv4 and rejects non-IPs", () => {
    assert.equal(config.isPrivateAddress("::ffff:192.168.1.5"), true);
    assert.equal(config.isPrivateAddress("::ffff:c0a8:105"), true);
    assert.equal(config.isPrivateAddress("1.1.1.1"), false);
    assert.equal(config.isPrivateAddress("not-an-ip"), true);
  });
});

describe("PB-14 — resolveSafeWebhookTarget checks what the name resolves to", () => {
  const realLookup = dns.promises.lookup;
  afterEach(() => { dns.promises.lookup = realLookup; });
  const fakeDns = (map) => { dns.promises.lookup = async (host) => { if (!(host in map)) throw new Error("ENOTFOUND"); return map[host]; }; };

  it("a public-looking name resolving to the metadata IP is rejected", async () => {
    fakeDns({ "evil.example": [{ address: "169.254.169.254", family: 4 }] });
    assert.equal(await config.resolveSafeWebhookTarget("https://evil.example/hook"), false);
  });

  it("ANY private address in the answer rejects it", async () => {
    fakeDns({ "mixed.example": [{ address: "93.184.216.34", family: 4 }, { address: "::ffff:7f00:1", family: 6 }] });
    assert.equal(await config.resolveSafeWebhookTarget("https://mixed.example/"), false);
  });

  it("public answers pass; DNS failure fails closed", async () => {
    fakeDns({ "ok.example": [{ address: "93.184.216.34", family: 4 }] });
    assert.equal(await config.resolveSafeWebhookTarget("https://ok.example/"), true);
    assert.equal(await config.resolveSafeWebhookTarget("https://nxdomain.example/"), false);
  });
});

describe("PB-14 — the send paths use the resolving check and never follow redirects", () => {
  const realLookup = dns.promises.lookup;
  const realFetch = global.fetch;
  const db = require("../db");
  const realQuery = db.pool.query;
  afterEach(() => { dns.promises.lookup = realLookup; global.fetch = realFetch; db.pool.query = realQuery; });

  it("sendWebhook: internal resolution → no request; public → redirect: 'manual'", async () => {
    const helpers = require("../helpers");
    const calls = [];
    global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: false, status: 302 }; };
    db.pool.query = async () => ({ rows: [] });
    dns.promises.lookup = async (host) => (host === "internal.example"
      ? [{ address: "10.1.2.3", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);

    const blocked = await helpers.sendWebhook({ id: 1, url: "https://internal.example/h", headers: {} }, { a: 1 });
    assert.equal(blocked.error, "url_failed_validation");
    assert.equal(calls.length, 0);

    const sent = await helpers.sendWebhook({ id: 2, url: "https://public.example/h", headers: {} }, { a: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.redirect, "manual");
    assert.equal(sent.status, 302, "a redirect is recorded, not followed");
  });

  it("sendSlackNotification resolves + sends with redirect: 'manual'", async () => {
    const helpers = require("../helpers");
    const calls = [];
    global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
    db.pool.query = async () => ({ rows: [{ slack_webhook_url: "https://hooks.example/x" }] });
    dns.promises.lookup = async () => [{ address: "169.254.169.254", family: 4 }];
    await helpers.sendSlackNotification("hi");
    assert.equal(calls.length, 0, "metadata-resolving Slack URL skipped");
    dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    await helpers.sendSlackNotification("hi");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.redirect, "manual");
  });
});

// ---------------------------------------------------------------------------
describe("PB-15 — standalone auth exempts the signed Perfin webhook", () => {
  const { requireAuth } = require("../middleware");
  function app() {
    const a = express();
    a.use(express.json());
    a.use(requireAuth);
    a.post("/api/perfin/webhook", (_req, res) => res.json({ reached: true }));
    a.get("/api/perfin/webhook", (_req, res) => res.json({ reached: true }));
    a.get("/api/todos", (_req, res) => res.json({ reached: true }));
    return a;
  }

  it("AUTH_SECRET is on for this file", () => assert.ok(config.AUTH_SECRET));

  it("POST /api/perfin/webhook reaches its HMAC-verifying receiver without a session", async () => {
    const res = await supertest(app()).post("/api/perfin/webhook").send({ event: "test" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { reached: true });
  });

  it("everything else still needs a session (incl. GET on the same path)", async () => {
    assert.equal((await supertest(app()).get("/api/todos")).status, 401);
    assert.equal((await supertest(app()).get("/api/perfin/webhook")).status, 401);
  });
});

// ---------------------------------------------------------------------------
describe("PB-21 — embedded Log Out ends the shell session", () => {
  const src = require("../pages/settings-script.js");
  function extract(name) {
    const i = src.indexOf("async function " + name + "(");
    let depth = 0;
    for (let k = src.indexOf("{", i); k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
    }
    return null;
  }
  async function run(bp) {
    const calls = [];
    const location = { origin: "https://app.example", href: "" };
    // eslint-disable-next-line no-new-func
    const logout = new Function("BP", "location", "fetch", extract("logout") + "\nreturn logout;")(
      bp, location, async (url, opts) => { calls.push({ url, opts }); return {}; });
    await logout();
    return { calls, href: location.href };
  }

  it("embedded → POST the ROOT /logout (absolute, so BASE_PATH isn't prefixed) → /login", async () => {
    const r = await run("/per-sistant");
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].url, "https://app.example/logout");
    assert.equal(r.calls[0].opts.method, "POST");
    assert.equal(r.href, "/login");
  });

  it("standalone keeps Per-sistant's own session logout", async () => {
    const r = await run("");
    assert.equal(r.calls[0].url, "/api/logout");
    assert.equal(r.href, "/login");
  });

  it("the Session section renders when embedded even without a per-app secret", async () => {
    const page = require("../pages/settings")(null);
    const html = await new Promise((resolve) => {
      page({ app: { get: (k) => k === "embedded" } }, { locals: {}, send: resolve });
    });
    assert.match(html, /id="logout-btn"/);
    const standaloneNoAuth = await new Promise((resolve) => {
      page({ app: { get: () => false } }, { locals: {}, send: resolve });
    });
    assert.doesNotMatch(standaloneNoAuth, /id="logout-btn"/);
  });
});
