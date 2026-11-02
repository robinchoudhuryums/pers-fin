// ============================================================================
// The opening screen (direction D — light + instrument)
// ============================================================================
// - POST /login answers JSON when the keypad sends JSON (ok + the safe
//   redirect, or the error with the same status), and still redirects /
//   renders for a plain form post.
// - shell/public/transition.js run in a vm over a small fake DOM: the dial's
//   SVG (120 outer ticks, 48 inner, the arc), setProgress lighting one tick
//   per step, and the Per-sistant entry — overlay shown, ticks filled, the
//   ring spun (is-unlocking), then the navigation.
// - login.ejs's keypad script run in a vm: digits light the dial, Go posts
//   JSON, a refused PIN shows the server's message and resets, a correct one
//   spins and navigates to the server's same-origin path only.
// - The views and CSS: no starfield left, the dial overlay on the landing page
//   and Perfin's nav, the spin's keyframes and the reduced-motion block.
// ============================================================================

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const PIN = "246810";
process.env.SHELL_PIN = PIN;
process.env.SHELL_SECRET = "opening-screen-test-secret";
delete process.env.NODE_ENV;

const auth = require("../shell/middleware/auth");

function shellApp() {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(ROOT, "shell", "views"));
  app.use(require("cookie-parser")());
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => { res.locals.nonce = "test-nonce"; next(); });
  app.post("/login", auth.handleLogin);
  return app;
}

// ---------------------------------------------------------------------------
describe("POST /login answers JSON to the keypad", () => {
  afterEach(() => auth._resetPinFailures());

  it("a correct PIN → 200 { ok, redirect } with the session cookie", async () => {
    const res = await supertest(shellApp()).post("/login").send({ pin: PIN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, redirect: "/per-sistant" });
    assert.match(String(res.headers["set-cookie"]), /shell_session=/);
  });

  it("the redirect is the safeReturnTo'd return_to", async () => {
    let res = await supertest(shellApp()).post("/login").send({ pin: PIN, return_to: "/perfin/budgets?month=2026-10" });
    assert.equal(res.body.redirect, "/perfin/budgets?month=2026-10");
    res = await supertest(shellApp()).post("/login").send({ pin: PIN, return_to: "//evil.example" });
    assert.equal(res.body.redirect, "/per-sistant");
    res = await supertest(shellApp()).post("/login").send({ pin: PIN, return_to: "/\t/evil.example" });
    assert.equal(res.body.redirect, "/per-sistant");
  });

  it("a wrong PIN → 401 { error } after the delay, no cookie, counted as a failure", async () => {
    const res = await supertest(shellApp()).post("/login").send({ pin: "000000" }).timeout(5000);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Incorrect PIN." });
    assert.equal(res.headers["set-cookie"], undefined);
  });

  it("the lockout answers 429 JSON even for the right PIN", async () => {
    for (let i = 0; i < auth.GLOBAL_FAIL_CEILING; i++) auth._recordPinFailure();
    const res = await supertest(shellApp()).post("/login").send({ pin: PIN });
    assert.equal(res.status, 429);
    assert.match(res.body.error, /PIN login is locked/);
    assert.equal(res.headers["set-cookie"], undefined);
  });

  it("a plain form post still redirects on success and renders the page on failure", async () => {
    let res = await supertest(shellApp()).post("/login").type("form").send({ pin: PIN });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/per-sistant");
    res = await supertest(shellApp()).post("/login").type("form").send({ pin: "000000" }).timeout(5000);
    assert.equal(res.status, 401);
    assert.match(res.text, /<p class="login-error" id="login-error" role="alert">Incorrect PIN\.<\/p>/);
    assert.match(res.headers["content-type"], /html/);
  });
});

