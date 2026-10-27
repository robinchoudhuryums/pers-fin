---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Design pass D5 (`.cycle/plan-design-ux.md`, decision 8) — Settings: groups + index.
- The Settings sections in seven groups (markup moves only; every section's id, handler and script unchanged).
- A sticky index of the groups at ≥961px and a "Jump to" select narrower, both built from the group headings.
- A deep-linked anchor lands on its section, opening a closed <details> first.
New capabilities (G/ST): None
Files modified:
- teller/views/settings.ejs
- tests/design-d5.test.js (new)
- e2e/pages.spec.js
- CLAUDE.md
- README.md
- .cycle/plan-design-ux.md
- .cycle/STATE.md

CHANGES:
D5-groups | teller/views/settings.ejs | The sections were cut into blocks and reassembled under seven `<section class="settings-group" id="group-…" aria-labelledby>` wrappers, each with an `h3.settings-group-title`:
  1. Appearance & Dashboard: Appearance, Pyramid Visualization, Dashboard Widgets, Install App;
  2. Security: Security, Biometric Login;
  3. AI: AI Insights, Transaction Categorization, API Usage History;
  4. Alerts & Notifications: Push Notifications, Cash Alerts, Per-sistant Tasks, CSV Import Reminders;
  5. Sync & Connections: Sync Health (with Operator Checks, Recent errors, Deleted transactions), Bank Auto-Sync, Google Sheets Auto-Sync, Keep-Alive;
  6. Planning: Target Allocation, Watchlist;
  7. Data & Exports: the export rows and the Tax page link.
  - A sorted-line diff against the previous file shows every original line kept; only the wrappers were added, and the five old inline-styled group headings were replaced.
  - The ids are a superset of the old ones: the 132 earlier ids, plus the group, index and select ids.
D5-index | settings.ejs | Markup: `<nav class="settings-index" aria-label="Settings groups"><ol id="settings-index-list">` and a `<label for="settings-jump">Jump to</label>` select. Both are empty in the markup and filled at load.
  - `buildSettingsIndex(doc)` reads every titled `.settings-group` and writes the index links and the select options, escaped.
  - `markCurrentGroup(doc, el)` sets `aria-current` on the index link of the group holding `el`.
  - `revealHashTarget(doc, hash)` handles a deep link: it decodes the hash (a malformed one is ignored), opens a DETAILS target, calls `scrollIntoView({block:'start'})` and marks the group.
  - At load it runs on the hash. It runs again 600 ms after `load` unless the user has scrolled, typed or touched, since the sections above fill in as their requests answer.
  - It also runs on hashchange. The select sets the hash, or re-reveals when the hash is already that group.
D5-css | settings.ejs extraStyles | Below 961px the index is hidden and the select shown. At ≥961px the page is a 190px + 1fr grid: the index is sticky (`top: 16px`), the select hidden, and `#main-content.settings-wide` is 1080px.
  - The base `#main-content { max-width: 860px; }` stays, as D1 pins.
  - Groups, sections with an id, #recent-errors and #deleted-transactions have `scroll-margin-top: 16px`. The top nav isn't sticky, so 16px clears the edge.
  - No backslash in the template literal.
D5-tests | tests/design-d5.test.js (12) |
  - the seven groups in order with their exact headings;
  - each section in its group;
  - every pre-D5 id still on the page exactly once;
  - every `/settings#…` anchor in teller/ and shell/ source (plus the five named in decision 8 and #ai-insights) present;
  - the old inline-styled headings gone;
  - buildSettingsIndex in a vm over a fake DOM: both lists, escaping, an untitled group left out;
  - revealHashTarget: a details element opened, scrolled and its group marked; a div not "opened"; an unknown, empty or malformed hash returns null;
  - markCurrentGroup clearing the mark;
  - the labelled select and index nav (IF-3; the existing IF-3 scan also passes);
  - the CSS rules by width;
  - an EJS render, standalone and under /perfin.
D5-e2e | e2e/pages.spec.js (+1) | At 1280×900, `/perfin/settings#sync-health`, `#deleted-transactions` and `#recent-errors` each land within 200px of the top once settled, the details opened, with Sync & Connections marked in the index. The index lists the seven groups, the select is hidden, and the index stays on screen after scrolling to Data & Exports. At 390×844 the index is hidden; choosing Planning in "Jump to" sets #group-planning and lands on it.

TEST RESULTS:
- npm test 2466/2466 (12 new). The first run of the unchanged suite against the regrouped page passed 2454/2454: no old pin depended on the old structure.
- The new file's first run had 6 failures in the test itself and none in the page:
  - wrong pre-D5 id names;
  - slice markers for the indented `esc`, the media block and the extraStyles end;
  - vm cross-realm deepEqual, now compared as JSON.
- Playwright 71/71 (full run, Settings sweep included).
- Mutation checks 13/13 caught:
  - an anchor id renamed;
  - the index not built from the headings;
  - an unescaped title;
  - the select not filled;
  - details not opened; not scrolled; group not marked;
  - sticky at all widths; the select shown on desktop;
  - no scroll margin;
  - a group heading renamed;
  - the select unlabelled;
  - an octal escape in extraStyles.
- Contract suite not re-run: no server or SQL change.
- Screenshots (1280, 390, seeded): on desktop the index is in a left column beside the seven groups; on the phone, "Jump to" sits above Appearance & Dashboard.
REGRESSION RISKS:
- Settings order changed: Sync Health moved below Alerts & Notifications, and Target Allocation / Watchlist into Planning. This is visible, and it is decision 8's choice.
- The 600 ms re-reveal after load can move the page if a slow request finishes after it. It is skipped once the user scrolls, types or touches.
- Content is wider at ≥961px (1080 vs 860) to fit the index; the sections themselves are about the same width.
- The click sweep now presses the index links and changes the select. They only change the hash; the sweep passed.
INVARIANTS AT RISK: None.
- INV-89 / INV-90: no writes or dialogs added.
- INV-61: untouched.
- INV-95: no guard exemptions.
- INV-116: the widget toggles are unchanged, only inside a group.
- Every `/settings#…` link (data-health, operator checks, the error-log notification, the dashboard) still lands, now pinned by a scan.
NET SCORE: 1 production fix − 0 new failure modes = 1
  (a) YES: Settings was a ~9,000px single column with five loose headings and no way to reach a section but scrolling. A deep link landed on a closed "Deleted transactions" disclosure. This was on every visit.
  (b) No new failure modes. The index is additive and the old markup is unchanged.

OPERATOR ACTIONS / DEPLOY:
- None. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (Web UI ships with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The index marks the deep-linked group, but not the group being scrolled through (no scroll-spy). That's a small addition if wanted.
- A few CLAUDE.md feature notes still name sections by their old card titles ("Settings → AI Insights → …"). The card titles didn't change, only the group around them.
- D4 follow-on still open: no test renders every Perfin view through EJS (the extraStyles octal trap).
DOCUMENTATION UPDATES NEEDED:
- None (done in this batch):
  - CLAUDE.md: the settings.ejs views entry; a Settings layout bullet; "Notifications & Automation" → "Alerts & Notifications"; the page-width note; the test file entry, counts and Playwright description;
  - README: count and line;
  - Plan: D5 DONE.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
