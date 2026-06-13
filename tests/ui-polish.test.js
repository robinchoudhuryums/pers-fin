// ============================================================================
// UI polish round 2 (PWA field-testing feedback)
// ============================================================================
//   - Floating chrome opacity: toasts / notif panel / mobile nav drawer were
//     on 3-10% alpha backgrounds — page content bled straight through
//   - Recent Transactions moved off the dashboard; the Activity page is the
//     transaction surface, with compact 2-line rows on mobile + collapsed
//     filters so the list sits at the top
//   - Dashboard: per-month "Spending by Category" selector backed by a new
//     /api/spending-categories endpoint; four sections collapsible

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ---------------------------------------------------------------------------
// Floating-chrome opacity
// ---------------------------------------------------------------------------
describe("floating chrome uses the opaque surface token", () => {
  const css = read("teller", "public", "perfin-shared.css");

  it("--surface-solid is defined for both themes", () => {
    assert.match(css, /--surface-solid: #151a26;/, "dark token");
    assert.match(css, /--surface-solid: #fdfbf6;/, "light token");
  });

  it("notif panel (+ sticky header), nav drawer, and toasts are opaque", () => {
    assert.match(css, /\.notif-panel \{[^}]*background: var\(--surface-solid\)/s);
    assert.match(css, /\.notif-header \{[^}]*background: var\(--surface-solid\)/s);
    assert.match(css, /\.toast \{ background-color: var\(--surface-solid\); \}/);
    // The drawer previously used translucent var(--surface, #16181d) — the
    // fallback never applied because --surface IS defined.
    const drawer = css.match(/\.topnav \.nav-links \{ display: none;[\s\S]*?\}/);
    assert.ok(drawer && drawer[0].includes("var(--surface-solid)"), "mobile drawer opaque");
  });

  it("toast tints are layered over the solid base, not alpha-only backgrounds", () => {
    assert.match(css, /\.toast\.success \{ background-image: linear-gradient\(var\(--green-bg\), var\(--green-bg\)\)/);
    assert.match(css, /\.toast\.error\s+\{ background-image: linear-gradient\(var\(--red-bg\), var\(--red-bg\)\)/);
  });
});

// ---------------------------------------------------------------------------
// Recent Transactions relocation + compact Activity rows
// ---------------------------------------------------------------------------
describe("Recent Transactions moved to the Activity page", () => {
  it("dashboard no longer renders or loads the recent-transactions table", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    assert.ok(!dash.includes("recent-txn-body"), "section removed");
    assert.ok(!dash.includes("recent-txn-table"), "styles + widget-map entry removed");
    const settingsView = read("teller", "views", "settings.ejs");
    assert.ok(!settingsView.includes("recentTxns"), "widget toggle removed");
  });

  it("Activity page uses compact rows and collapses filters on mobile", () => {
    const tpl = read("teller", "views", "transactions.ejs");
    assert.match(tpl, /class="txn-table txn-compact"/);
    assert.match(tpl, /id="filters-toggle"/);
    assert.match(tpl, /\.search-bar\.open \{ display: flex !important; \}/);
    const js = read("teller", "public", "transactions.js");
    assert.match(js, /filtersToggle\.setAttribute\('aria-expanded'/);
  });

  it("compact grid puts merchant+amount on line 1, date+category+actions on line 2", () => {
    const css = read("teller", "public", "perfin-shared.css");
    assert.match(css, /"check merchant merchant amount"/);
    assert.match(css, /"check date category actions"/);
    assert.match(css, /table\.txn-compact td\[data-label="Account"\] \{ display: none; \}/,
      "account column hidden at compact width (still in the Edit modal)");
  });
});

// ---------------------------------------------------------------------------
// Collapsible sections + per-month category breakdown
// ---------------------------------------------------------------------------
describe("dashboard collapsibles + category month selector", () => {
  const dash = read("teller", "views", "dashboard.ejs");

  it("the four sections are collapsible with distinct persistence keys", () => {
    for (const key of ["monthlySpend", "categories", "merchants", "upcoming"]) {
      assert.ok(dash.includes('data-collapse-key="' + key + '"'), key + " collapsible");
    }
    assert.match(dash, /localStorage\.getItem\(key\) === '1'/, "state persisted");
    assert.match(dash, /e\.target\.closest\('select, button, input, a'\)/,
      "controls inside the h2 (month select) must not toggle collapse");
  });

  it("month selector fetches /api/spending-categories and falls back to the aggregate", () => {
    assert.match(dash, /id="cat-month-select"/);
    assert.match(dash, /\/api\/spending-categories\?month=/);
    assert.match(dash, /renderCategoryRows\(data\.by_category\)/, "default option restores the N-month aggregate");
  });

  it("collapsible CSS hides everything but the header when collapsed", () => {
    const css = read("teller", "public", "perfin-shared.css");
    assert.match(css, /\.section\.collapsed > \*:not\(h2\) \{ display: none !important; \}/);
    assert.match(css, /\.section\.collapsible > h2 \{ cursor: pointer/);
  });
});

// ---------------------------------------------------------------------------
// GET /api/spending-categories (behavioral)
// ---------------------------------------------------------------------------
describe("GET /api/spending-categories", () => {
  const supertest = require("supertest");
  const express = require("express");
  let dbModule, originalPoolQuery, app;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    app = express();
    app.use(require("../teller/routes/enrollments"));
  });

  afterEach(() => { dbModule.pool.query = originalPoolQuery; });

  it("rejects malformed months", async () => {
    await supertest(app).get("/api/spending-categories").expect(400);
    await supertest(app).get("/api/spending-categories?month=2026-13").expect(400);
    await supertest(app).get("/api/spending-categories?month=junk").expect(400);
  });

  it("returns the month's categories sorted by spend (splits-aware helper)", async () => {
    dbModule.pool.query = async (sql) => {
      if (/WITH bounds AS/i.test(sql)) return { rows: [
        { category: "Groceries", spent: "120.00" },
        { category: "Dining", spent: "240.50" },
      ]};
      return { rows: [] };
    };
    const res = await supertest(app).get("/api/spending-categories?month=2026-05").expect(200);
    assert.equal(res.body.month, "2026-05");
    assert.equal(res.body.categories[0].category, "Dining", "sorted descending by spent");
    assert.equal(res.body.categories[1].category, "Groceries");
  });
});

// ---------------------------------------------------------------------------
// Login defaults to Per-sistant + particle-assembly transition
// ---------------------------------------------------------------------------
describe("post-login default + icon particle transition", () => {
  it("successful auth lands in Per-sistant (landing still served at /)", () => {
    const auth = read("shell", "middleware", "auth.js");
    assert.match(auth, /DEFAULT_POST_LOGIN = "\/per-sistant"/);
    const login = read("shell", "views", "login.ejs");
    assert.match(login, /window\.location\.href = '\/per-sistant';/,
      "biometric path must match the PIN path's default destination");
  });

  it("transition samples the icon image into particles (assemble/hold/disperse)", () => {
    const js = read("shell", "public", "transition.js");
    assert.match(js, /getImageData/, "pixel-samples the .atrans-art icon");
    assert.match(js, /ASSEMBLE_MS = 950, HOLD_MS = 430, DISPERSE_MS = 520/);
    assert.match(js, /startParticleAssembly\(overlay, navigate\)/);
    assert.match(js, /data\[i \+ 3\] < 110/, "transparent pixels skipped");
  });

  it("renders hi-fi: fine grid, 3x backing store, full-res image sharpen", () => {
    const js = read("shell", "public", "transition.js");
    assert.match(js, /GRID = 96/, "fine sampling grid (~2.5px particles, not ~4px)");
    assert.match(js, /devicePixelRatio \|\| 1, 3\)/, "dpr cap raised to 3 for retina phones");
    assert.match(js, /ctx\.drawImage\(img, 0, 0, SIZE, SIZE\)/,
      "the real icon crossfades in at full resolution — the finale is never just the particle mosaic");
    assert.match(js, /MAX_PARTICLES = 7500/, "frame-budget cap with uniform thinning");
    assert.match(js, /particleDim/, "particles dim while the sharp image owns the frame");
  });

  it("respects prefers-reduced-motion and keeps the CSS-reveal fallback", () => {
    const js = read("shell", "public", "transition.js");
    assert.match(js, /prefers-reduced-motion: reduce.*matches.*return navigate\(\)/s);
    assert.match(js, /setTimeout\(navigate, 1350\)/,
      "tainted-canvas / unloaded-image path falls back to the original reveal");
  });

  it("is a hybrid: particles on desktop, the lighter CSS reveal on mobile/touch", () => {
    const js = read("shell", "public", "transition.js");
    assert.match(js, /function prefersLightTransition\(\)/, "device gate exists");
    assert.match(js, /\(pointer: coarse\)/, "coarse pointer → light transition");
    assert.match(js, /\(max-width: 768px\)/, "narrow viewport → light transition");
    // The gate short-circuits the particle engine before it ever runs.
    assert.match(js, /prefersLightTransition\(\) \|\| !startParticleAssembly\(overlay, navigate\)/,
      "mobile takes the CSS mask-reveal path; desktop still tries particles");
  });

  it("particle mode hides the mask-reveal art via CSS", () => {
    const css = read("shell", "public", "transition.css");
    assert.match(css, /\.atrans-canvas \{ position: relative; z-index: 3/);
    assert.match(css, /\.atrans-overlay\.atrans--particles \.atrans-art-wrap,\n\.atrans-overlay\.atrans--particles \.atrans-ring \{ display: none; \}/);
  });
});
