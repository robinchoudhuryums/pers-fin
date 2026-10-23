---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (roadmap work, not scan findings)
New capabilities (G/ST): Roadmap T2.4 X2b — linked tasks come alive: Perfin's runner reconciles Per-sistant's tasks (hourly away job + a refresh kicked by each housing / bill-payment write), the run is recorded, and a still-charging alert creates its one-off task. Works once linked_tasks_enabled is set (the Settings section is X2c).
Files modified:
  teller/services/linked-tasks.js (runLinkedTasks, refreshSoon / kick, invalidate, ensureStillChargingTask),
  teller/startup.js (runLinkedTasksTick — hourly, not activity-gated), teller/services/job-health.js
  ("linked-tasks" interval), teller/routes/housing.js (kick after generate, obligation add / edit / delete,
  payment record / undo), teller/routes/subscriptions.js (kick after bill payment mark / unmark; the
  watchdog's still-charging task), teller/routes/settings.js (invalidate on a linked_tasks_* change),
  tests/roadmap-t2-4-x2b.test.js (new), tests/contract/linked-tasks-crossapp.contract.test.js (new),
  CLAUDE.md, apps/per-sistant/CLAUDE.md, README.md, .cycle/plan-t2-4-crossapp-automation.md, .cycle/STATE.md

CHANGES:
T2.4-X2b | teller/services/linked-tasks.js | runLinkedTasks(pool, persistentPool = routes/persistent.getEmbeddedPersistentPool(), { today, deps }): no Per-sistant pool → no_persistent (no read); switch off → disabled and no settings read again that local day (invalidate()); otherwise computeLinkedTasks with the stored settings, then Per-sistant's syncLinkedTasks (lazy require of apps/per-sistant/services/linked-tasks) with ONLY ok_kinds + desired; writes linked_tasks_state { at, desired, created, updated, closed, reopened, skipped, errors } — a failed source keeps X2a's fixed sentence, a failed Per-sistant write is "Could not update the tasks in Per-sistant." (never exception text); status ok / partial. Single-flight and not `async`: a call during a run gets the running promise and makes it go round once more (the write that triggered it may postdate the running computation)
T2.4-X2b | teller/services/linked-tasks.js | refreshSoon(reason): fire-and-forget runLinkedTasks on Perfin's pool, never rejects (logged); kick(reason): what routes call — survives even a refreshSoon that throws. ensureStillChargingTask(pool, sub): no-op without Per-sistant or while the switch / the still_charging source is off; else ensureLinkedTask perfin:still-charging:<sub id>:<txn id, sanitized> — "Check <name> — charged $X after you cancelled", high, /subscriptions, no due date; never closed by a sync (its kind is never in ok_kinds)
T2.4-X2b | teller/startup.js + services/job-health.js | runLinkedTasksTick, hourly, NOT activity-gated (INV-77), "linked-tasks" in JOB_INTERVALS_MS (1h); records ok only when the run ran, a partial run or a throw as a failed run; exported in _awayJobs
T2.4-X2b | teller/routes/housing.js + subscriptions.js | linkedTasks.kick(...) after POST /api/housing/generate, POST / PATCH / DELETE /api/housing/obligations, POST / DELETE /api/housing/payments (after COMMIT), POST / DELETE /api/bill-payments; runSubscriptionWatchdog awaits ensureStillChargingTask after the alert is marked, in a try/catch (a failure never un-marks it or stops the loop)
T2.4-X2b | teller/routes/settings.js | a PATCH touching any linked_tasks_* field calls invalidate()

TEST RESULTS: passed — npm test 2200/2200 (Perfin 1566 + Per-sistant 634; 13 new); contract suite 226/226 (6 new, both apps' real databases: switched off writes nothing; rent due → one task, a payment through Perfin's route closes it via the route's own refresh, undo reopens it; a hand-completed task stays done across a payment and its undo; a utility amount entered and a manual bill marked paid close theirs; a still-charging alert → one task across two watchdog runs that a sync never closes; the run recorded). No migration (X2a added the columns); Playwright not run — no page changed. Mutation checks, each turning a test red: every kind closable, the switch ignored, no extra round, exception text recorded, no off memo, the payment / amount / bill-payment hook removed, kick letting a throw through, the watchdog's task throw escaping, the still-charging source ignored, an outcome recorded when the run didn't run, no settings invalidate, an unstable still-charging key.
REGRESSION RISKS:
  - The housing and bill-payment routes now start a background run after each write; with the feature off it costs one settings read a local day, with it on a full computation + reconcile (a few queries) per write.
  - runSubscriptionWatchdog now awaits a settings read (and, when on, a Per-sistant insert) per still-charging alert — only for alerts, which are rare.
INVARIANTS AT RISK: None — INV-77 extended (the linked-tasks job is an away channel, not activity-gated, with a day memo while off); INV-18 / INV-25 (in-process helpers, the wired pool — never an HTTP self-fetch); INV-105 (the job records its outcome; ticked job in JOB_INTERVALS_MS); INV-106 (no bare catch — every catch logs); INV-123 (the watchdog still marks only after a logged notification; the task comes after the mark). INV-144 is written in X3b.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (one new capability, off by default)

OPERATOR ACTIONS / DEPLOY:
- None (off by default; to try it before X2c: PATCH /perfin/api/settings { "linked_tasks_enabled": true }) | BLOCKS DEPLOY: N
Deploy: Platform, Shell & Auth: Render auto-deploys on push to `main` (after the PR merges).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- A kicked refresh recomputes every source, not just the item that changed.
- The single-flight is per process: during a deploy overlap two processes can run at once (both reconcile idempotently through Per-sistant's unique key).
- Transaction syncs don't kick a refresh (nothing they change resolves a task directly); the hourly run covers the rest.

DOCUMENTATION UPDATES NEEDED:
- None (folded into this batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
