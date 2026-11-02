# Plan — Seams & Invariants audit #4 fixes (S4-1 … S4-5)

Source: `.cycle/blocks/8-seams4-audit.md` (24 findings, all re-verified against the code; S2 also on real
Postgres). Everything the audit looked at is on `main` and deployed since PR #134 merged (2026-11-02), so
the clocks are real now: **B2's false Sync Health warning appears ~36 h after the deploy**, and **A1 can
silence a rent / utility reminder today**.

Each batch is sized for one `/broad-implement S4-n` session and one PR. Finding IDs are the audit's
session-local IDs (A = cross-app, B = scheduler / ops, S = shared source of truth, C = client ↔ server).

## Suggested order

| # | Batch | Findings | Size | Why this position |
|---|-------|----------|------|-------------------|
| 1 | S4-1 Live-deploy hotfixes | A1, B2, S2, B3, C1 | M | Each one hides or loses something real today; B2 is on a ~36 h clock |
| 2 | S4-2 Scheduler & operator hardening | B1, B5, B6, B4, A3 | M | B1: one hung call stops every job; B4 is an INV-126 FAIL |
| 3 | S4-3 Forecast, freshness & restore correctness | S1, S3, S6, S4, S5 | M | Wrong numbers / buttons, but bounded (Low each) |
| 4 | S4-4 Cross-app notification seam | A2, A6, A5, A4 | S | Low; A2 / A6 build on S4-1's A1 change |
| 5 | S4-5 UI correctness | C2, C3, C4, C5, C6 | S–M | Display-only Lows; C2 completes INV-157 |

After S4-5: `/test-sync`, `/sync-docs` (add INV-155..157 — see the end), then `/reflect` or the next `/broad-scan`.

---

## S4-1 — Live-deploy hotfixes (ship first, within ~36 h)

| ID | Sev | Files | Fix |
|----|-----|-------|-----|
| A1 | Medium | `teller/routes/notifications.js` (sendToAll ~L295–319; release ~L385–388) | Write `push_state` from the delivery result, not before it: `r.sent === 0` (no live subscription, every send failed) → `'none'`, `'sent'` only when ≥1 device took it. Same rule in `releaseHeldNotifications` (a release with 0 delivered → `'none'`, not `'sent'`). `logged` keeps its meaning. Per-sistant's `perfinPushedItems` then raises its own notification. |
| B2 | Medium | `teller/routes/settings.js` gatherDataHealth (~L623–631), `teller/startup.js` onCheck, `teller/services/job-health.js` | The `job-watchdog` row's `last_run_at` never moves after insert. Recommended: the runner's per-check tick covers every REGISTERED job (the watchdog included), so `last_run_at` stays live; alternatively read `GREATEST(last_run_at, last_ran_at)` in gatherDataHealth. Give `job-watchdog` a proper `thresholdMs` (its 6 h cadence, not the 1 h fallback). |
| S2 | Medium (INV-124 FAIL) | `teller/routes/merchant-rename.js` rekeyDetectedRows (L70), createRenameRule (L111), updateRenameRule | Re-key one survivor per `(new key, cadence)` (`DISTINCT ON` — keep the row with user state: cancelled / dismissed / notes / forecast setting, else newest), deactivate the rest BEFORE the UPDATE so it can't hit the unique index; carry the forecast setting onto the survivor (E1 follow-on rule). Run createRenameRule / updateRenameRule in ONE transaction (client + BEGIN/COMMIT, ROLLBACK on error) so a failure leaves neither the rule nor the renames. |
| B3 | Medium | `.github/workflows/db-backup.yml` (~L108–135), `teller/services/operator-checks.js` backupCheck | Under the shell the Per-sistant dump is required: fail the job when `PERSISTENT_DATABASE_URL` is unset and the stamp would otherwise run (or stamp `last_backup_source = 'github:perfin-only'` and have backupCheck warn). Recommended: record which databases were dumped (`'github'` only when both), warn on a Perfin-only stamp. Workflow logs stay count-only (INV-103). |
| C1 | Low-Med | `teller/views/settings.ejs` contribution-limits editor; `routes/settings.js` PATCH | Disable Save (with a sentence) while the investments list failed to load; send the boxes MERGED over the stored map so a limit for an account not listed this time isn't dropped. Server keeps "replace the whole map" semantics (documented) — the merge is client-side. |

Tests: unit for A1 (0 delivered → `none`; ≥1 → `sent`; release path), B2 (gatherDataHealth with a watchdog row
whose last_ran_at is fresh → not stale), C1 in a vm (failed load → Save disabled; merge keeps an unlisted key);
contract for S2 (two raw merchants, same cadence, a contains rule → 200, one active row with the cancelled
state, rule and renames both present; a forced failure → nothing stored) and B2 on the real job_runs. B3: a
workflow-text pin like the E4a one.
Invariants: INV-124, INV-153, INV-126 (backup), INV-105, INV-151 (forecast carry), INV-59.

## S4-2 — Scheduler & operator hardening

