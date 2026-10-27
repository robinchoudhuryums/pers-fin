// ============================================================================
// Roadmap T3.3 K4 — the Tax page + close-out
// ============================================================================
// taxSeason (perfin-shared.js — last year from January to April, else this
// year) run in a vm; the Tax page script (public/tax-page.js) run in a vm over
// a small fake DOM: the default year by month and ?year=, the year options and
// downloads, the sections from a canned package (a failed section's sentence,
// escaping, a CSV link per section through the mount base), the checklist
// (state, labels, Delete only on a manual row and data-e2e-skip), every write
// through writeOk (received / dismissed / notes / add / suggest / delete), a
// refused write not reloading, failed loads, a slower load for an older year
// never overwriting a newer one; the dashboard's January–April link; the
// Settings link; the view, page route and mount; GET /api/tax/package's
// section CSV. The browser half is e2e/pages.spec.js (the Tax page test).
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}

const shared = read("teller/public/perfin-shared.js");
function taxSeasonFn() {
  const ctx = { localTodayStr: () => "2026-10-26" };
  vm.runInNewContext(slice(shared, "function taxSeason(today)", "function localDateStr(d)") + "this.taxSeason = taxSeason;", ctx);
  return ctx.taxSeason;
}
const escFn = (() => {
  const ctx = {};
  vm.runInNewContext(slice(shared, "function esc(s)", "// --- Prefix helper") + "this.esc = esc;", ctx);
  return ctx.esc;
})();

describe("taxSeason (perfin-shared.js)", () => {
  const taxSeason = taxSeasonFn();
  it("is last year, in season, from January to April; this year otherwise", () => {
    assert.deepEqual({ ...taxSeason("2027-01-01") }, { year: 2026, season: true });
    assert.deepEqual({ ...taxSeason("2027-04-30") }, { year: 2026, season: true });
    assert.deepEqual({ ...taxSeason("2027-05-01") }, { year: 2027, season: false });
    assert.deepEqual({ ...taxSeason("2026-12-31") }, { year: 2026, season: false });
    assert.deepEqual({ ...taxSeason() }, { year: 2026, season: false }); // localTodayStr
  });
  it("is exported for the page and the dashboard", () => {
    assert.match(shared, /win\.taxSeason = taxSeason;/);
  });
});

// ---------------------------------------------------------------------------
// The page script over a fake DOM
// ---------------------------------------------------------------------------
const PKG = {
  year: 2026, generated_on: "2027-02-10",
  overview: { year: 2026, income_total: 52000, investment_income_total: 148.5, realized_gain_known: 300, sales_without_basis: 1,
    retirement_distributions_total: 600, deductions_total: 142.17, rent_paid_total: null, documents_open: 2, documents_overdue: 1,
    sections_failed: ["rent_paid"] },
  income: { ok: true, total: 52000, by_kind: { wages: 50000, interest: 0, dividends: 0, other: 2000 },
    by_source: [{ source: "<script>x</script>", kind: "wages", total: 50000 }], by_month: [] },
  investment_income: { ok: true, accounts: [{ account_name: "Brokerage" }], totals: { dividends: 120.4, qualified_dividends: 100, interest: 3.1, capital_gain_distributions_long: 20, capital_gain_distributions_short: 5, tax_withheld: 1.2 } },
  realized_gains: { ok: true, sales: [{}, {}], totals: { short: { gain: -50 }, long: { gain: 350 }, unknown: { count: 1, proceeds: 50 } }, coverage: { full: 1, partial: 0, none: 1 }, corporate_action_securities: 1 },
  retirement: { ok: true, distributions: [{ date: "2026-07-01", account_name: "IRA", amount: 600 }], total: 600 },
  deductions: { ok: true, rows: [], by_category: { charity: 100, medical: 42.17 }, total: 142.17, count: 3 },
  rent_paid: { ok: false, error: "Could not read the year's rent and utility payments." },
  documents: { ok: true, documents: [], counts: {} },
  notes: [],
};
const DOCS = {
  year: 2026, forms: ["W-2", "1099-INT", "other"],
  documents: [
    { id: 1, form: "W-2", issuer: "Acme <Corp>", expected_by: "2027-01-31", received_at: "2027-01-20", dismissed_at: null, origin: "suggested", notes: "in the drawer", state: "received" },
    { id: 2, form: "1099-INT", issuer: "Ally", expected_by: "2027-01-31", received_at: null, dismissed_at: null, origin: "manual", notes: null, state: "overdue" },
  ],
};