// ---------------------------------------------------------------------------
// A small fake DOM — just what transition.js and the login scripts touch.
function makeDom() {
  const byId = {};
  const listeners = {};
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.attrs = {}; this.children = []; this.parentNode = null;
      this.style = { setProperty() {} }; this.dataset = {}; this.textContent = ""; this.className = "";
      this.hidden = false; this.listeners = {};
      const self = this;
      this.classList = {
        set: new Set(),
        add(...c) { c.forEach((x) => this.set.add(x)); },
        remove(...c) { c.forEach((x) => this.set.delete(x)); },
        toggle(c, on) { if (on === undefined) on = !this.set.has(c); if (on) this.set.add(c); else this.set.delete(c); return on; },
        contains(c) { return this.set.has(c); },
      };
      this.removeAttribute = (k) => { delete self.attrs[k]; };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
    get firstChild() { return this.children[0] || null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    querySelector(sel) { return this.find((n) => matches(n, sel)) || null; }
    querySelectorAll(sel) { const out = []; this.walk((n) => { if (matches(n, sel)) out.push(n); }); return out; }
    walk(fn) { for (const c of this.children) { fn(c); c.walk(fn); } }
    find(fn) { let hit = null; this.walk((n) => { if (!hit && fn(n)) hit = n; }); return hit; }
  }
  function matches(n, sel) {
    if (sel === "[data-dial]") return "data-dial" in n.attrs;
    if (sel === "[data-atrans]") return "data-atrans" in n.attrs;
    if (sel === ".atrans-overlay") return n.classList.contains("atrans-overlay");
    if (sel.startsWith(".")) return n.attrs.class === sel.slice(1) || n.classList.contains(sel.slice(1));
    return false;
  }
  const body = new El("body");
  const document = {
    readyState: "complete",
    body,
    createElementNS: (_ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  };
  function add(id, tag = "div", attrs = {}, parent = body) {
    const n = new El(tag);
    Object.assign(n.attrs, attrs);
    if (id) byId[id] = n;
    parent.appendChild(n);
    return n;
  }
  return { El, document, body, byId, add, listeners };
}

function fakeClock() {
  let now = 0;
  const timers = [];
  const raf = [];
  return {
    setTimeout(fn, ms) { timers.push({ at: now + (ms || 0), fn }); return timers.length; },
    requestAnimationFrame(fn) { raf.push(fn); return raf.length; },
    // Advance time in 16 ms frames, running due timers and queued frames.
    advance(ms) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 16);
        const frames = raf.splice(0);
        frames.forEach((f) => f(now));
        timers.sort((a, b) => a.at - b.at);
        while (timers.length && timers[0].at <= now) timers.shift().fn();
      }
    },
    get now() { return now; },
  };
}

function loadTransition(dom, clock, { reduce = false, href } = {}) {
  const win = {
    matchMedia: (q) => ({ matches: reduce && /reduce/.test(q) }),
    addEventListener: () => {},
    location: { href: href || "http://x/perfin/dashboard" },
  };
  const ctx = vm.createContext({
    window: win, document: dom.document, setTimeout: clock.setTimeout,
    requestAnimationFrame: clock.requestAnimationFrame, Math, console,
  });
  vm.runInContext(read("shell", "public", "transition.js"), ctx);
  return win;
}

const countM = (d) => (d.match(/M/g) || []).length;