| ID | Sev | Files | Fix |
|----|-----|-------|-----|
| B1 | Medium | `teller/services/job-runner.js` runCheck / schedule; `teller/services/plaid-client.js`; `teller/services/operator-checks.js` / `uptime.js` | Per-run deadline (`Promise.race` with a per-job `timeoutMs`, default e.g. 15 min, longer for bank auto-sync / insights): on expiry record `result(name, { ok: false, error: "timed out" })`, move on (the stuck promise is abandoned, its next claim waits a cadence). Record "runner last checked" in memory; the heartbeat pings `/fail` and an operator check warns when it is older than ~20 min. Plaid client: axios `timeout` (e.g. 60 s). |
| B5 | Low | `shell/index.js` shutdown | `await` `stopBackgroundJobs()` with a bound (e.g. 10 s) before `pool.end()`. |
| B6 | Low (pre-existing) | `teller/startup.js` bank-auto-sync | Stamp `last_auto_sync_at` at the START of a due run (the runner's claim time), so a long run doesn't double the cadence. |
| B4 | Low (INV-126 FAIL) | `teller/services/operator-checks.js` (~L88–90) | PIN check detail: "shorter than 6 characters" / "6 characters or longer" — never the exact length. |
| A3 | Low | `shell/boot-checks.js` sameDatabase; `operator-checks.js` local:databases | After both pools connect, compare `current_database()` + `system_identifier` (or `inet_server_addr`/`port`) and refuse / warn when equal; keep the URL check as the pre-connect fast path. |

Tests: job-runner under mock timers (a never-settling job times out, the next job runs, the outcome is a
failure, the heartbeat reports a stale runner); shutdown awaits with the bound; B4 output scan (no digit of the
length); A3 with two fake pools returning the same identity. Invariants: INV-77, INV-105, INV-126, INV-134,
INV-155 (candidate), INV-156 (candidate).

## S4-3 — Forecast, freshness & restore correctness

| ID | Sev | Files | Fix |
|----|-----|-------|-----|
| S1 | Low | `teller/services/cash-flow.js` mirroredCredit + NOT_SUBSCRIPTION | Build the merchant key with the detectors' expression (import `DETECT_KEY` from merchant-rename.js, or TRIM both sides). |
| S3 | Low | `cash-flow.js` projectCashFlow / classifyBills | One window for the projection and `forecast_items` (today+1 … today+days), so a bill due today is in neither or both — recommend neither (today's balance already reflects it once posted). |
| S6 | Low (INV-142) | `teller/services/cash-alerts.js` | Gate on the OLDEST spendable balance, or drop accounts older than 36 h from the projection and say so in last_check. Recommend: skip the evaluation when any spendable account is stale (fail-quiet, matches INV-142's wording). |
| S4 | Low (INV-154) | `teller/routes/settings.js` gatherDataHealth | With connections present, derive the "haven't synced in 24 h" warnings from `connectionFreshness` (the same helper as the badge); global stamps only with none. |
| S5 | Low (INV-145) | `teller/routes/transactions.js` GET /api/deleted-transactions | Per-row `restorable` uses the batch query's rule (not bank-removed, account still linked). |

Tests: unit for each (cash-flow key with "HULU *", a bill due today, a stale second account, data-health with a
fresh connection and stale global stamps, a bank-removed row's flag); contract: forecast-e1a / undelete / cash
alerts rows. Invariants: INV-142, INV-145, INV-151, INV-154.

## S4-4 — Cross-app notification seam

| ID | Sev | Files | Fix |
|----|-----|-------|-----|
| A2 | Low | `apps/per-sistant/routes/notifications.js` openLinkedItems vs `teller/routes/notifications.js` itemCovered | One predicate for "open linked task" (decide on source_detached — recommend: a detached task still counts as open, matching what the user sees) used by both apps. |
| A6 | Low | `apps/per-sistant` perfinPushedItems | Count `push_state = 'held'` rows too, so Per-sistant doesn't raise an item Perfin is about to release. |
| A5 | Low | `teller/routes/persistent.js` queryPersistentStats | Mirror Per-sistant's /api/stats filters (no auto-closed / missed as done; APP_TIMEZONE today). |
| A4 | Low | `apps/per-sistant/routes/perfin.js` embedded widget | `next_expected::text` (or ymdOf); trim the stale finance-search follow-on in CLAUDE.md. |

Tests: Per-sistant unit + notify-e3e contract (held row → notify:false; detached task parity). Invariants:
INV-149, INV-153, INV-25.

## S4-5 — UI correctness

| ID | Sev | Files | Fix |
|----|-----|-------|-----|
| C2 | Low (INV-157) | `teller/views/settings.ejs` selects / number inputs via updateSetting | Remember the stored value on focus / load; put it back when the save is refused or doesn't arrive (saveToggle's pattern for non-checkboxes). |
| C3 | Low | `teller/views/dashboard.ejs` adviceEmergency | Show the plan's note alongside the projection. |
| C4 | Low | `dashboard.ejs` loadDashboardSummary | Un-hide the cards on a successful reload; on a failed RELOAD keep the previous cards and toast. |
| C5 | Low (INV-148) | `dashboard.ejs` Since-you-last-looked rows | `fmt` + `.amt-in` / `.amt-bad` (the balance rows' `favorable` already says which). |
| C6 | Low | `apps/per-sistant/routes/analytics.js` heatmap | Bucket `(completed_at AT TIME ZONE $tz)::date` with APP_TIMEZONE. |

Tests: vm runs from the templates (a refused select restored, the emergency note, a summary reload after a
failure, "-$24.29"), the heatmap under America/Los_Angeles in a child process. Invariants: INV-148, INV-90,
INV-157 (candidate).

---

## Docs to fold in (with S4-1's or S4-2's PR, or the closing /sync-docs)

- Add INV-155 (job-runner claim: a due job runs once across processes; a failed claim runs it), INV-156 (the
  shell refuses a shared Per-sistant database unless ALLOW_SHARED_DATABASE), INV-157 (a Settings save's result
  reaches every updateSetting wrapper; a refused save puts the control back) to the Invariant Library — S4-2 and
  S4-5 extend 155 / 156 / 157.
- After S4-1: INV-153's wording ("pushed" = delivered to ≥1 device); INV-124 back to PASS.
- A4's stale Batch 8 follow-on text.
