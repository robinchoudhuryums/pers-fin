// ============================================================================
// Broad-scan (Sept 2026) Batch 13 — Perfin UI correctness & accessibility
// ============================================================================
// WD-4    pyramid wellness / spending modes read the real response shapes
// WD-5    pyramid net worth = the server snapshot; loans count as debt
// WUI-6   writes check the response and report failures; a 0% share stays 0%
// WD-12   more swallowed failures + NaN prompts
// WD-7    CSV "Auto-detect" (no institution sent) + preview on Accounts
// WD-8    the dead Plaid pre-build is gone
// WD-9    "+ Add Goal" opens on the first click
// WD-11   manual loan accounts can be created
// WD-13   WebAuthn registration sends transports
// WD-15   account-history: day labels, debt colours, reset cards
// IF-1    shared dialog helper (role, focus trap, Esc, focus restore)
// IF-2    calendar events are buttons; "+N more" expands
// IF-3    form controls have accessible names
// IF-4    every var(--x) without a fallback is defined
// IF-5    light-theme contrast: text on teal, option lists, opaque modals
// IF-6    PIN pad: no 8-digit cap; Enter doesn't hijack other buttons
// IF-7    a notification with data.url opens it
// ============================================================================

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalPoolQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalPoolQuery; });

// ---------------------------------------------------------------------------
// Run the dashboard's PYRAMID_MODES against canned API responses.
function loadPyramidModes(responses, onPatch) {
  const src = read("teller", "views", "dashboard.ejs");
  const start = src.indexOf("var PYRAMID_MODES = {");
  const end = src.indexOf("// Spawn rising neon orbs");
  assert.ok(start > 0 && end > start, "PYRAMID_MODES block present");
  const apiFetch = async (url, opts) => {
    if (opts && opts.method === "PATCH") { if (onPatch) onPatch(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    const key = Object.keys(responses).find((k) => url.indexOf(k) === 0);
    const body = key ? responses[key] : null;
    return { ok: body !== null, json: async () => body };
  };
  const document = { getElementById: () => null };
  // eslint-disable-next-line no-new-func
  return new Function("apiFetch", "document", src.slice(start, end) + "\nreturn PYRAMID_MODES;")(apiFetch, document);
}

describe("WD-4 — pyramid modes read the shapes the API returns", () => {
  it("wellness counts subscriptions from { subscriptions } and cancelled_at", async () => {
    const modes = loadPyramidModes({
      "/api/accounts": [],
      "/api/budgets": [],
      "/api/subscriptions": { subscriptions: [{ is_dismissed: false, cancelled_at: "2026-01-01" }, { is_dismissed: false, cancelled_at: null }], summary: {} },
      "/api/goals": [],
    });
    const r = await modes.wellness.compute();
    assert.ok(r.tierScores[2] > 0, "the Subs tier used to be 0 (subs.length on an object)");
    assert.equal(r.tierScores[2], 80, "60 + bonus for 1 of 2 managed");
  });

  it("spending_categories builds its buckets from by_category (not a constant 75)", async () => {
    const all = loadPyramidModes({ "/api/spending-summary": { by_category: [
      { category: "Groceries", total: "500" }, { category: "Food & Drink", total: "300" },
      { category: "Subscription", total: "100" }, { category: "Other", total: "100" },
    ] } });
    const balanced = await all.spending_categories.compute();
    const heavy = await loadPyramidModes({ "/api/spending-summary": { by_category: [
      { category: "Food & Drink", total: "900" }, { category: "Shopping", total: "100" },
    ] } }).spending_categories.compute();
    assert.notEqual(balanced.score, heavy.score, "different mixes give different scores");
    assert.ok(balanced.score > heavy.score);
    const empty = await loadPyramidModes({ "/api/spending-summary": { by_category: [] } }).spending_categories.compute();
    assert.equal(empty.score, 0);
    assert.match(empty.status, /No spending data/);
  });
});

describe("WD-5 — pyramid net worth and debt match the server", () => {
  it("net_worth uses the latest snapshot (loans as debt, investments included)", async () => {
    const r = await loadPyramidModes({
      "/api/net-worth/history": [
        { net_worth: "40000", total_assets: "60000", total_liabilities: "20000" },
        { net_worth: "50000", total_assets: "68000", total_liabilities: "18000" },
      ],
      "/api/accounts": [{ type: "loan", current_balance: "18000" }], // would have been an "asset"
    }).net_worth.compute();
    assert.match(r.status, /Net worth: \$50,000/);
  });

  it("debt_payoff counts a loan, and raises a baseline the debt has outgrown", async () => {
    let patched = null;
    const modes = loadPyramidModes({
      "/api/accounts": [{ type: "credit", current_balance: "1000" }, { type: "loan", current_balance: "18000" }],
      "/api/settings": { debt_baseline_amount: "1000" },
    }, (b) => { patched = b; });
    const r = await modes.debt_payoff.compute();
    assert.doesNotMatch(r.status, /Debt-free/);
    assert.equal(patched.debt_baseline_amount, 19000);
    assert.equal(r.score, 0);
  });
});

// ---------------------------------------------------------------------------
describe("WUI-6 / WD-12 — writes report failures", () => {
  const sharedSrc = read("teller", "public", "perfin-shared.js");
  const start = sharedSrc.indexOf("async function writeOk");
  const end = sharedSrc.indexOf("// IF-1: one dialog behaviour");
  // eslint-disable-next-line no-new-func
  const mk = (showMsg) => new Function("showMsg", sharedSrc.slice(start, end) + "\nreturn { writeOk, parseAmountInput };")(showMsg);

  it("writeOk returns true on 2xx and toasts the server's error otherwise", async () => {
    const msgs = [];
    const h = mk((t, ok) => msgs.push([t, ok]));
    assert.equal(await h.writeOk({ ok: true }, "x"), true);
    const bad = { ok: false, status: 400, clone() { return { json: async () => ({ error: "bad split" }) }; } };
    assert.equal(await h.writeOk(bad, "Could not update"), false);
    assert.deepEqual(msgs, [["Could not update: bad split", false]]);
  });

  it("parseAmountInput rejects non-numbers instead of sending null", () => {
    const h = mk(() => {});
    assert.equal(h.parseAmountInput("$1,234.50"), 1234.5);
    assert.equal(h.parseAmountInput("0"), 0);
    assert.ok(Number.isNaN(h.parseAmountInput("abc")));
    assert.ok(Number.isNaN(h.parseAmountInput("")));
    assert.ok(Number.isNaN(h.parseAmountInput("12abc")));
  });

  it("PATCH /api/accounts/:id/shared keeps a 0% share and 400s garbage", async () => {
    let params = null;
    dbModule.pool.query = async (sql, p) => { params = p; return { rows: [{ id: 3, spending_split_pct: p[1] }] }; };
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/enrollments"));
    await supertest(app).patch("/api/accounts/3/shared").send({ is_shared: true, spending_split_pct: 0 }).expect(200);
    assert.equal(params[1], 0, "0 used to become 100 via `|| 100`");
    await supertest(app).patch("/api/accounts/3/shared").send({ spending_split_pct: "abc" }).expect(400);
    await supertest(app).patch("/api/accounts/3/shared").send({ spending_split_pct: 150 }).expect(400);
  });

  it("each named write checks its response", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    assert.equal((dash.match(/async function editManualBalance/g) || []).length, 1, "the duplicate definition is gone");
    assert.match(dash, /writeOk\(r, 'Could not mark settled'\)/);
    assert.match(dash, /writeOk\(r, 'Could not undo'\)/);
    assert.match(dash, /writeOk\(r, 'Could not save the starting debt'\)/);
    assert.doesNotMatch(dash, /Math\.min\(100, parseInt\(pct\) \|\| 100\)/);
    const cal = read("teller", "views", "calendar.ejs");
    assert.match(cal, /writeOk\(cRes, 'Could not mark paid'\)/);
    assert.match(cal, /writeOk\(dRes, 'Could not mark unpaid'\)/);
    const hz = read("teller", "views", "housing.ejs");
    assert.match(hz, /writeOk\(res, 'Could not save the amount'\)/);
    assert.match(hz, /writeOk\(res, 'Could not undo the payment'\)/);
    const acc = read("teller", "views", "accounts.ejs");
    assert.match(acc, /writeOk\(res, 'Could not remove ' \+ name\)/);
    assert.match(acc, /parseAmountInput\(val\)/);
    const set = read("teller", "views", "settings.ejs");
    assert.match(set, /Could not update the watchlist item/);
    assert.match(set, /Could not remove the watchlist item/);
    assert.match(set, /Could not remove the biometric login/);
    const goals = read("teller", "views", "goals.ejs");
    assert.match(goals, /const amount = parseAmountInput\(val\);/);
  });
});

// ---------------------------------------------------------------------------
describe("WD-7 / WD-8 — CSV auto-detect + Plaid pre-build", () => {
  it("both CSV forms default to Auto-detect and only send what the user chose", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    assert.match(dash, /<option value="">Auto-detect from the file<\/option>/);
    assert.match(dash, /if \(institution\) fd\.append\('institution', institution\);/);
    assert.match(dash, /if \(csvInstitution\) csvInstitution\.value = '';/);
    const acc = read("teller", "views", "accounts.ejs");
    assert.match(acc, /<option value="" selected>Auto-detect from the file<\/option>/);
    assert.match(acc, /if \(institution\) formData\.append\('institution', institution\);/);
    assert.match(acc, /apiFetch\('\/api\/import-csv\/preview'/, "the Accounts page previews before importing");
  });

  it("a preview with no institution files the rows under the detected bank", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/subscriptions"));
    const discover = "Trans. Date,Post Date,Description,Amount,Category\n09/01/2026,09/02/2026,SHELL OIL,40.00,Gasoline\n";
    const res = await supertest(app).post("/api/import-csv/preview").attach("file", Buffer.from(discover), "x.csv").expect(200);
    assert.equal(res.body.format_detected, "discover");
    assert.equal(res.body.account_label, "Discover Account", "not \"Chase Account\"");
  });

  it("the Plaid pre-build is removed; the OAuth return path keeps buildPlaidHandler", () => {
    const acc = read("teller", "views", "accounts.ejs");
    assert.doesNotMatch(acc, /function prebuildPlaidHandler|function linkPlaidTransactions|setTimeout\(prebuildPlaidHandler|var _plaidHandler\b/);
    assert.match(acc, /function buildPlaidHandler/);
    assert.match(acc, /handlePlaidOAuthReturn/);
  });
});

// ---------------------------------------------------------------------------
describe("WD-9 / WD-11 / WD-13 / WD-15", () => {
  it("+ Add Goal reads the computed display (one click opens it)", () => {
    const g = read("teller", "views", "goals.ejs");
    assert.match(g, /getComputedStyle\(f\)\.display !== 'none'/);
    assert.doesNotMatch(g, /f\.style\.display = f\.style\.display === 'none' \? 'block' : 'none'/);
  });

  it("the manual-account form offers a loan type", () => {
    assert.match(read("teller", "views", "accounts.ejs"), /<option value="loan">Loan/);
  });

  it("biometric registration sends the authenticator's transports", () => {
    assert.match(read("teller", "views", "settings.ejs"), /transports: typeof attestation\.response\.getTransports === 'function'/);
  });

  it("account history: day labels, debt-aware colours, cards reset on a short range", () => {
    const h = read("teller", "views", "account-history.ejs");
    assert.match(h, /String\(s\.snapshot_date\)\.slice\(0, 10\)/);
    assert.match(h, /var good = isDebt \? delta <= 0 : delta >= 0;/);
    assert.match(h, /\['m-current', 'm-start', 'm-delta', 'm-pct'\]\.forEach/);
    assert.match(h, /em\.textContent = EMPTY_TEXT;/, "the error text no longer sticks");
  });
});

// ---------------------------------------------------------------------------
describe("IF-1 — shared dialog helper", () => {
  it("perfin-shared exports openDialog / watchDialog with trap, Esc and restore", () => {
    const s = read("teller", "public", "perfin-shared.js");
    assert.match(s, /win\.openDialog = openDialog;/);
    assert.match(s, /win\.watchDialog = watchDialog;/);
    assert.match(s, /box\.setAttribute\('aria-modal', 'true'\)/);
    assert.match(s, /if \(e\.key === 'Escape'\)/);
    assert.match(s, /if \(e\.key !== 'Tab'\) return;/);
    assert.match(s, /r\.focus\(\)/);
  });

  it("every modal and the notification panel use it", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    assert.match(dash, /watchDialog\(modal, \{ label: 'Add bill', onClose: closeModal \}\)/);
    assert.match(dash, /watchDialog\(csvModal, \{ label: 'Import transactions CSV', onClose: closeCsvModal \}\)/);
    assert.match(read("teller", "views", "housing.ejs"), /watchDialog\(modal, \{ label: 'Record payment', onClose: closePay \}\)/);
    assert.match(read("teller", "views", "calendar.ejs"), /watchDialog\(document\.getElementById\('add-bill-modal'\)/);
    const tx = read("teller", "public", "transactions.js");
    assert.match(tx, /watchDialog\(modal, \{ label: 'Add cash transaction', onClose: close \}\)/);
    assert.match(tx, /var splitDlg = openDialog\(/);
    assert.match(tx, /var editDlg = openDialog\(/);
    assert.doesNotMatch(tx.slice(tx.indexOf("var editDlg")), /document\.body\.removeChild\(backdrop\);\s*\n\s*(searchTransactions|return)/);
    assert.match(read("teller", "views", "partials", "nav.ejs"), /panelDlg = window\.openDialog\(panel/);
  });
});

// ---------------------------------------------------------------------------
describe("IF-2 — calendar keyboard access", () => {
  it("payable events are buttons with a pressed state; +N more expands", () => {
    const c = read("teller", "views", "calendar.ejs");
    assert.match(c, /'<button type="button" class="cal-event ' \+ evCls \+ '" data-source="/);
    assert.match(c, /aria-pressed="' \+ \(ev\.is_paid \? 'true' : 'false'\)/);
    assert.match(c, /data-expand="' \+ day\.date \+ '" aria-expanded=/);
    assert.match(c, /onDelegate\('cal-grid', 'click', '\[data-expand\]'/);
  });
});

describe("IF-3 — form controls have accessible names", () => {
  // Every static <input>/<select>/<textarea> with an id needs a <label for>,
  // a wrapping <label>, or an aria-label (hidden/file pickers excepted).
  for (const file of ["transactions.ejs", "housing.ejs", "accounts.ejs", "goals.ejs", "budgets.ejs", "calendar.ejs"]) {
    it(file, () => {
      const s = read("teller", "views", file);
      const forIds = new Set([...s.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
      const missing = [];
      for (const m of s.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
        const attrs = m[2];
        if (/type="(hidden|file|submit|button)"/.test(attrs) || /aria-label=/.test(attrs)) continue;
        const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
        if (!id) continue; // template-built rows are checked by name below
        if (forIds.has(id)) continue;
        const before = s.slice(Math.max(0, m.index - 300), m.index);
        if (/<label[^>]*>(?![\s\S]*<\/label>)[\s\S]*$/.test(before)) continue; // wrapped in a <label>
        missing.push(id);
      }
      assert.deepEqual(missing, []);
    });
  }

  it("template-built controls carry aria-labels", () => {
    const tx = read("teller", "public", "transactions.js");
    assert.match(tx, /class="txn-check" aria-label="Select /);
    assert.match(tx, /class="row-amt" aria-label="Split amount"/);
    assert.match(tx, /'<select aria-label="Split category">'/);
    const dash = read("teller", "views", "dashboard.ejs");
    assert.match(dash, /aria-label="APR percent" data-apr-account=/);
    assert.match(dash, /aria-label="Credit limit" data-limit-account=/);
    assert.match(dash, /aria-label="Monthly payment" data-payment-account=/);
    const hz = read("teller", "views", "housing.ejs");
    assert.match(hz, /class="hz-pick" aria-label="Include /);
    assert.match(hz, /class="hz-in hz-set-amt" aria-label="Bill amount"/);
  });
});

describe("IF-4 — CSS variables are defined", () => {
  it("every var(--x) without a fallback in Perfin's views/public files is defined somewhere", () => {
    const dirs = [["teller", "views"], ["teller", "views", "partials"], ["teller", "public"]];
    const files = dirs.flatMap((d) => fs.readdirSync(path.join(ROOT, ...d))
      .filter((f) => /\.(ejs|css|js)$/.test(f)).map((f) => read(...d, f)));
    const defined = new Set();
    const used = new Set();
    for (const s of files) {
      for (const m of s.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
      for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)\s*\)/g)) used.add(m[1]);
    }
    // --burst-dir is set per element in the login animation (style="--burst-dir:…").
    const undefinedVars = [...used].filter((v) => !defined.has(v) && v !== "--burst-dir");
    assert.deepEqual(undefinedVars, []);
  });
});

describe("IF-5 — light-theme contrast", () => {
  it("text on a solid teal button uses --on-teal (white in light theme)", () => {
    const css = read("teller", "public", "perfin-shared.css");
    assert.match(css, /--on-teal: #000;/);
    assert.match(css, /\[data-theme="light"\][\s\S]*--on-teal: #fff;/);
    for (const f of ["dashboard.ejs", "housing.ejs", "calendar.ejs"]) {
      assert.doesNotMatch(read("teller", "views", f), /background:\s*var\(--teal\);\s*color:\s*#000/, f);
    }
  });

  it("option lists and modal boxes are opaque and themed", () => {
    const css = read("teller", "public", "perfin-shared.css");
    assert.match(css, /select option \{ background: var\(--surface-solid\); color: var\(--text\); \}/);
    assert.doesNotMatch(read("teller", "views", "accounts.ejs"), /option \{ background: #131620/);
    assert.doesNotMatch(read("teller", "views", "dashboard.ejs"), /background:var\(--surface, var\(--bg\)\)/);
    assert.match(read("teller", "views", "transactions.ejs"), /\.modal \{ background: var\(--surface-solid\);/);
  });
});

describe("IF-6 / IF-7", () => {
  it("the PIN pad accepts more than 8 digits and leaves Enter to a focused button", () => {
    const l = read("shell", "views", "login.ejs");
    assert.match(l, /function add\(n\) \{ if \(pin\.length >= MAX_PIN\) return;/);
    assert.match(l, /if \(e\.key === 'Enter' && t && t !== document\.body && !\(t\.closest && t\.closest\('#pin-pad'\)\)/);
    assert.match(l, /\/\^\(BUTTON\|A\|INPUT\|SELECT\|TEXTAREA\)\$\/\.test\(t\.tagName\)\) return;/);
  });

  it("a notification with data.url navigates there (same-app paths only)", () => {
    const n = read("teller", "views", "partials", "nav.ejs");
    assert.match(n, /\/\^\\\/\(\?!\\\/\)\/\.test\(n\.data\.url\)/);
    assert.match(n, /if \(url\) window\.location\.href = \(typeof withBase === 'function'\) \? withBase\(url\) : url;/);
  });
});