describe("transition.js — the shell dial", () => {
  it("draws 120 outer ticks inside the spin groups, 48 inner ticks and the arc", () => {
    const dom = makeDom();
    const host = dom.add("login-dial", "div", { "data-dial": "" });
    const img = dom.add(null, "img", {}, host);
    const win = loadTransition(dom, fakeClock());
    const svg = host.children[0];
    assert.equal(svg.attrs.class, "dial-svg");
    assert.equal(host.children[1], img, "the icon stays above the rings");
    assert.ok(host.classList.contains("dial"));
    const burst = svg.children[0];
    const drift = burst.children[0];
    assert.equal(burst.attrs.class, "dial-burst");
    assert.equal(drift.attrs.class, "dial-drift");
    assert.equal(countM(drift.children[0].attrs.d), 120);
    const lit = svg.querySelector(".dial-lit"), dim = svg.querySelector(".dial-dim"), arc = svg.querySelector(".dial-arc");
    assert.equal(countM(lit.attrs.d), 0);
    assert.equal(countM(dim.attrs.d), 48);
    assert.equal(arc.attrs["stroke-dashoffset"], arc.attrs["stroke-dasharray"], "the arc starts empty");
    // A second mount reuses the first.
    assert.equal(win.ShellDial.mount(host), win.ShellDial.mount(host));
    assert.equal(host.children.filter((c) => c.attrs.class === "dial-svg").length, 1);
  });

  it("setProgress lights one inner tick per 1/48 and draws the arc; setState sets the classes", () => {
    const dom = makeDom();
    const host = dom.add("d", "div", { "data-dial": "" });
    const win = loadTransition(dom, fakeClock());
    const ctl = win.ShellDial.mount(host);
    const svg = host.children[0];
    ctl.setProgress(3 / 8);
    assert.equal(countM(svg.querySelector(".dial-lit").attrs.d), 18);
    assert.equal(countM(svg.querySelector(".dial-dim").attrs.d), 30);
    const arc = svg.querySelector(".dial-arc");
    const len = Number(arc.attrs["stroke-dasharray"]);
    assert.ok(Math.abs(Number(arc.attrs["stroke-dashoffset"]) - len * 5 / 8) < 0.02);
    ctl.setProgress(2); // clamped
    assert.equal(countM(svg.querySelector(".dial-lit").attrs.d), 48);
    assert.equal(arc.attrs["stroke-dashoffset"], "0.00");
    ctl.setState("error");
    assert.ok(host.classList.contains("is-error"));
    ctl.setState("checking");
    assert.ok(host.classList.contains("is-checking") && !host.classList.contains("is-error"));
    ctl.setState(null);
    assert.ok(!host.classList.contains("is-checking"));
  });

  it("a [data-atrans] click fills the dial, spins it, then navigates", () => {
    const dom = makeDom();
    const overlay = dom.add("atrans-dial", "div", {});
    overlay.classList.add("atrans-overlay");
    dom.add(null, "div", { "data-dial": "" }, overlay);
    const link = dom.add("link", "a", { "data-atrans": "dial" });
    link.href = "http://x/per-sistant";
    const clock = fakeClock();
    const win = loadTransition(dom, clock);
    let prevented = false;
    link.listeners.click[0]({ preventDefault: () => { prevented = true; }, button: 0 });
    assert.ok(prevented);
    assert.ok(overlay.classList.contains("active"));
    assert.ok(!overlay.classList.contains("is-unlocking"), "the fill comes first");
    clock.advance(300);
    assert.ok(overlay.classList.contains("is-unlocking"), "then the spin");
    const svg = overlay.children[0].children[0];
    assert.equal(countM(svg.querySelector(".dial-lit").attrs.d), 48);
    assert.equal(win.location.href, "http://x/perfin/dashboard", "not yet");
    clock.advance(1000);
    assert.equal(win.location.href, "http://x/per-sistant");
  });

  it("reduced motion navigates at once; a modified click is left to the browser", () => {
    const dom = makeDom();
    const overlay = dom.add("atrans-dial", "div", {});
    overlay.classList.add("atrans-overlay");
    dom.add(null, "div", { "data-dial": "" }, overlay);
    const link = dom.add("link", "a", { "data-atrans": "dial" });
    link.href = "http://x/per-sistant";
    const win = loadTransition(dom, fakeClock(), { reduce: true });
    let prevented = false;
    link.listeners.click[0]({ metaKey: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false);
    link.listeners.click[0]({ button: 0, preventDefault: () => { prevented = true; } });
    assert.ok(prevented);
    assert.equal(win.location.href, "http://x/per-sistant");
    assert.ok(!overlay.classList.contains("active"));
  });
});

// ---------------------------------------------------------------------------
// login.ejs's two inline scripts, run in a vm after transition.js.
function loadLogin({ fetchImpl, reduce = false, returnTo } = {}) {
  const html = ejs.render(read("shell", "views", "login.ejs"), { error: null, returnTo: returnTo || "", nonce: "n" });
  const scripts = [...html.matchAll(/<script nonce="n">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  const dom = makeDom();
  dom.add("login-dial", "div", { "data-dial": "" });
  const status = dom.add("dial-status", "p");
  const form = dom.add("login-form", "form");
  const input = dom.add("pin-input", "input");
  input.value = "";
  dom.add("continue-btn", "button");
  const wrap = dom.add("pin-pad-wrap", "div");
  wrap.hidden = true;
  const pad = dom.add("pin-pad", "div");
  const bio = dom.add("biometric-btn", "button");
  if (returnTo) { const rt = dom.add("return-to", "input"); rt.value = returnTo; }
  const clock = fakeClock();
  const win = loadTransition(dom, clock, { reduce, href: "http://x/login" });
  const fetches = [];
  const ctx = vm.createContext({
    window: win, document: dom.document, setTimeout: clock.setTimeout,
    requestAnimationFrame: clock.requestAnimationFrame, console, JSON, Promise,
    navigator: {}, atob, btoa, Uint8Array, String, Object,
    fetch: (url, opts) => { fetches.push({ url, opts }); return fetchImpl(url, opts); },
  });
  ctx.window.addEventListener = () => {};
  vm.runInContext(scripts.join("\n"), ctx);
  const key = (k) => dom.listeners.keydown[0]({ key: k, target: dom.body, preventDefault() {} });
  const flush = () => new Promise((r) => setImmediate(r));
  return { dom, win, clock, status, input, pad, wrap, bio, fetches, key, flush, dial: dom.byId["login-dial"] };
}

const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

describe("login.ejs — the keypad drives the dial", () => {
  it("swaps the field for the pad and lights the dial one step per digit", () => {
    const t = loadLogin({ fetchImpl: () => reply(200, {}) });
    assert.equal(t.wrap.hidden, false);
    assert.equal(t.input.style.display, "none");
    assert.match(t.pad.innerHTML, /data-action="go" aria-label="Unlock"/);
    assert.match(t.pad.innerHTML, /data-action="back" aria-label="Delete last digit"/);
    assert.equal(t.status.textContent, "Enter PIN");
    t.key("1"); t.key("2"); t.key("3");
    assert.equal(t.input.value, "123");
    assert.equal(t.status.textContent, "3 digits");
    const lit = t.dial.children[0].querySelector(".dial-lit");
    assert.equal(countM(lit.attrs.d), 18, "3 of 8 steps lit");
    t.key("Backspace");
    assert.equal(t.status.textContent, "2 digits");
  });

  it("Go posts JSON; a correct PIN spins the dial and navigates to the server's path", async () => {
    const t = loadLogin({ fetchImpl: () => reply(200, { ok: true, redirect: "/perfin/budgets" }), returnTo: "/perfin/budgets" });
    for (const d of "2468") t.key(d);
    t.key("Enter");
    assert.equal(t.fetches.length, 1);
    assert.equal(t.fetches[0].url, "/login");
    assert.equal(t.fetches[0].opts.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(t.fetches[0].opts.body), { pin: "2468", return_to: "/perfin/budgets" });
    assert.equal(t.status.textContent, "Checking");
    assert.ok(t.dial.classList.contains("is-checking"));
    t.key("Enter"); // a second Enter while checking sends nothing
    assert.equal(t.fetches.length, 1);
    await t.flush(); await t.flush();
    assert.equal(t.status.textContent, "Unlocked");
    assert.ok(t.dom.body.classList.contains("is-unlocking"));
    assert.equal(t.win.location.href, "http://x/login", "the spin plays first");
    t.clock.advance(1200);
    assert.equal(t.win.location.href, "/perfin/budgets");
  });

  it("only a same-origin path is followed", async () => {
    const t = loadLogin({ fetchImpl: () => reply(200, { ok: true, redirect: "//evil.example/x" }) });
    for (const d of "2468") t.key(d);
    t.key("Enter");
    await t.flush(); await t.flush();
    t.clock.advance(1200);
    assert.equal(t.win.location.href, "/per-sistant");
  });

  it("a refused PIN shakes the dial, shows the server's message and resets", async () => {
    const t = loadLogin({ fetchImpl: () => reply(401, { error: "Incorrect PIN." }) });
    for (const d of "1111") t.key(d);
    t.key("Enter");
    await t.flush(); await t.flush();
    assert.equal(t.status.textContent, "Incorrect PIN.");
    assert.equal(t.status.className, "dial-status is-error");
    assert.ok(t.dial.classList.contains("is-error"));
    assert.ok(!t.dom.body.classList.contains("is-unlocking"));
    t.clock.advance(900);
    assert.equal(t.input.value, "");
    assert.ok(!t.dial.classList.contains("is-error"));
    assert.equal(t.status.textContent, "Incorrect PIN.", "the message stays until the next key");
    t.key("5");
    assert.equal(t.status.textContent, "1 digit");
  });

  it("a rate-limited or unreachable server is reported, not followed", async () => {
    let t = loadLogin({ fetchImpl: () => Promise.resolve({ ok: false, status: 429, json: () => Promise.reject(new Error("not json")) }) });
    for (const d of "1111") t.key(d);
    t.key("Enter");
    await t.flush(); await t.flush(); await t.flush();
    assert.match(t.status.textContent, /Too many attempts/);
    t = loadLogin({ fetchImpl: () => Promise.reject(new Error("offline")) });
    for (const d of "1111") t.key(d);
    t.key("Enter");
    await t.flush(); await t.flush();
    assert.match(t.status.textContent, /Couldn't reach the server/);
  });

  it("reduced motion navigates without the spin", async () => {
    const t = loadLogin({ fetchImpl: () => reply(200, { ok: true, redirect: "/per-sistant" }), reduce: true });
    for (const d of "2468") t.key(d);
    t.key("Enter");
    await t.flush(); await t.flush();
    assert.equal(t.win.location.href, "/per-sistant");
    assert.ok(!t.dom.body.classList.contains("is-unlocking"));
  });
});

// ---------------------------------------------------------------------------
describe("views and CSS", () => {
  it("no starfield / nebula / particle effect is left in the shell or Perfin's nav", () => {
    for (const f of [["shell", "views", "login.ejs"], ["shell", "views", "landing.ejs"], ["shell", "public", "landing.css"],
      ["shell", "public", "transition.css"], ["shell", "public", "transition.js"], ["teller", "views", "partials", "nav.ejs"]]) {
      const src = read(...f);
      assert.doesNotMatch(src, /cosmic|nebula|atrans-stars|getImageData/, f.join("/"));
    }
  });

  it("the landing tile and Perfin's cross-app link open Per-sistant through the dial overlay", () => {
    for (const f of [["shell", "views", "landing.ejs"], ["teller", "views", "partials", "nav.ejs"]]) {
      const src = read(...f);
      assert.match(src, /href="\/per-sistant"[^>]*data-atrans="dial"/, f.join("/"));
      assert.match(src, /<div class="atrans-overlay" id="atrans-dial" aria-hidden="true">[\s\S]*?<div data-dial><img src="\/android-chrome-192x192\.png\?v=2"/, f.join("/"));
      assert.match(src, /\/shell-static\/transition\.js\?v=3/);
    }
    assert.match(read("teller", "views", "partials", "head.ejs"), /\/shell-static\/transition\.css\?v=3/);
  });

  it("the login page loads the dial before its scripts and keeps the no-JS form", () => {
    const html = ejs.render(read("shell", "views", "login.ejs"), { error: "Incorrect PIN.", returnTo: "/perfin", nonce: "n" });
    assert.ok(html.indexOf('src="/shell-static/transition.js?v=3"></script>') < html.indexOf('<script nonce="n">'),
      "transition.js runs (not deferred) before the inline scripts use ShellDial");
    assert.match(html, /<div id="login-dial" data-dial>/);
    assert.match(html, /<p class="dial-status" id="dial-status" aria-live="polite">Enter PIN<\/p>/);
    assert.match(html, /<form id="login-form" method="POST" action="\/login"/);
    assert.match(html, /name="pin"[\s\S]*?id="pin-input"/);
    assert.match(html, /<button type="submit" class="btn primary" id="continue-btn">Continue<\/button>/);
    assert.match(html, /<input type="hidden" name="return_to" id="return-to" value="\/perfin">/);
  });

  it("the spin: two turns that overshoot and settle, the drift paused, the panel falling away", () => {
    const css = read("shell", "public", "transition.css");
    assert.match(css, /\.is-unlocking \.dial-burst \{ animation: dial-burst 1\.05s/);
    assert.match(css, /@keyframes dial-burst \{\s*0%\s+\{ transform: rotate\(0deg\); \}\s*82%\s+\{ transform: rotate\(734deg\); \}\s*100% \{ transform: rotate\(720deg\); \}/);
    assert.match(css, /\.is-unlocking \.dial-drift \{ animation-play-state: paused; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.dial, \.dial \*, \.shell-flare, \.shell-scan \{ animation: none !important; transition: none !important; \}/);
    assert.match(read("shell", "public", "landing.css"), /\.is-unlocking \.pin-panel \{ opacity: 0;/);
  });
});
