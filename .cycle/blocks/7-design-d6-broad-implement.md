---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Design pass D6 (`.cycle/plan-design-ux.md`, decisions 9, 10, 12) — Per-sistant alignment + shared tokens.
- Decision 9: `design/tokens.json` (status colours dark / light, type scale, spacing, radius, button heights) and the matching declarations in both apps, with Per-sistant's status colours and card radius unified onto the shared values.
- Decision 10: Per-sistant buttons in sentence case and the UI font; the primary filled, danger outlined, monospace kept for labels only.
- Decision 12: Per-sistant's `emptyState` (views/primitives.js) on the dashboard Scheduled Emails and calendar day, the To-Dos, Notes and Contacts lists and Job Radar's lists.
New capabilities (G/ST): None
Files modified:
- design/tokens.json (new)
- teller/public/perfin-shared.css
- apps/per-sistant/views/css.js
- apps/per-sistant/views/css-components.js
- apps/per-sistant/views.js
- apps/per-sistant/views/primitives.js
- apps/per-sistant/views/js.js
- apps/per-sistant/pages/analytics.js, contacts.js, dashboard.js, dashboard-script.js, emails.js, health.js, jobs.js, notes.js, settings.js, settings-script.js, todos.js, todos-script-1.js
- apps/per-sistant/routes/auth.js
- tests/design-tokens.test.js (new)
- apps/per-sistant/tests/design-d6.test.js (new)
- CLAUDE.md, README.md, apps/per-sistant/CLAUDE.md
- .cycle/plan-design-ux.md, .cycle/STATE.md

