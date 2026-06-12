// ============================================================================
// Seams & Invariants audit pins (June 2026 seams audit)
// ============================================================================
// Two classes of drift this audit caught, pinned so they can't recur:
//  1. SPLIT_AMOUNT re-inlining — cash-flow + insights anomaly/seasonal held
//     literal copies of the shared-account CASE expression while CLAUDE.md
//     claimed they "cannot drift". All converted to imports/derivations; the
//     scan below fails on any future literal copy.
//  2. critical_alert webhook asymmetry — Perfin's EMAIL_EVENTS sent the event
//     but Per-sistant's HTTP receiver didn't recognize it, so standalone
//     deployments 200-and-dropped critical alerts (embedded in-process path
//     was unaffected).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ---------------------------------------------------------------------------
// 1. SPLIT_AMOUNT single-source-of-truth scan
// ---------------------------------------------------------------------------
describe("SPLIT_AMOUNT is never re-inlined (INV-07 corollary)", () => {
  // The shared-account CASE always contains "is_shared AND <alias>.personal_for".
  // The settlement endpoint's per-bucket FILTERs use bare personal_for
  // comparisons (no is_shared conjunction), so this pattern matches ONLY the
  // split CASE expression.
  const LITERAL_CASE = /is_shared\s+AND\s+\w+\.personal_for/;

  it("no teller route/service besides financial-queries.js contains a literal copy", () => {
    const dirs = [["teller", "routes"], ["teller", "services"]];
    const offenders = [];
    for (const dir of dirs) {
      for (const f of fs.readdirSync(path.join(ROOT, ...dir)).filter(f => f.endsWith(".js"))) {
        if (dir[1] === "services" && f === "financial-queries.js") continue;
        if (LITERAL_CASE.test(read(...dir, f))) offenders.push(dir.join("/") + "/" + f);
      }
    }
    assert.deepEqual(offenders, [],
      "import SPLIT_AMOUNT from services/financial-queries.js (derive aliased variants via .replace) instead of re-inlining the CASE");
  });

  it("sheets-sync.js remains the sole documented script-side copy", () => {
    // Standalone by design (can't require the services layer) — byte-parity
    // with the canonical is separately pinned by SX3 in audit-regressions.
    assert.match(read("scripts", "sheets-sync.js"), LITERAL_CASE);
  });

  it("insights.js consumes the canonical + a derived t2/la2 variant", () => {
    const src = read("teller", "routes", "insights.js");
    assert.match(src, /SPLIT_AMOUNT\s*\}?\s*=\s*require\("\.\.\/services\/financial-queries"\)|,\s*SPLIT_AMOUNT\s*\}/);
    assert.match(src, /SPLIT_AMOUNT_2 = SPLIT_AMOUNT\.replace\(\/\\bla\\\.\/g, "la2\."\)\.replace\(\/\\bt\\\.\/g, "t2\."\)/,
      "anomaly baseline derives its aliased variant in place — never an independent copy");
  });
});

// ---------------------------------------------------------------------------
// 2. Email-event symmetry across the webhook seam
// ---------------------------------------------------------------------------
describe("Perfin email events ↔ Per-sistant receiver symmetry", () => {
  it("every event in Perfin's EMAIL_EVENTS is accepted by the HTTP receiver", () => {
    const sender = read("teller", "routes", "persistent.js");
    const eventsMatch = sender.match(/EMAIL_EVENTS = new Set\(\[([^\]]+)\]\)/);
    assert.ok(eventsMatch, "EMAIL_EVENTS set present in persistent.js");
    const events = [...eventsMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    assert.ok(events.includes("critical_alert"), "critical_alert is an email event");

    const receiver = read("apps", "per-sistant", "routes", "perfin.js");
    for (const ev of events) {
      assert.ok(receiver.includes(`event === "${ev}"`),
        `receiver must accept "${ev}" — an unrecognized email event is 200-and-dropped in standalone deployments`);
      assert.ok(new RegExp(`${ev}:\\s*"`).test(receiver),
        `receiver's sendNameByEvent should name "${ev}"`);
    }
  });
});
