Scaffold the optional .cycle/ state directory for this project so the
file-backed workflow (the implement commands' CHECKPOINT, /cycle-status,
/cycle-resume, and per-cycle metrics) works. Create only what is
missing — NEVER overwrite or modify a file that already exists.

1. If .cycle/ does not exist, create it.
2. If .cycle/STATE.md does not exist, create it from the template in
   CLAUDE.md's "Cycle State & Memory" section, with Phase: idle and a
   "Where I left off" line pointing at the first audit.
3. If .cycle/metrics.csv does not exist, create it with just the header:
   date,cycle,subsystem,phase,net_score,prod_fixes,new_failure_modes,category_d_ratio,axis_b_lowest,notes,defensive_count
4. If .cycle/estimates.csv does not exist, create it with just the header:
   date,cycle,action,estimate,estimated_hours,actual_hours,calibration_note
5. If PROJECT_HEALTH.md does not exist at the repo root, create it from
   the §7 template (Current Standing + an empty Score History).

Report which files were created and which already existed. If the
project has no Cycle Workflow Config yet, suggest running /setup-cycle
first. Remember: deleting .cycle/ at any time reverts to the pure
copy-paste workflow with no loss.
