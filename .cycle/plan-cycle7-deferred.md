# Cycle 7 — deferred decisions: implementation plan (Batches 14–16)

Decided 2026-10-21 (operator accepted every recommendation). Each batch is sized
for one `/broad-implement Batch N` session. Run them in order: Batch 14 changes the
spending numbers that Batches 15–16's tests read, and Batch 13's budget-parity
contract test must stay green through Batch 14.

## Decisions (final)

| # | Finding | Decision |
|---|---------|----------|
| 1 | F35 → G4 refunds | Net a refund against its category in the month it POSTS; floor each category at $0 per month. Applies everywhere spending is counted. |
| 2 | F53 → G5 watchdog | Alert (push + in-app log, deduped per subscription per charge) on a charge matching a cancelled subscription > 7 days after cancellation, and on a price rise of ≥ 5% or ≥ $1. |
| 3 | F55 → ST2 rename rules | Rename rules on the categorization-rules machinery: "Apply to all past and future" in the Edit modal, exact match by default, applied at sync time. |
| 4 | F26 CSV sign | Ask in the import preview: a "Positive amounts are: charges / deposits" toggle, prefilled by a heuristic. |
| 5 | F81 webhook UI | No standalone UI. Fix the wrong docs / UI / log text and add one Settings toggle to turn insight emails off. |
| 6 | F85 archives | Rebuild automatically when an archived month's data changed (fingerprint on the completion marker). |
| 7 | F134 → ST5 notes | Add a privacy tier to notes (normal / private / secret), default normal. |

---

## Batch 14 — Refund-aware spending (F35 / G4) | about 10–12h

**Definition (one place).** In `teller/services/financial-queries.js` add a
`REFUND_PREDICATE` and a refund-line fragment:
- a refund = `t.amount < 0`, not pending, not reimbursed, passes `NOT_TRANSFER`
  (so card payments and transfers stay out), and is NOT income
  (`NOT incomePredicate("t")`);
- its amount is `SPLIT_AMOUNT` (negative, so the shared-card share and
  `personal_for` apply exactly as on charges);
- its category = `user_category`, else the category of the most recent earlier
  charge from the same display merchant (`COALESCE(user_merchant_name,
  merchant_name, name)`, case-insensitive, within 180 days), else the provider
  category, else 'Uncategorized'. Credits are never categorized today (the free
  maps and the AI only touch debits), so inheritance is what makes the netting
  land in the right budget.

**Netting rule.** Per (month, category): `GREATEST(0, charges + refunds)`.
A month's total = the sum of its floored categories, so a refund can never make a
month or category negative, and an unmatched refund only reduces "Uncategorized".

**Where it applies (all through the helpers, never re-inlined — INV-48):**
- `getCategorySpendingForMonth` (add a `refund_lines` CTE next to
  `parent_no_splits` / `from_splits`) → budgets, `getBudgetStatus`, alerts, push,
  snapshots, Ask, insights budget block, `/api/spending-categories`.
- `getMonthlySpending` (rebuild on the category lines) → savings rate, FIRE,
  context export, AI monthly trends.
