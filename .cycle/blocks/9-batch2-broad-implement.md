---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F3 — a non-string session cookie (`shell_session=j:{}`) or a PIN that isn't a string or number no longer makes an async shell handler throw (a hung request and a false "New server error")
- F2 — the "Scheduled jobs missed" push can fire: the outage is judged from the job runner's first read of `job_runs.last_ran_at`, before the process claims anything
- F5 — a failed job outcome no longer sticks once the job stops running its body (a job that finds itself switched off, a quiet-hours release that ran clean, a watchdog pass that finished)
- F4 — standalone Perfin: a path under `/api` no longer skips the PIN gate for ending in `.js` / `.css`
- F10 — a failed keep-alive settings read is never cached; `keep-alive.yml` fails when its schedule call is rejected or never answered
- F11 — `stop()` ends the runner's 20-second gap between two jobs at once, so a shutdown in the gap no longer logs "a scheduled job was still running"
New capabilities (G/ST): None
Files modified:
- shell/middleware/auth.js
- teller/server.js
- teller/startup.js
- teller/services/job-health.js
- teller/services/job-runner.js
- teller/services/keep-alive.js
- .github/workflows/keep-alive.yml
- tests/cycle9-b2.test.js (new, 47 tests)
- tests/cycle8-e3b.test.js, tests/roadmap-t2-2-cash-l2.test.js, tests/roadmap-t2-2-cash-l3.test.js, tests/roadmap-t2-4-x2b.test.js (they pinned the old "records nothing when off" rule)
- .cycle/STATE.md, .cycle/blocks/9-batch2-broad-implement.md

CHANGES:
F3 | shell/middleware/auth.js | `verify` returns null for anything that isn't a string (cookie-parser turns `j:{…}` into an object, and `lastIndexOf` threw inside the async gate). `handleLogin` reads the PIN only when it is a string or a number; anything else is "" (a wrong PIN). An array PIN (`["246810"]`) used to be coerced to the PIN's text and log in; it is a 401 now.
F2 | teller/services/job-runner.js, teller/services/job-health.js, teller/startup.js | The runner takes an `onLoad` callback and calls it once, after its first successful read of `job_runs.last_ran_at` and before any claim, with `{ at, lastRan, jobs }`. `jobHealth.noteBootSnapshot` keeps every watched, UNGATED job whose last claim is older than its threshold (36 h) — an ungated job is claimed at every cadence while the process is up, whether or not the user is around, so an old claim means the scheduler wasn't running. `checkMissedJobs` adds that gap to what it finds and reports it in one pass; the next pass sees none and resets the signature. Gated jobs and never-claimed jobs are left out. The old comparison (heartbeats read back after flushing them) stays for a watched job nothing ticks any more.
F5 | teller/startup.js | `jobOff(job)` records a clean outcome when a job finds its feature switched off: weekly digest, CSV reminder, bank auto-sync, insights auto-trigger (off, or no API key), advice-plan, linked tasks (off or standalone), and cash-alerts when BOTH its checks are off. notify-release records a clean outcome for every run that got past quiet hours (it was only "released"). The watchdog records a clean outcome when its pass finishes, which clears a deadline failure recorded by the runner. "Not due" and "user away" still record nothing.
F4 | teller/server.js | The standalone gate's `.css` / `.js` exemption applies only outside `/api` (matched case-insensitively — Express routes `/API/…` to the same handlers). Static files were already served before the gate, so nothing that loads signed out changed.
F10 | teller/services/keep-alive.js | `getKeepAliveConfigCached` caches only a successful read. After a failed read it returns the last good schedule if there is one (however old), else the "off" fallback, and the next probe reads again. The failure is logged with console.warn.
F10 | .github/workflows/keep-alive.yml | The schedule call goes through `fetch_schedule` (up to 3 tries for no answer or a 5xx — a sleeping host takes time to wake; a 401 / 403 / 404 is not retried) and the shared `check_status`. A rejected or unanswered call fails the run; a 401 / 403 names the API_KEY secret. A 200 that isn't JSON fails the run. The health ping reports through `check_status` too. No response body is printed.
F11 | teller/services/job-runner.js | The pause between two jobs is `gap(ms)`, which `stop()` ends at once. The check then sees `stopped` and returns, so the shell's 7-second wait resolves instead of timing out.

