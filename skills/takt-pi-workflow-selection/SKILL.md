---
name: takt-pi-workflow-selection
description: "Select and lock the exact standalone TAKT workflow during preflight using the effective project > user-global > builtin catalog. Internal preflight phase; use through takt-pi-next-step or takt-pi-orchestrator."
disable-model-invocation: true
---

# TAKT Pi Workflow Selection

Turn the prepared target into one explicit workflow contract. This phase owns
selection; planner and runner only preserve the result.

## Procedure

1. Call `takt_workflow_catalog` for the exact returned profile.
2. Stop if the catalog is unavailable, empty, or reports diagnostics. Never
   silently fall back to `default`.
3. Show every effective standalone candidate with category, source,
   description, and search. Include `Other` for uncategorized entries.
4. If the user supplied `workflow: <id>`, resolve and display it as locked.
   Resume/recovery displays the checkpoint workflow as locked.
5. Return one exact id and carry one literal `workflow: <id>` directive into
   the planner body.

## Done condition

The selected id is present in the effective catalog, is standalone, and is
locked for the task. Hand off to `takt-pi-task-planner` for task shaping.

## Safety

Do not expose callable/internal workflows. Do not copy builtin files into the
project. Do not enqueue or run. An explicit or checkpoint workflow cannot be
replaced by a lane alias, model preference, or global default.
