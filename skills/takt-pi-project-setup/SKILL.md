---
name: takt-pi-project-setup
description: "Prepare an exact TAKT project before workflow selection or task planning: create local .takt scaffolding, copy one safe preset, and register the named profile. Internal preflight phase; use through takt-pi-next-step or takt-pi-orchestrator."
disable-model-invocation: true
---

# TAKT Pi Project Setup

Make the exact target ready for the remaining preflight route. Setup is safe,
idempotent bootstrap; it is not task creation or execution.

## Procedure

1. Preserve the profile supplied by the user. If no profile exists and the cwd
   is exact, let `takt_project_setup` derive the stable profile.
2. Call `takt_project_setup` with the exact cwd, explicit preset or `pi-docs`,
   and `copyGlobalPreset: true` when the user did not forbid it.
3. Treat the returned profile, cwd, local `.takt` path, and preset source as
   the readiness evidence. Pass the returned profile unchanged.
4. If an existing profile points elsewhere, stop. Never use `overwrite: true`
   without explicit permission to move it.
5. After setup, distinguish scaffold-only changes (for example
   `.takt/.gitignore` or preset metadata) from task changes. Do not stage or
   include scaffold-only files in a task/PR unless the user explicitly asks;
   restore unrelated working-tree changes before delivery.

## Done condition

The exact cwd has a ready local `.takt` scaffold, a usable profile, and the
selected preset. Hand off to `takt-pi-workflow-selection` for a fresh task, or
to `takt-pi-next-step` for recovery/inspection.

## Boundary

Do not copy tasks, runs, sessions, logs, or credentials. Do not select or
rewrite workflow files. Do not enqueue, send `/go`, call `takt run`, or use
`takt exec`.