- `/api/spending-summary` (`monthly_trend`, `by_category`, `top_merchants` — a
  merchant's refunds net against that merchant), `/api/spending-yoy`.
- Insights seasonal block.
- `scripts/sheets-sync.js` mirror: `cat_lines` gains the refund lines + the
  floor; the monthly totals use the same lines. Extend the SX3 pin to the new
  fragment.
- **Unchanged on purpose:** the cash-flow forecast (projects cash out; refunds are
  irregular inflows), anomaly detection (charge-level), the tax report
  (charge-level), the shared-card settlement (already nets refunds — FAN-12; switch
  it to the shared predicate only if that is a no-op).

**Tests:** unit pins for the predicate (transfer credit, payroll credit, card
payment, reimbursed credit and pending credit all excluded); contract tests on
real Postgres — a $50 refund on a $200 charge nets the category to $150 in the
refund's posting month; a refund larger than the month's charges floors at $0; an
uncategorized refund inherits the merchant's last category; a shared-card refund
at 50%; budgets, `/api/spending-summary` and `getMonthlySpending` agree; the
Batch 13 `budget-parity` test gains a refund row and must stay green.

**Invariants:** extend INV-07/INV-08 wording; new INV — "every spending
aggregation nets refunds through the shared refund lines, floored per category
per month; cash flow / anomaly / tax stay charge-level".

---

## Batch 15 — Subscription watchdog + merchant rename rules (F53 / G5, F55 / ST2) | about 12–14h

### G5 — subscription watchdog (about 5h)
- Migration: `detected_subscriptions.previous_amount NUMERIC(12,2)` (set by the
  detection upsert when the amount changes), `price_alerted_amount`, and a
  `still_charging_alerted_txn TEXT` (last alerted transaction id).
- `runSubscriptionWatchdog(pool)` (scripts/detect-subscriptions.js or a new
  helper beside it), run after detection in every detection path (POST
  /api/detect, the pre-insights chain, daily-sync's detect step):
  - **Still charging:** a cancelled subscription (`cancelled_at` set) with a
    non-pending charge whose display merchant matches its merchant key, amount
    within ±25% of the subscription amount, dated > `cancelled_at` + 7 days, and
    not the already-alerted transaction → `sendToAll` "<Name> charged $X after
    you cancelled it" (tag `sub-still-charging-<id>`), store the txn id. Also
    critical-alert email when that toggle is on.
  - **Price rise:** an active subscription whose amount rose vs
    `previous_amount` by ≥ 5% or ≥ $1, not yet alerted at this amount → "<Name>
    went up from $A to $B" (tag `sub-price-<id>`), store the amount.
- Subscriptions page: a "Still charging" badge and a "Price up $X" badge; the
  "Since you last looked" feed and the daily digest list both events.
- Tests: unit (thresholds, ±25% match, 7-day grace, dedup by txn / amount) +
  contract (cancel → later charge → one notification; a second sync doesn't
  re-notify; $15.49 → $17.99 notifies once).

### ST2 — merchant rename rules (about 8h)
- Migration: `merchant_rename_rules (id, pattern, match_type DEFAULT 'exact',
  rename_to, is_active, times_applied, created_at, updated_at)`, UNIQUE
  (pattern, match_type); add it to reset-fresh's `WIPE_TABLES` (INV-81).
- Reuse `RULE_ORDER_SQL` / `rulePatternError` / `MIN_PATTERN_LENGTH` from
  categorize-helpers.js. The pattern matches the RAW merchant
  (`COALESCE(merchant_name, name)`), never the user override.
- `applyRenameRules(pool, { onlyNew })`: sets `user_merchant_name` where it is
  NULL (a hand-edited single row always wins); called in `syncAllTransactions`
  after both providers and BEFORE the anomaly check, after CSV import and manual
  entry, and from `POST /api/merchant-rename-rules/apply`.
- `PATCH /api/transactions/:id` accepts `apply_to_all: true` with a
  `merchant_name` change: creates the rule, applies it to past rows, then re-runs
  subscription + transfer detection; a detected row whose merchant key no longer
  matches any transaction's display name is deactivated (folded into the new
  key) — this is the actual F55 fix.
- Endpoints: GET/POST/DELETE `/api/merchant-rename-rules`; the Edit modal gets
  the checkbox; Settings lists rename rules next to categorization rules.
- Order of operations: rename → categorize (rules match the display name, so a
  renamed merchant hits its category rule).
- Tests: rule ordering + short-pattern 400; contract — rename one "AMZN Mktp
  US*1A2B" row with apply-to-all → every past + newly synced variant shows
  "Amazon", detection keeps ONE subscription, a hand-renamed row is untouched.

---

## Batch 16 — Imports, exports and privacy (F26, F81, F85, F134 / ST5) | about 12h

### F26 — CSV sign in the preview (about 3h)
- `csv-formats.js`: the generic parser takes `positiveMeans: 'charges' |
  'deposits'`; `guessGenericSign(rows)` (rows whose description says
  payroll / deposit / payment / refund mostly positive → 'deposits').
- `POST /api/import-csv/preview` returns `sign_guess` + `positive_means`; both
  routes accept `positive_means` (shared `parseCsvUpload`, so preview and commit
  can't disagree); the modal and the Accounts page show the toggle only for the
  generic format. CLI: `--positive-means=deposits`.
- Known-format parsers are untouched. Note in docs: re-importing a file with the
  opposite choice creates new IDs (duplicates) — the toggle is for the first import.

### F81 — webhook text + insight-email toggle (about 1.5h)
- `user_settings.insight_emails_enabled BOOLEAN NOT NULL DEFAULT true`; the
  insights path skips `insights_generated` when false (shell and standalone);
  Settings → AI Insights toggle; PATCH validation (INV-59).
- Fix settings.ejs:152's "Per-sistant integration below" and any log line that
  names a nonexistent Settings section; point standalone users at
  `PATCH /api/settings`.

### F85 — rebuild stale month archives (about 3h)
- The completion marker becomes `Perfin archive complete — YYYY-MM · <fp>`,
  where `<fp>` = the first 12 hex of `md5(string_agg(transaction_id || amount ||
  COALESCE(user_merchant_name,'') || COALESCE(user_category,'') || is_reimbursed,
  ',' ORDER BY transaction_id))` over the month's rows (plus their splits). One
  grouped query per run computes the live fingerprint for every archived month;
  a mismatch (or a legacy marker with no fingerprint) clears and rebuilds that
  tab, within `MAX_ARCHIVES_PER_RUN`. (`transactions` has no `updated_at`, so a
  content hash is what catches both backfilled rows and later edits.)
- Tests: the stateful fake Sheets API — backfill a row into an archived month →
  the next run rebuilds exactly that tab; an unchanged month is untouched; legacy
  markers rebuild once.

### F134 / ST5 — notes privacy tier (about 4h)
- Per-sistant migration: `notes.sensitivity TEXT NOT NULL DEFAULT 'normal'
  CHECK (sensitivity IN ('normal','private','secret'))`.
- Only `normal` notes are embedded, keyword-retrieved or sent to the AI:
  `vault-sync.syncNotes` (and it DELETES chunks / embed_state for a note that is
  no longer normal), `rag.js` note retrieval + corpus version,
  `routes/ai.js` (Ask / review context), the daily briefing, search snippets.
- Notes page: a sensitivity selector; a secret note's body is masked in lists
  until revealed.
- Tests: unit + contract — a private note never reaches retrieval or an AI
  prompt; flipping a note to private removes its chunks; the KR / INV-27 tests
  stay green. Extend INV-27 to notes.
- OPERATOR: none required (existing notes stay `normal`); a full reindex is not
  needed because syncNotes re-evaluates every note.

---

## Not in these batches
Expansion work stays separate: E1 (G1 remaining + G2 remaining, with ST4 moved in),
E2 (G3 Plaid update mode, ST1 async /api/sync), E4 leftovers (ST3 tidy-up).
