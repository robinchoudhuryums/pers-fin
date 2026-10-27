// ============================================================================
// Seams & Invariants audit #3 (Oct 2026) — Per-sistant-side pins
// ============================================================================
//  X2  the Knowledge finance snapshot lists a charge due TODAY (APP_TIMEZONE
//      calendar date — it measured from now, so today's charge dropped out)
//  C5  the service worker never caches a redirected response (cache v9)
//  O1  knowledge-reindex.yml: a 409 skips the wait; a failure prints counts only
//  INV-104  the standalone /api/login compare is a fixed-length digest compare
// The Perfin-side pins are tests/seams-audit-3.test.js.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("X2 — upcoming charges in the finance snapshot", () => {
  const rag = require("../routes/rag");
  const { todayStr } = require("../routes/health");
  const shift = (ymd, days) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };
  function perfinPool(subs) {
    return { query: async (sql) => {
      if (/FROM detected_subscriptions/.test(sql)) return { rows: subs };
      return { rows: [] };
    } };
  }

  it("today and today+14 are in; yesterday and today+15 are out", async () => {
    const today = todayStr();
    const sub = (name, next) => ({ display_name: name, amount: 10, cadence_days: 30, next_expected: next });
    const doc = await rag.perfinFinanceSnapshot(perfinPool([
      sub("Today", today), sub("Edge", shift(today, 14)),
      sub("Yesterday", shift(today, -1)), sub("Later", shift(today, 15)), sub("None", null),
    ]));
    const line = doc.content.split("\n").find((l) => l.startsWith("Upcoming charges"));
    assert.ok(line, doc.content);
    assert.match(line, new RegExp(`Today \\$10\\.00 on ${today}`));
    assert.match(line, /Edge \$10\.00/);
    assert.doesNotMatch(line, /Yesterday|Later|None/);
  });

  it("a DATE value (node-pg local midnight) prints as its own calendar day", async () => {
    const today = todayStr();
    const [y, m, d] = today.split("-").map(Number);
    const doc = await rag.perfinFinanceSnapshot(perfinPool([
      { display_name: "Gym", amount: 30, cadence_days: 30, next_expected: new Date(y, m - 1, d) },
    ]));
    assert.match(doc.content, new RegExp(`Gym \\$30\\.00 on ${today}`));
  });
});

describe("C5 — the service worker never caches a redirected response", () => {
  it("emits the r.redirected guard and the bumped cache name", async () => {
    const app = express();
    app.use(require("../routes/pwa")({}));
    const sw = (await supertest(app).get("/sw.js").expect(200)).text;
    assert.match(sw, /if \(r\.ok && !r\.redirected\) \{/);
    assert.match(sw, /const CACHE = 'per-sistant-v9';/);
  });
});

describe("O1 — knowledge-reindex.yml", () => {
  const y = read(".github", "workflows", "knowledge-reindex.yml");
  it("a 409 skips the wait step instead of polling a state that isn't ours", () => {
    assert.match(y, /- name: Trigger reindex\n\s+id: trigger\n/);
    assert.match(y, /if \[ "\$STATUS" = "409" \]; then echo "already running"; echo "skip_wait=true" >> "\$GITHUB_OUTPUT"; exit 0; fi/);
    assert.match(y, /- name: Wait for the reindex result\n\s+if: \$\{\{ steps\.trigger\.outputs\.skip_wait != 'true' \}\}\n/);
  });
  it("a failed reindex prints a count, never the status JSON (INV-103)", () => {
    assert.doesNotMatch(y, /JSON\.stringify\(\{reindex/);
    assert.match(y, /console\.log\("reindex failed: files failed=" \+/);
  });
});

describe("INV-104 — standalone login", () => {
  it("compares SHA-256 digests (no length leak, no throw on a multibyte password)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "auth.js"), "utf8");
    const route = src.slice(src.indexOf('router.post("/api/login"'));
    assert.match(route, /crypto\.timingSafeEqual\(digest\(password\), digest\(AUTH_SECRET\)\)/);
    assert.doesNotMatch(route.slice(0, 1200), /Buffer\.from\(String\(password\)\)/);
  });
});