function makeEl(id) {
  return {
    id, innerHTML: "", value: "", href: "", textContent: "", style: {}, listeners: {},
    attrs: {},
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    getAttribute(n) { return n === "href" ? this.href : this.attrs[n]; },
  };
}
function fakeRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this; } };
}

function loadPage({ today = "2027-02-10", search = "", routes, confirmAnswer = true } = {}) {
  const els = {};
  for (const id of ["tax-page", "tax-year", "tax-pdf-link", "tax-zip-link", "tax-sections", "documents-list", "doc-form", "doc-issuer", "doc-add", "tax-suggest"]) els[id] = makeEl(id);
  const calls = [];
  const toasts = [];
  const notesInputs = {};
  const taxSeason = taxSeasonFn();
  const win = {
    BASE_PATH: "/perfin",
    location: { search, pathname: "/perfin/tax", hash: "" },
    history: { replaceState(_s, _t, url) { win.location.lastUrl = url; } },
    localTodayStr: () => today,
    taxSeason: (t) => taxSeason(t),
    esc: escFn,
    withBase: (u) => "/perfin" + u,
    showMsg: (text, ok) => toasts.push({ text, ok }),
    writeOk: async (res, what) => { if (res.ok) return true; toasts.push({ text: what + ": " + (await res.json()).error, ok: false }); return false; },
    confirm: () => confirmAnswer,
    apiFetch: async (url, opts) => {
      calls.push({ url, method: (opts && opts.method) || "GET", body: opts && opts.body ? JSON.parse(opts.body) : undefined });
      const r = routes && routes(url, opts);
      if (r instanceof Error) throw r;
      if (r) return r;
      if (url.startsWith("/api/tax/package")) return fakeRes(200, PKG);
      if (url.startsWith("/api/tax/documents?")) return fakeRes(200, DOCS);
      return fakeRes(200, {});
    },
  };
  win.window = win;
  win.document = {
    readyState: "complete",
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => {
      const m = /data-notes-for="(\d+)"/.exec(sel);
      return m ? notesInputs[m[1]] || null : null;
    },
    addEventListener() {},
  };
  win.URLSearchParams = URLSearchParams;
  win.Promise = Promise;
  const ctx = vm.createContext(win);
  vm.runInContext(read("teller/public/tax-page.js"), ctx);
  return { win, els, calls, toasts, notesInputs, page: win.TaxPage };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const btn = (attrs) => ({ getAttribute: (n) => attrs[n] });

describe("the Tax page script", () => {
  it("opens on last year from January to April and this year otherwise; ?year= wins when valid", async () => {
    let p = loadPage({ today: "2027-02-10" }); await settle();
    assert.equal(p.page.state.year, 2026);
    assert.match(p.els["tax-year"].innerHTML, /<option value="2027">2027<\/option><option value="2026" selected>2026<\/option>/);
    assert.equal((p.els["tax-year"].innerHTML.match(/<option/g) || []).length, 7);
    p = loadPage({ today: "2026-10-26" }); await settle();
    assert.equal(p.page.state.year, 2026);
    p = loadPage({ today: "2026-10-26", search: "?year=2019" }); await settle();
    assert.equal(p.page.state.year, 2019);
    assert.match(p.els["tax-year"].innerHTML, /<option value="2019" selected>2019<\/option>$/); // listed although older
    for (const q of ["?year=1999", "?year=2027", "?year=20x6", "?year="]) {
      p = loadPage({ today: "2026-10-26", search: q }); await settle();
      assert.equal(p.page.state.year, 2026, q);
    }
  });

  it("points the downloads at the package through the mount base and follows the year", async () => {
    const p = loadPage(); await settle();
    assert.equal(p.els["tax-pdf-link"].href, "/perfin/api/tax/package?year=2026&format=pdf");
    assert.equal(p.els["tax-zip-link"].href, "/perfin/api/tax/package?year=2026&format=zip");
    assert.equal(p.win.location.lastUrl, "/perfin/tax?year=2026");
    p.els["tax-year"].listeners.change.call({ value: "2024" });
    await settle();
    assert.equal(p.page.state.year, 2024);
    assert.equal(p.els["tax-zip-link"].href, "/perfin/api/tax/package?year=2024&format=zip");
    assert.ok(p.calls.some((c) => c.url === "/api/tax/package?year=2024"));
    assert.ok(p.calls.some((c) => c.url === "/api/tax/documents?year=2024"));
  });

  it("renders a card per section with its totals and a CSV link; a failed section shows its sentence", async () => {
    const p = loadPage(); await settle();
    const html = p.els["tax-sections"].innerHTML;
    for (const s of p.page.SECTIONS) assert.match(html, new RegExp('data-section="' + s.key + '"'), s.key);
    assert.match(html, /data-section="overview"/);
    for (const key of ["income", "investment_income", "realized_gains", "retirement", "deductions"]) {
      assert.ok(html.includes(`href="/perfin/api/tax/package?year=2026&amp;format=csv&amp;section=${key}" download aria-label="Download the `), key);
    }
    assert.ok(!html.includes("section=rent_paid"), "no CSV link for a failed section");
    assert.match(html, /Could not read the year&#39;s rent and utility payments\./);
    assert.match(html, /Not available: Rent and utilities paid\./);
    assert.ok(html.includes("$52,000.00") && html.includes("$142.17") && html.includes("-$50.00"));
    assert.match(html, /1099-B is the authority/);
    assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;") && !html.includes("<script>x"));
  });

  it("lists the checklist with labelled controls; Delete only on a manual row, skipped by the e2e sweep", async () => {
    const p = loadPage(); await settle();
    assert.equal(p.els["doc-form"].innerHTML, '<option value="W-2">W-2</option><option value="1099-INT">1099-INT</option><option value="other">other</option>');
    const html = p.els["documents-list"].innerHTML;
    assert.ok(html.includes("W-2 from Acme &lt;Corp&gt;"));
    assert.match(html, /data-action="received" data-id="1" data-value="false" aria-label="Mark the W-2 from Acme &lt;Corp&gt; not received">Not received/);
    assert.match(html, /data-action="received" data-id="2" data-value="true" aria-label="Mark the 1099-INT from Ally received">Mark received/);
    assert.match(html, /data-action="dismissed" data-id="2" data-value="true" aria-label="Dismiss the 1099-INT from Ally">Dismiss/);
    assert.match(html, /value="in the drawer" aria-label="Notes for the W-2 from Acme &lt;Corp&gt;"/);
    assert.match(html, /class="doc-state overdue">Overdue/);
    const deletes = html.match(/data-action="delete"[^>]*>/g) || [];
    assert.equal(deletes.length, 1);
    assert.match(deletes[0], /data-id="2".*data-e2e-skip/);
    assert.match(p.page.renderDocuments([]), /No forms on the list yet/);
  });

  it("every checklist write goes through writeOk and reloads only on success", async () => {
    let p = loadPage(); await settle();
    const before = p.calls.length;
    await p.page.onDocAction(btn({ "data-id": "2", "data-action": "received", "data-value": "true" }));
    assert.deepEqual(p.calls[before], { url: "/api/tax/documents/2", method: "PATCH", body: { received: true } });
    assert.ok(p.calls.slice(before + 1).some((c) => c.url.startsWith("/api/tax/package")), "reloaded");
    await p.page.onDocAction(btn({ "data-id": "1", "data-action": "dismissed", "data-value": "false" }));
    assert.ok(p.calls.some((c) => c.method === "PATCH" && c.body && c.body.dismissed === false));
    p.notesInputs["1"] = { value: "photo on phone" };
    await p.page.onDocAction(btn({ "data-id": "1", "data-action": "notes" }));
    assert.ok(p.calls.some((c) => c.method === "PATCH" && c.body && c.body.notes === "photo on phone"));
    assert.ok(p.toasts.some((t) => t.text === "Notes saved." && t.ok));

    // A refused write: the server's error, no reload.
    p = loadPage({ routes: (url, o) => (o && o.method === "PATCH" ? fakeRes(400, { error: "received must be true or false" }) : null) });
    await settle();
    const n = p.calls.length;
    await p.page.onDocAction(btn({ "data-id": "2", "data-action": "received", "data-value": "true" }));
    assert.equal(p.calls.length, n + 1);
    assert.deepEqual(p.toasts.pop(), { text: "Could not update the form: received must be true or false", ok: false });
  });

  it("adds a form, suggests from the data and deletes a manual row after a confirm", async () => {
    let p = loadPage({ routes: (url) => (url === "/api/tax/documents/suggest" ? fakeRes(200, { added: 2, errors: [] }) : null) });
    await settle();
    p.els["doc-form"].value = "1099-INT"; p.els["doc-issuer"].value = "Ally";
    await p.page.addDocument();
    assert.ok(p.calls.some((c) => c.url === "/api/tax/documents" && c.method === "POST" && c.body.year === 2026 && c.body.form === "1099-INT" && c.body.issuer === "Ally"));
    assert.equal(p.els["doc-issuer"].value, "");
    await p.page.suggest();
    assert.ok(p.calls.some((c) => c.url === "/api/tax/documents/suggest" && c.body.year === 2026));
    assert.ok(p.toasts.some((t) => t.text === "2 form(s) added from your data." && t.ok));
    await p.page.onDocAction(btn({ "data-id": "2", "data-action": "delete" }));
    assert.ok(p.calls.some((c) => c.url === "/api/tax/documents/2" && c.method === "DELETE"));

    p = loadPage({ confirmAnswer: false, routes: (url) => (url === "/api/tax/documents" ? fakeRes(409, { error: "That form from that issuer is already on the list." }) : null) });
    await settle();
    await p.page.onDocAction(btn({ "data-id": "2", "data-action": "delete" }));
    assert.ok(!p.calls.some((c) => c.method === "DELETE"), "a declined confirm deletes nothing");
    p.els["doc-issuer"].value = "Ally";
    await p.page.addDocument();
    assert.equal(p.els["doc-issuer"].value, "Ally", "kept after a refused add");
    assert.deepEqual(p.toasts.pop(), { text: "Could not add the form: That form from that issuer is already on the list.", ok: false });
  });

  it("the list's click delegation reaches the action buttons", async () => {
    const p = loadPage(); await settle();
    const b = btn({ "data-id": "2", "data-action": "dismissed", "data-value": "true" });
    p.els["documents-list"].listeners.click({ target: { closest: () => b } });
    await settle(); await settle();
    assert.ok(p.calls.some((c) => c.method === "PATCH" && c.body && c.body.dismissed === true));
  });

  it("shows a failed load instead of Loading..., for either half", async () => {
    let p = loadPage({ routes: (url) => (url.startsWith("/api/tax/package") ? fakeRes(500, { error: "Could not build the tax package." }) : url.startsWith("/api/tax/documents?") ? new Error("offline") : null) });
    await settle();
    assert.match(p.els["tax-sections"].innerHTML, /Could not build the tax package\./);
    assert.match(p.els["documents-list"].innerHTML, /Could not load the tax documents\./);
    p = loadPage({ routes: (url) => (url.startsWith("/api/tax/package") ? new Error("offline") : null) });
    await settle();
    assert.match(p.els["tax-sections"].innerHTML, /Could not load the tax package\./);
  });

  it("a slower load for an earlier year never overwrites a newer one", async () => {
    let release;
    const slow = new Promise((r) => { release = r; });
    const p = loadPage({ routes: (url) => (url === "/api/tax/package?year=2026" ? slow : null) });
    await settle();
    await p.page.setYear(2025);
    assert.match(p.els["tax-sections"].innerHTML, /data-section="income"/);
    const newer = p.els["tax-sections"].innerHTML;
    release(fakeRes(200, { ...PKG, income: { ok: false, error: "OLD" } }));
    await settle(); await settle();
    assert.equal(p.els["tax-sections"].innerHTML, newer);
  });
});

// ---------------------------------------------------------------------------
// Dashboard + Settings links, the view, the page route
// ---------------------------------------------------------------------------
describe("links to the Tax page", () => {
  const dash = read("teller/views/dashboard.ejs");
  function runDashLink(today) {
    const link = { attrs: { href: "/perfin/tax" }, href: "/perfin/tax", style: { display: "none" }, textContent: "",
      getAttribute(n) { return this.attrs[n]; } };
    const taxSeason = taxSeasonFn();
    const ctx = {
      document: { getElementById: (id) => (id === "tax-season-link" ? link : null) },
      localTodayStr: () => today,
    };
    ctx.window = { taxSeason };
    vm.runInNewContext(slice(dash, "(function wireTaxSeasonLink() {", "(function wireSyncHealthStrip() {"), ctx);
    return link;
  }

  it("the dashboard shows last year's package link from January to April only", () => {
    const feb = runDashLink("2027-02-10");
    assert.equal(feb.style.display, "block");
    assert.equal(feb.href, "/perfin/tax?year=2026");
    assert.match(feb.textContent, /^Tax season: your 2026 tax package/);
    for (const t of ["2027-05-01", "2026-10-26", "2026-12-31"]) assert.equal(runDashLink(t).style.display, "none", t);
    assert.match(dash, /<a id="tax-season-link" href="<%= basePath %>\/tax" style="display:none;/);
  });

  it("Settings → Data & Exports links to the page through the mount base", () => {
    assert.match(read("teller/views/settings.ejs"), /<a class="btn" id="tax-page-link" href="<%= basePath %>\/tax">Open the Tax page<\/a>/);
  });

  it("the view loads its script through the mount base and carries the checklist anchor", () => {
    const view = read("teller/views/tax.ejs");
    assert.match(view, /<script src="<%= __taxBase %>\/tax-page\.js\?v=<%= v %>"><\/script>/);
    assert.ok(view.indexOf("partials/foot") < view.indexOf("tax-page.js"), "after perfin-shared.js");
    assert.match(view, /<section id="documents">/); // the linked task's /tax#documents
    assert.match(view, /<label for="tax-year">/);
    assert.match(read("teller/services/linked-tasks.js"), /\/tax#documents/);
  });

  it("the page route renders the view and is mounted", async () => {
    const app = express();
    app.set("views", path.join(ROOT, "teller/views"));
    app.set("view engine", "ejs");
    app.locals.v = "t"; app.locals.nonce = "n";
    app.use(require("../teller/pages/tax")({}));
    const r = await supertest(app).get("/tax").expect(200);
    assert.match(r.text, /<h1>Tax<\/h1>/);
    assert.match(r.text, /\/tax-page\.js\?v=t/);
    assert.match(read("teller/server.js"), /app\.use\(require\("\.\/pages\/tax"\)\(pageConfig\)\);/);
  });
});

describe("GET /api/tax/package?format=csv&section=", () => {
  const tp = require("../teller/services/tax-package");
  const original = tp.gatherTaxPackage;
  afterEach(() => { tp.gatherTaxPackage = original; });
  const pkgDeps = {
    today: "2026-02-10",
    getIncomeForYear: async () => ({ total: 10, by_kind: {}, by_source: [], by_month: [] }),
    getInvestmentTaxData: async () => ({ accounts: [], realized_gains: { sales: [], totals: {} }, investment_income: { accounts: [], totals: {} }, retirement: { distributions: [], total: 0 } }),
    getTaxDeductionReport: async () => [{ tax_year: 2025, txn_date: "2025-01-02", merchant: "=Red Cross", amount: "10.00", category: "charity", deduction_type: "keyword_match", notes: null, is_confirmed: false }],
    getHousingPayments: async () => ({ year: 2025, payee: "Sam", total: 0, payments: [] }),
    listTaxDocuments: async () => [],
  };

  it("serves one section's CSV — the file the ZIP holds", async () => {
    tp.gatherTaxPackage = (pool, y) => original(pool, y, pkgDeps);
    const app = express(); app.use(require("../teller/routes/tax"));
    const y = Number(require("../teller/services/financial-queries").todayStr().slice(0, 4)) - 1;
    const r = await supertest(app).get(`/api/tax/package?year=${y}&format=csv&section=deductions`).expect(200);
    assert.match(r.headers["content-type"], /^text\/csv/);
    assert.equal(r.headers["content-disposition"], `attachment; filename=perfin_tax_deductions_${y}.csv`);
    assert.equal(r.headers["cache-control"], "no-store");
    const pkg = await original({}, y, pkgDeps);
    assert.equal(r.text, tp.packageCsvFiles(pkg)["deductions.csv"]);
    assert.ok(r.text.includes(`"'=Red Cross"`));
  });
});
