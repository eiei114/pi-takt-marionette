---
name: takt-pi-run-gate
description: "Hold the final explicit execution gate after TAKT preflight: verify pending work and ask whether to run all queued tasks. Internal preflight phase; use through takt-pi-next-step or takt-pi-task-planner."
disable-model-invocation: true
---

# TAKT Pi Run Gate

Keep the boundary between preparation and execution visible. A completed
planner or enqueue does not imply permission to run.

## Procedure

1. Confirm the last enqueue was workflow-verified and no unverified pending
   task is blocking the project.
2. If a bridge-owned or external session is live, inspect it with
   `takt_read_screen` before suggesting a new run.
3. Tell the user exactly what will happen: all pending tasks for the named
   profile will start through the shared `takt run` PTY/widget lifecycle.
4. Ask for explicit run/execute intent. Until confirmed, stop at this gate.
5. After confirmation, hand off to `takt-pi-runner`, which calls
   `takt_run_pending`.

## Done condition

The user has explicitly authorized execution and runner owns the start. A tool
return means the PTY started, not that the task completed; inspect progress and
validation separately.

## Boundary

Do not call `takt_run_pending` before explicit intent. Do not use
`takt_exec_prompt` for normal queued work. Resume keeps the checkpoint workflow
locked; it does not re-plan or re-enqueue the original body.
