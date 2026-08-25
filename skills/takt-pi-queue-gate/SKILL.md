---
name: takt-pi-queue-gate
description: "Finish TAKT preflight by showing the final task body, obtaining enqueue confirmation, and verifying the directly persisted TAKT workflow before execution. Internal preflight phase; use through takt-pi-next-step or takt-pi-task-planner."
disable-model-invocation: true
---

# TAKT Pi Queue Gate

Convert a finalized, user-approved task into one verified pending TAKT task.
This phase ends before execution.

## Preconditions

- Exact profile and target are known.
- One locked standalone workflow exists.
- The body contains exactly one literal `workflow: <id>` line.
- Goal, scope, non-goals, acceptance criteria, and validation are explicit.

## Procedure

1. Present the final body unchanged. Ask whether to enqueue; do not infer
   approval from a planning discussion.
2. After confirmation, call `takt_enqueue_task` with the exact profile and body.
3. Require direct persisted-task workflow verification. A post-write mismatch
   is a failed enqueue with the pending task preserved and execution blocked.
4. Report project, cwd, exact workflow, and verified pending status.

## Done condition

The direct queue writer persisted the same workflow id as the task directive
and the task is pending.
Hand off to `takt-pi-run-gate`; never call the runner automatically.

## Boundary

Queueing is not execution. Do not call `takt_run_pending`, `takt_exec_prompt`,
shell `takt`, or send `/go` for execution. Do not rewrite a body to repair an
queue mismatch; return to workflow selection/planning.
