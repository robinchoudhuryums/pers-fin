// ============================================================================
// Broad-scan (Sept 2026) Batch 15 — test-quality guards
// ============================================================================
// TQ-2  the real-Postgres route contract suite (tests/contract/) is wired into
//       CI and can't silently mount nothing
// Source guards (no finding ID — the classes behind WUI-1/WD-14, WUI-3, IF-4):
//   - no un-nonced <style> reaches Perfin's nonce-only styleSrcElem
//   - client-side navigation never uses a root-relative app path without the
//     mount base (works standalone, 404s / misfires under the shell)
//   - every var(--x) without a fallback is defined (Per-sistant + shell; Perfin
//     is pinned by tests/scan-sept-batch13.test.js IF-4)
// A guard that finds a pre-existing gap lists it in KNOWN_GAPS with a reason;
// the guard fails on any NEW offender AND on a stale KNOWN_GAPS entry, so the
// list shrinks as gaps are fixed.
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
function walk(dir, exts) {
  const out = [];
  (function w(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) w(p);
      else if (exts.some((e) => f.endsWith(e))) out.push(p);
    }
  })(path.join(ROOT, dir));
  return out;
}

// ---------------------------------------------------------------------------
describe("TQ-2 — the real-Postgres contract suite is wired in", () => {
  const pkg = JSON.parse(read("package.json"));
  const ci = read(".github", "workflows", "ci.yml");
  const files = fs.readdirSync(path.join(ROOT, "tests", "contract")).filter((f) => f.endsWith(".test.js"));

  it("npm run test:contract runs tests/contract/*.test.js, and plain npm test doesn't need a database", () => {
    assert.equal(pkg.scripts["test:contract"], "node --test tests/contract/*.test.js");
    assert.ok(!/tests\/contract/.test(pkg.scripts.test), "npm test stays database-free");
  });

  it("CI runs it against the Postgres service with CONTRACT_DATABASE_URL set", () => {
    assert.match(ci, /run: npm run test:contract\s+env:\s+CONTRACT_DATABASE_URL: postgres:\/\/postgres:ci@localhost:5432\/postgres/);
  });

  it("covers housing, financial queries, calendar, exports, settle-up, transactions and Per-sistant", () => {
    const all = files.map((f) => read("tests", "contract", f)).join("\n");
    for (const route of ["/api/housing/obligations/", "/api/shared-settlement", "/api/settlement/settle", "/api/bill-calendar",
      "/api/export?type=transactions", "/api/export/tax-report", "/api/context-export", "/api/transactions/bulk-category",
      "/api/income-summary", "getNetWorth", "getBudgetStatus", "/api/todo-templates/", "/api/jobs"]) {
      assert.ok(all.includes(route), route);
    }
  });

  it("every contract file skips without a database and uses its own scratch database", () => {
    const names = new Set();
    for (const f of files) {
      const s = read("tests", "contract", f);
      assert.match(s, /\{ skip: SKIP \}/, f);
      const m = s.match(/(?:perfinDb|persistentDb)\("([a-z0-9_]+)"\)/);
      assert.ok(m, f + " creates a database");
      assert.ok(!names.has(m[0]), f + " shares a database name");
      names.add(m[0]);
    }
  });

  it("the route-order parsers in _setup still match teller/server.js and apps/per-sistant/server.js", () => {
    const setup = read("tests", "contract", "_setup.js");
    const perfinRe = /app\.use\(require\("\.\/routes\/([\w-]+)"\)\)/g;
    const psRe = /app\.use\(require\("\.\/routes\/([\w-]+)"\)\(deps\)\)/g;
    assert.ok(setup.includes(perfinRe.source) && setup.includes(psRe.source), "setup uses these exact patterns");
    const tellerSrc = read("teller", "server.js");
    const psSrc = read("apps", "per-sistant", "server.js");
    assert.equal([...tellerSrc.matchAll(perfinRe)].length, (tellerSrc.match(/app\.use\(require\("\.\/routes\//g) || []).length,
      "every Perfin router mount is picked up");
    assert.equal([...psSrc.matchAll(psRe)].length, (psSrc.match(/app\.use\(require\("\.\/routes\//g) || []).length,
      "every Per-sistant router mount is picked up");
  });
});

// ---------------------------------------------------------------------------
describe("Guard — no un-nonced <style> under Perfin's nonce-only styleSrcElem", () => {
  // tests/scan-sept-fixes.test.js pins the views' <style> tags and
  // createElement('style') in teller/public. This closes the remaining doors:
  // inline view scripts, the page modules, and '<style' written via innerHTML.
  const files = [...walk("teller/views", [".ejs"]), ...walk("teller/public", [".js"]), ...walk("teller/pages", [".js"])];

  it("no runtime <style> injection anywhere in Perfin client code", () => {
    const offenders = [];
    for (const f of files) {
      const s = fs.readFileSync(f, "utf8");
      if (/createElement\(\s*['"]style['"]\s*\)/.test(s)) offenders.push(rel(f) + ": createElement('style')");
      if (/['"`][^'"`\n]*<style\b/.test(s.replace(/<style\b(?:<%[\s\S]*?%>|[^>])*>/g, ""))) offenders.push(rel(f) + ": '<style' in a JS string");
    }
    assert.deepEqual(offenders, []);
  });

  it("any <style> tag a Perfin page module emits carries the nonce", () => {
    const offenders = [];
    for (const f of walk("teller/pages", [".js"])) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/<style\b[^>]*>/g)) {
        if (!/nonce=/.test(m[0])) offenders.push(rel(f) + ": " + m[0]);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

// ---------------------------------------------------------------------------
// Root-relative navigation. Under the unified shell Perfin lives at /perfin and
// Per-sistant at /per-sistant, so a literal '/budgets' or '/todos' used to
// navigate (href, location, window.open, openWindow) or to compare against
// location.pathname is wrong unless the mount base is added (WUI-3). fetch()
// paths are exempt — both apps' fetch wrappers prefix the base.
// ---------------------------------------------------------------------------
const ROOT_OWNED = new Set(["login", "logout", "per-sistant", "perfin", "shell-static", "api"]);
function pagePaths() {
  const perfin = new Set();
  for (const f of walk("teller/pages", [".js"])) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/router\.get\("\/([a-z][\w-]*)/g)) perfin.add(m[1]);
  }
  const ps = new Set();
  for (const m of read("apps", "per-sistant", "server.js").matchAll(/app\.get\("\/([a-z][\w-]*)"/g)) ps.add(m[1]);
  return { perfin, ps };
}
const NAV_CONTEXT = /(href|location|pathname|open|openWindow|assign|replace)\b/;
const BASE_NEARBY = /\b(BASE_PATH|BASE|BP|withBase|basePath|__basePath|b)\s*(\+|\()|withBase\(|BASE_PATH\s*\|\|/;

function rootRelativeOffenders(files, pages) {
  const out = [];
  for (const f of files) {
    let src = fs.readFileSync(f, "utf8");
    // EJS scriptlets (<% … %>, not <%= / <%-) run on the server, where the
    // view adds __basePath itself; blank them out, keeping line numbers.
    if (f.endsWith(".ejs")) src = src.replace(/<%(?![=-])[\s\S]*?%>/g, (m) => m.replace(/[^\n]/g, " "));
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (/navBar\(/.test(line)) return; // server-side helper — adds the base itself
      for (const m of line.matchAll(/(['"])\/([a-z][\w-]*)(?=[/'"?#])/g)) {
        const seg = m[2];
        if (ROOT_OWNED.has(seg) || !pages.has(seg)) continue;
        const before = line.slice(Math.max(0, m.index - 90), m.index);
        if (!NAV_CONTEXT.test(before) && !/href=/.test(before)) continue; // not a navigation/compare use
        if (BASE_NEARBY.test(before)) continue;
        out.push(`${rel(f)}:${i + 1}: ${t.slice(0, 120)}`);
      }
    });
  }
  return out;
}

describe("Guard — client navigation always carries the mount base", () => {
  const { perfin, ps } = pagePaths();
  // Pre-existing gaps (not fixed in Batch 15 — follow-ons). Each entry is a
  // `file:line-substring`; remove it when fixed (a stale entry fails the test).
  const KNOWN_GAPS = [
    // Palette picker never appears under the shell: pathname is /per-sistant/settings.
    "apps/per-sistant/views/settings-patch.js: if (location.pathname !== '/settings') return;",
  ];

  it("found the page lists to check", () => {
    assert.ok(perfin.has("budgets") && perfin.has("housing") && ps.has("todos") && ps.has("settings"));
  });

  it("Perfin client JS + view scripts", () => {
    const files = [...walk("teller/public", [".js"]).filter((f) => !f.endsWith("sw.js")), ...walk("teller/views", [".ejs"])];
    assert.deepEqual(rootRelativeOffenders(files, perfin), []);
  });

  it("Per-sistant page scripts and client bundles (known gaps listed)", () => {
    const files = [...walk("apps/per-sistant/pages", [".js"]), ...walk("apps/per-sistant/views", [".js"])];
    const found = rootRelativeOffenders(files, ps).map((s) => s.replace(/:\d+: /, ": "));
    const fresh = found.filter((s) => !KNOWN_GAPS.includes(s));
    const stale = KNOWN_GAPS.filter((g) => !found.includes(g));
    assert.deepEqual(fresh, [], "new root-relative navigation");
    assert.deepEqual(stale, [], "a KNOWN_GAPS entry was fixed — remove it from the list");
  });

  it("the service worker prepends BASE to notification targets", () => {
    assert.match(read("teller", "public", "sw.js"), /const url = target\.startsWith\('\/'\) \? BASE \+ target : target;/);
  });

  it("the scanner itself flags an un-based page path and passes a based one", () => {
    const tmp = path.join(ROOT, "tests", ".tmp-guard-sample.js");
    fs.writeFileSync(tmp, "location.href = '/budgets';\nlocation.href = BASE + '/budgets';\nfetch('/budgets');\n");
    try {
      const out = rootRelativeOffenders([tmp], new Set(["budgets"]));
      assert.equal(out.length, 1);
      assert.match(out[0], /:1: location\.href = '\/budgets'/);
    } finally { fs.unlinkSync(tmp); }
  });
});

// ---------------------------------------------------------------------------
function undefinedVars(files, allow = []) {
  const defined = new Set(allow), used = new Map();
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
    for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)\s*\)/g)) {
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1]).add(rel(f));
    }
  }
  return [...used.keys()].filter((v) => !defined.has(v)).sort();
}

describe("Guard — CSS variables are defined (Per-sistant + shell)", () => {
  it("shell views + public assets", () => {
    const files = [...walk("shell/views", [".ejs"]), ...walk("shell/public", [".css", ".js"])];
    // --burst-dir is set per particle in an inline style="--burst-dir:…".
    assert.deepEqual(undefinedVars(files, ["--burst-dir"]), []);
  });

  it("Per-sistant pages + views (known legacy gaps listed)", () => {
    const files = [...walk("apps/per-sistant/pages", [".js"]), ...walk("apps/per-sistant/views", [".js"]),
      path.join(ROOT, "apps/per-sistant/views.js"), path.join(ROOT, "apps/per-sistant/routes/auth.js")];
    // Pre-existing (follow-on): views/js.js (undo toast, offline banner, renderMd)
    // still uses the pre-redesign variable names, which the current Per-sistant
    // CSS no longer defines — those elements render with no background/colour.
    const KNOWN_GAPS = ["--border", "--green", "--surface-2", "--teal", "--text", "--text-muted", "--warm", "--yellow"];
    const found = undefinedVars(files);
    assert.deepEqual(found.filter((v) => !KNOWN_GAPS.includes(v)), [], "new undefined CSS variables");
    assert.deepEqual(KNOWN_GAPS.filter((v) => !found.includes(v)), [], "a KNOWN_GAPS variable is now defined — remove it");
  });
});