CHANGES:
D6-spec | design/tokens.json | The shared values, with each app's source file, scopes and variable names:
  - status ok / warn / danger / info, dark and light (Perfin's existing WCAG-tuned values);
  - type 12 / 13 / 14 / 16 / 20 / 28;
  - space 4 / 8 / 12 / 16 / 24 / 32;
  - radius card 12 / control 8 / pill 999;
  - button height 32 / 40 / 44.
  The app_specific lists (Perfin `--bg`, `--warm`, `--teal`…; Per-sistant `--paper`, `--accent`, the fonts…) are checked to exist but never compared.
D6-perfin | teller/public/perfin-shared.css | `:root` declares `--fs-*`, `--space-*`, `--radius-card|control|pill`, `--btn-h-sm|-h|-touch`; `--radius` is `var(--radius-card)` (still 12px).
  - The control min-height rule reads `var(--btn-h)` / `var(--btn-h-touch)` (40 / 44 as before).
  - `.btn` uses `var(--radius-control)` (8px as before).
  - The status colours were already `--green` / `--yellow` / `--red` / `--blue`.
  - No Perfin value changed.
D6-ps-tokens | apps/per-sistant/views/css.js | `:root` declares the light status colours (`--status-ok|warn|danger|info`) and the same type / space / radius / button-height tokens.
  - `body[data-mode="dark"]` and the legacy `html[data-theme="dark"] body` declare the dark status colours.
  - `--good` / `--warn` now resolve on `body` as `var(--status-ok)` / `var(--status-danger)`. On `:root` they would always be the light values.
  - The six palettes no longer set their own `--good` / `--warn`, so the values are unified.
  - `--radius` is the shared card radius (3px → 12px).
  - The sidebar collapse button uses the UI font, no caps.
D6-ps-buttons | apps/per-sistant/views/css-components.js, views.js | `.btn, .actions button`: UI font at `--fs-sm`, no uppercase or letter-spacing, `--radius-control`, min-height `--btn-h-sm` (`--btn-h-touch` at ≤640px).
  - `.primary` stays filled with the accent; `.danger` stays outlined red.
  - `.filters` tabs, inputs and selects use the control radius; the tabs use the UI font.
  - The appbar mode toggle, cross-app link and Ask button use the UI font, no caps.
  - Labels (`.section h2`, card labels, table headers, badges) keep the monospace caps.
D6-labels | pages/*.js, views/js.js, routes/auth.js | The 36 button labels written in Title Case are sentence case ("Send Now" → "Send now", "+ New Task" → "+ New task", "Sign In" → "Sign in", …), plus "Notifications enabled" set by settings-script.
  - Modal titles (headings) are unchanged.
  - Nothing compared a label's text: the existing tests and e2e passed unchanged.
D6-empty | views/primitives.js (+ css-components.js) | `emptyState({ title, text, action: { label, href } | { label, click }, compact })` is Perfin's helper for Per-sistant.
  - Everything is escaped. An href must be a same-app path (not "//", no backslash) and is joined with `BASE_PATH`.
  - `click` names the page's existing button, which one delegated handler presses, so there is no new write path.
  - It is exposed as `window.emptyState` and `PsPrimitives.emptyState`. `.empty-state*` styles are on the spacing tokens.
  - The backslash check is `String.fromCharCode(92)`, because a `'\\'` in the template literal emitted a broken bundle (INV-97's trap — caught by `node --check` of the emitted string).
  - Applied to:
    - dashboard Scheduled Emails ("+ Compose" → /emails);
    - the dashboard calendar day (compact, "+ New task" → /todos);
    - To-Dos (filtered / empty wording, "+ New task" presses `add-task-btn`);
    - Notes ("+ New note");
    - Contacts ("+ Add contact");
    - Job Radar top matches ("Edit profile") and the Saved / Applied / Dismissed lists ("Back to the radar" — the Radar view button gained `id="jr-view-radar"`).
    - The verify-first list uses a plain compact empty state.
D6-tests | tests/design-tokens.test.js (61) |
  - the spec's values and that every shared key is named in both apps;
  - each shared value declared with the spec's value in the right scope of each app;
  - app-specific names present and not shared;
  - the card radius on both apps;
  - Perfin's button heights / radius on the tokens;
  - no Per-sistant palette setting a status colour, `--good` / `--warn` on body, the legacy dark selector's status colours;
  - Per-sistant's buttons on the height / radius tokens.
D6-tests | apps/per-sistant/tests/design-d6.test.js (18) |
  - `emptyState` in a vm from the emitted bundle: it parses, escaping, a BASE_PATH link, unsafe hrefs not linked, no control without a label, the delegated click including a missing target, compact;
  - its styles;
  - each listed site with its action and the action's button on the page; the old lines gone;
  - no uppercase / monospace / letter-spaced button rule; the filled primary, outlined danger;
  - a Title Case label scan over pages, views, views.js and the login.
  - INV-97's regex guard and the `var(--x)` guard pass unchanged.

TEST RESULTS:
- npm test 2545/2545 (79 new: 61 + 18). The unchanged suite passed on the first run after the changes; no old pin read the button CSS or labels.
- Playwright 71/71: full run, both apps' pages and click sweeps.
- Mutation checks 16/16 caught:
  - a Perfin type value drifting; a Per-sistant radius drifting; a dark status colour drifting; a light status token missing;
  - a palette overriding `--good` again; `--good` moved to `:root`;
  - Perfin's button height as a literal;
  - Per-sistant buttons uppercase again; filter tabs monospace again; the primary outlined;
  - emptyState unescaped / linking any href / ignoring BASE_PATH / no delegated click;
  - a Title Case label back;
  - the To-Dos empty state without its action.
- Contract suite not re-run: no server or SQL change.
- Screenshots of both apps at 1280 and 390, seeded:
  - Per-sistant buttons in sentence case (filled "+ New task", outlined "Quick add / From template / Select"), cards 12px-rounded, controls 8px;
  - the dashboard's "No scheduled emails" with "+ Compose" and the calendar day's "Nothing on this day" with "+ New task";
  - the 44px buttons on the phone.
  - Perfin pages are unchanged.
REGRESSION RISKS:
- Per-sistant looks different on every page: rounded cards and controls, sentence-case buttons in the UI font, and status colours that no longer shift with the palette (e.g. forest's greener `--good`). These are decisions 9 / 10, stated in the plan; the palette's accent and paper are unchanged.
- Per-sistant `.btn` is taller (min 32px, was ~26) and 44px on a phone. Dense rows (job cards, settings lists) take a little more room.
- The status colours in light mode are Perfin's light values (`#2d9f5f` ok, `#c94444` danger), close to the old oklch ones but not equal; `--warn`-coloured text (failed badges, urgent) is now `#c94444` on paper.
- `.btn.primary`'s text stays `var(--paper)` on the accent. In the light copper palette that pair is about 3:1. This predates D6 (the plan's "accent ink" text needs a per-palette on-accent colour — follow-on).
- `emptyState` adds one document click listener per Per-sistant page. It returns early unless the target is inside `[data-empty-click]`.
INVARIANTS AT RISK: None.
- INV-97 (no single-escaped regex): the guard passes. The one backslash attempt was caught before commit and replaced.
- INV-95 (var guard): every new `var(--x)` is defined.
- INV-92 / INV-63: views/js.js only had one label changed.
- INV-129 (withPending): untouched.
- INV-130: the click sweep passed. New empty-state buttons are non-destructive (navigate or open a form).
- INV-148 (D7) is anticipated by tests/design-tokens.test.js.
NET SCORE: 2 production fixes − 0 new failure modes = 2
  (a) YES for both, visible on every Per-sistant page:
  - the two apps' status colours, radius, type and button shapes differed for no reason and Per-sistant's actions were monospace caps (decisions 9 / 10);
  - Per-sistant's empty lists only said "nothing here" (decision 12).
  (b) No new failure modes. The template-literal backslash was found and fixed before commit, and a test now runs the emitted bundle.

OPERATOR ACTIONS / DEPLOY:
- None. | BLOCKS DEPLOY: N
Deploy: Render auto-deploys on push to `main` (both apps' web UI ships with the main deploy); no Apps Script change.

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Per-sistant `.btn.primary` text on the light accent (~3:1 in copper; white on mono's black is fine). A per-palette `--on-accent` would fix it.
- The tokens are declared and used for buttons, controls, cards and empty states. Most other font sizes and paddings in both apps are still literals on the same scale; a later pass could move them onto `--fs-*` / `--space-*` (the parity test already guards the values).
- Select options and modal titles in Per-sistant still use Title Case ("All Horizons", "New Task"). They aren't buttons; the plan's casing decision covers buttons only.
- Per-sistant empty states not in D6's list (Review, Today, Analytics, Health, Knowledge facts, templates) keep their plain line.
- css-palette.js is an empty legacy export (its comment says it is safe to delete). Left as is.
DOCUMENTATION UPDATES NEEDED:
- None (done in this batch):
  - CLAUDE.md: `design/tokens.json` in Other key files and the Web UI subsystem; a Shared design tokens bullet; test entries and counts;
  - apps/per-sistant/CLAUDE.md: the Design System section rewritten (it described Perfin's palette), the test file entry and counts;
  - README: count and line;
  - Plan: D6 DONE.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