TEST RESULTS: passed.
- `npm test`: 3263 / 3263 (47 new in tests/cycle9-b2.test.js; 179 test files; Perfin 2520). One earlier full run failed one file at file level (tests/roadmap-t1-errors-uptime.test.js); it passes on its own (19 / 19) and in the two full runs after — the known intermittent node:test runner issue.
- Route contract suite on a local Postgres 16: 340 / 340; the five scheduler / alert files re-run after the last edit: 19 / 19.
- Browser smoke (e2e/smoke.spec.js, login and both apps' core pages): 10 / 10. The every-page and behaviour specs were not run.
- The new file and nine neighbouring files under four shifted clocks (2026-12-31, 2027-01-31, 2027-03-14, 2028-02-29): 210 / 210 each.
- Mutation check: against the pre-fix code the new file fails 41 of 47.
- Regression scenarios: S4 (embedded auth gate) — PASS by the smoke run and tests/cycle9-b2 F3; the others don't overlap the modified files.

REGRESSION RISKS:
- The "Scheduled jobs missed" push now works. After a boot that follows 36 h or more without the scheduler running, expect one push. It is judged only at process start, so a process that was frozen and resumed (not restarted) is not detected.
- After a long sleep the watchdog runs in due-time order behind the hourly jobs, so the push can arrive several minutes after boot. It is activity-gated (a boot counts for 15 minutes); if the jobs ahead of it take longer and nobody is using Perfin, the push waits until someone does, and is lost if the process restarts first.
- A job that is switched off now reads "ok" in Sync Health rather than keeping the status of its last real run.
- An array or boolean PIN is no longer coerced to text (the keypad and the form both send a string).
- `keep-alive.yml` goes red where it used to stay green: a wrong or missing API_KEY secret, a server that is down, or a cold start longer than about three minutes.

INVARIANTS AT RISK: None broken. Wording to update at /sync-docs: INV-105 (a job that finds itself off records a clean outcome; "not due" / "away" record nothing), INV-155 (the runner's `onLoad` snapshot; `stop()` ends the gap). INV-103 holds for keep-alive.yml (tested: no body printed). INV-159 holds (`job-watchdog`'s outcome is memory-only and never listed).
NET SCORE: 0 − 1 = −1
- Production fixes this month: 0. F3 needs a crafted request; F2 needs a 36-hour outage, and daily-sync wakes the server daily; F5 needs a failure followed by a switch-off or an expired push subscription; F4 is standalone-only; F10's workflow is currently disabled by GitHub; F11 needs a shutdown inside a 20-second gap.
- New failure modes: 1 (Low) — keep-alive.yml fails every 14 minutes while its API_KEY secret is wrong or missing, or the server is down. That is the point of the fix, but it is new noise.

OPERATOR ACTIONS / DEPLOY:
- Before re-enabling the Keep Alive workflow, confirm the SERVER_URL and API_KEY repository secrets are set and that API_KEY matches the app's. With a wrong or missing key every 14-minute run now fails. | BLOCKS DEPLOY: N
- Expect one "Scheduled jobs missed" push after a boot that follows 36 h or more of the server being asleep. | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth — Render auto-deploys on push to `main` (this work is on `claude/gracious-maxwell-li0vm7`; no PR opened).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- After a load that finds a gap, run the watchdog first (it currently waits its turn in due-time order, behind jobs that can take minutes).
- A frozen-and-resumed process (Fly machine suspend) is not detected as an outage — the check runs once per process start.
- `job-watchdog`'s outcome lives in memory only; Sync Health doesn't list it.
- The outage alert is deduped by its job-name signature: a second long sleep that follows the first without a normal wake in between is not announced again.
- keep-alive.yml still wakes the host every 14 minutes around the clock, even while keep-alive is switched off in Settings (pre-existing, already listed).
- Per-sistant's own `loadKeepAliveConfig` also returns "off" on a failed read; it has no cache, so the 6-hour problem doesn't apply.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the job-health.js and job-runner.js entries (boot snapshot, `onLoad`, the stoppable gap, outcomes when off); the Scheduled Tasks "Missed-job watchdog" paragraph and the "a gated skip records nothing" sentence; the keep-alive.js cache note and the keep-alive.yml description under Workflow hygiene; shell auth (F3) and the standalone suffix exemption (F4) under Security; the test list (tests/cycle9-b2.test.js) and counts (3263 tests, 179 files, Perfin 2520); the cycle-9 Known Open Issues entry (Batch 2 done, its follow-ons, the operator note); INV-105 and INV-155 wording.
- README: test counts.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
