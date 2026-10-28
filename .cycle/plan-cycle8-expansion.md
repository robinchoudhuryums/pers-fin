# Cycle 8 — expansion plan (E1–E5) (saved 2026-10-28)

Status: E1 planned (`.cycle/plan-e1-forecast-corrections.md`); E2–E5 queued.

Source: the late-Oct 2026 broad scan's EXPANSION PLAN. The scan's fix batches (1–8) are all
done, which every item below depended on. The operator wants E1–E5 done before cycle 8's
`/reflect`. Each E-batch gets its own plan file and is split into `/broad-implement`-sized
batches when it starts.

| E | Items | Est. | Status |
|---|-------|------|--------|
| E1 Forecast and data corrections | G1 (per-transfer forecast overrides, M, 8h, after Batch 2), G5 (Undo for a bulk CSV-overlap Resolve, S-M, 4h, after Batch 3 / F4) | ~12h | planned — E1a–E1c |
| E2 Scheduler and watermark groundwork | ST1 (a due-based job runner over job_runs: each job runs when its last run is older than its cadence, checked at boot and every few minutes — replaces the setInterval set, builds on job-health tick / result), ST3 (id-based watermarks with an overlap rescan for the anomaly, payday and whats-new checks — transactions.id instead of created_at / now()) | ~16h | queued |
| E3 Notifications | G2 (quiet hours + per-type mute, 12h), ST2 (one cross-app notification router that dedupes one real-world item across Perfin push, Per-sistant notifications and linked tasks, and applies quiet hours, 14h — after G2) | ~2.5 days | queued |
| E4 Operator and freshness visibility | ST5 (token-free go-live checks in Operator Checks: PERSISTENT_DATABASE_URL distinct, PUBLIC_URL / webhook secrets, the last backup stamp, the Teller cert, 4h), G3 (the nav "Synced Xm ago" badge reads each connection's last_synced_at, 2h) | ~6h | queued |
| E5 Behaviour tests | ST4 (state-change assertions in e2e for ~15 key actions — pin, restore, mark received, toggles) | ~8h | queued |

Not batched: **G4** (a manual cost basis for lots older than Plaid's window) — needs product
decisions; goes to `/roadmap`.
