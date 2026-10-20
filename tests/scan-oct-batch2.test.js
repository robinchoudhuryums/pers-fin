// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 2 — broken pages & dead channels
// ============================================================================
// F74   Web Push reads JSONB subscription keys as an object (it JSON.parse'd an
//       object, so no push was ever delivered and dead subs were never pruned)
// F87   the Rent page's utility row assigns its markup (page died otherwise)
// F88   /accounts/:id/history renders (nav needs activePage)
// F89   a sixth toast no longer spins forever
// F90   the nav's load-time calls wait for perfin-shared.js
// F92   offline page: no inline handlers; the SW serves it with a <base>
// F93   the nav logo mask resolves under the /perfin mount
// (F60 — insight feedback SQL — is pinned on real Postgres in
//  tests/contract/sync-ai.contract.test.js; F137 is e2e/pages.spec.js.)
// ============================================================================

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ---------------------------------------------------------------------------
describe("F74 — Web Push delivers to JSONB-stored subscriptions", () => {
  const sent = [];
  let notifications, dbModule, origQuery, origLoad;
  const subObject = { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } };
  const deadObject = { endpoint: "https://push.example/gone", keys: { p256dh: "k", auth: "a" } };
  const deleted = [];

  before(() => {
    process.env.VAPID_PUBLIC_KEY = "test-public";
    process.env.VAPID_PRIVATE_KEY = "test-private";
    origLoad = Module._load;
    Module._load = function (request) {
      if (request === "web-push") {
        return {
          setVapidDetails() {},
          async sendNotification(sub, payload) {
            if (typeof sub !== "object" || !sub.endpoint) throw new Error("not a subscription object");
            if (sub.endpoint.endsWith("/gone")) { const e = new Error("gone"); e.statusCode = 410; throw e; }
            sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
          },
        };
      }
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve("../teller/routes/notifications")];
    notifications = require("../teller/routes/notifications");
    dbModule = require("../teller/services/database");
    origQuery = dbModule.pool.query;
    // node-pg returns a JSONB column as an already-parsed OBJECT.
    dbModule.pool.query = async (sql, params) => {
      if (/SELECT endpoint, keys FROM push_subscriptions/.test(sql)) {
        return { rows: [{ endpoint: subObject.endpoint, keys: subObject }, { endpoint: deadObject.endpoint, keys: deadObject }] };
      }
      if (/DELETE FROM push_subscriptions/.test(sql)) { deleted.push(params[0]); return { rows: [] }; }
      return { rows: [] };
    };
  });
  after(() => {
    Module._load = origLoad;
    dbModule.pool.query = origQuery;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete require.cache[require.resolve("../teller/routes/notifications")];
  });

  it("sendToAll pushes to an object-valued subscription and prunes a 410", async () => {
    const out = await notifications.sendToAll({ title: "Budget exceeded", body: "Dining", tag: "budget-x" });
    assert.equal(out.sent, 1);
    assert.equal(out.failed, 1);
    assert.equal(sent[0].endpoint, subObject.endpoint);
    assert.equal(sent[0].payload.title, "Budget exceeded");
    assert.deepEqual(deleted, [deadObject.endpoint]);
  });

  it("POST /api/notifications/test reports the delivery", async () => {
    sent.length = 0;
    const app = express();
    app.use(express.json());
    app.use(notifications);
    const r = await supertest(app).post("/api/notifications/test").expect(200);
    assert.equal(r.body.sent, 1);
    assert.equal(sent.length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("F89 — the toast stack caps at five without looping", () => {
  // Minimal DOM: enough for removeToast/showMsg (children, classList,
  // appendChild/removeChild, first/lastElementChild).
  function el(tag) {
    const node = {
      tagName: tag, children: [], parentNode: null, attrs: {}, _listeners: {}, textContent: "", id: "",
      classList: {
        set: new Set(),
        add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); },
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(t, fn) { this._listeners[t] = fn; },
      appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
      removeChild(child) { node.children.splice(node.children.indexOf(child), 1); child.parentNode = null; return child; },
      get firstElementChild() { return node.children[0] || null; },
      get lastElementChild() { return node.children[node.children.length - 1] || null; },
    };
    Object.defineProperty(node, "className", { set(v) { v.split(" ").forEach(c => c && node.classList.add(c)); } });
    return node;
  }

  it("eight distinct messages leave five live toasts and return", () => {
    const src = read("teller", "public", "perfin-shared.js");
    const start = src.indexOf("function removeToast(el)");
    const end = src.indexOf("// --- Button loading state ---");
    assert.ok(start > 0 && end > start);
    const body = el("body");
    const byId = {};
    const document = {
      body,
      createElement: (t) => el(t),
      getElementById: (id) => byId[id] || null,
    };
    const origAppend = body.appendChild;
    body.appendChild = (child) => { if (child.id) byId[child.id] = child; return origAppend(child); };
    const timers = [];
    const ctx = vm.createContext({ document, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
    // The calls run INSIDE the vm with a timeout: before the fix the sixth
    // toast spun forever, and a regression must fail rather than hang.
    vm.runInContext(src.slice(start, end) +
      "\nfor (var n = 1; n <= 8; n++) showMsg('message ' + n, true);", ctx, { timeout: 2000 });
    const stack = byId["toast-stack"];
    const live = stack.children.filter(c => !c.classList.contains("toast-leaving"));
    assert.equal(live.length, 5);
    assert.deepEqual(live.map(c => c.textContent), ["message 4", "message 5", "message 6", "message 7", "message 8"]);
  });
});

// ---------------------------------------------------------------------------
describe("F87 / F88 / F90 / F93 — page templates", () => {
  const ejs = require("ejs");
  const render = (view, locals) => new Promise((resolve, reject) =>
    ejs.renderFile(path.join(ROOT, "teller", "views", view), { nonce: "n", v: "1", ...locals }, (e, h) => e ? reject(e) : resolve(h)));

  it("F88: account-history renders standalone and under /perfin, as ONE document", async () => {
    for (const basePath of ["", "/perfin"]) {
      const html = await render("account-history.ejs", { basePath });
      assert.equal((html.match(/<html/g) || []).length, 1);
      assert.equal((html.match(/<body/g) || []).length, 1);
      assert.match(html, /id="account-title"/);
      assert.match(html, /class="active"[^>]*>|>Dashboard</);
    }
  });

  it("F87: utilRow assigns the row markup before querying it", () => {
    const src = read("teller", "views", "housing.ejs");
    const fn = src.slice(src.indexOf("function utilRow(u)"), src.indexOf("function fillConfig(cfg)"));
    assert.match(fn, /div\.innerHTML =\s*\n\s*'<input class="hz-in hz-u-label"/);
    assert.ok(fn.indexOf("div.innerHTML =") < fn.indexOf("div.querySelector('.hz-u-del')"));
  });

  it("F90: the nav's load-time apiFetch calls wait for perfin-shared.js", async () => {
    const html = await render("budgets.ejs", { basePath: "/perfin", activePage: "budgets" });
    const navScript = html.slice(html.indexOf("function whenShared(fn)"));
    assert.match(navScript, /whenShared\(async function\(\) \{\s*var el = document\.getElementById\('nav-sync-badge'\)/);
    assert.match(navScript, /whenShared\(loadNotifs\);/);
    // perfin-shared.js is still loaded AFTER the nav — which is why it waits.
    assert.ok(html.indexOf("function whenShared(fn)") < html.indexOf("/perfin-shared.js?v="));
    // Run the helper: before perfin-shared it defers to DOMContentLoaded.
    const listeners = [];
    const ctx = vm.createContext({ window: {}, document: { addEventListener: (t, fn) => listeners.push(t) } });
    vm.runInContext(navScript.slice(0, navScript.indexOf("}\n") + 2), ctx);
    let ran = false;
    ctx.whenShared(() => { ran = true; });
    assert.equal(ran, false);
    assert.deepEqual(listeners, ["DOMContentLoaded"]);
  });

  it("F93: the nav logo mask is relative to the stylesheet", () => {
    const css = read("teller", "public", "perfin-shared.css");
    assert.doesNotMatch(css, /url\(\/logo\.svg\)/);
    assert.match(css, /mask: url\(logo\.svg\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F92 — offline page + service worker", () => {
  it("offline.html has no inline handlers and uses relative assets", () => {
    const html = read("teller", "public", "offline.html");
    assert.doesNotMatch(html, /\son[a-z]+=/i);
    assert.match(html, /<img class="logo" id="offline-logo" src="logo\.svg"/);
    assert.match(html, /<script src="offline\.js"><\/script>/);
  });

  it("the SW precaches offline.js, bumps its cache, and serves the page with a <base> for the mount", async () => {
    const src = read("teller", "public", "sw.js");
    assert.match(src, /const CACHE = 'perfin-v7';/); // v7 since F107
    assert.match(src, /BASE \+ '\/offline\.js'/);
    const listeners = {};
    const ctx = vm.createContext({
      self: { location: { href: "https://host/perfin/sw.js", origin: "https://host" }, addEventListener: (t, fn) => { listeners[t] = fn; } },
      URL, Response, Headers, Promise,
    });
    vm.runInContext(src + "\nthis.offlineResponse = offlineResponse;", ctx);
    const page = "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"></head><body></body></html>";
    const cached = new Response(page,
      { headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'", "content-length": String(page.length) } });
    const out = await ctx.offlineResponse(cached);
    const text = await out.text();
    assert.match(text, /<head><base href="\/perfin\/">/);
    assert.equal(out.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(out.headers.get("content-length"), null, "the stale length isn't carried over");
  });
});
