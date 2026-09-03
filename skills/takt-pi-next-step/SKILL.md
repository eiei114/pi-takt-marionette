---
name: takt-pi-next-step
description: "Choose the next concrete action in a TAKT project and route into the correct built-in workflow. Use when the user asks what to do next, where the TAKT task stands, how to continue, what remains, or wants an ask-matt-style flow guide after setup, planning, queueing, running, or recovery."
---

# TAKT Pi Next Step

Act as TAKT's flow navigator. Do not dump a long plan or invent a new
workflow. Inspect the current route, identify the **single next action**, and
hand off to the specialized Skill that owns it.

## Route map

```text
target → setup → catalog/select → model preflight → clarify → confirm → enqueue
       → explicit run → inspect/follow-up → validate → deliver
```

The route is stateful. Do not skip a completed boundary, repeat a task body,
or use `takt exec` as a shortcut for the queue/run path.

## Navigator procedure

1. Resolve the exact target and named profile from the conversation. If either
   is missing, hand off to `takt-pi-intake`; never guess a path.
2. Read current evidence before recommending a mutation:
   - use `takt_read_screen` when a bridge-owned session may be live;
   - use `takt-pi-project-setup` / `takt_project_setup` only when an exact
     target needs safe bootstrap;
   - use `takt-pi-workflow-selection` / `takt_workflow_catalog` for every fresh
     task route.
   - use `takt-pi-model-preflight` for an explicit `provider: pi` model route;
     `pi --list-models` is candidate evidence, not embedded-runtime proof.
3. Classify the route using the state table below. Prefer one blocker or one
   user decision over a list of possibilities.
4. State the next action, why it is next, the tool/Skill that owns it, and the
   observable done condition. Then perform only a safe read or ask for the
   required user intent/confirmation.
5. Hand off to the exact phase Skill or owner shown below. After the handoff,
   let that Skill own the route; do not create a parallel plan.

## State table

| Evidence | Next action |
|---|---|
| Target/profile unresolved | `takt-pi-intake`; done means exact target, intent, and constraints are known. |
| Exact target lacks bridge setup | `takt-pi-project-setup`; done means profile and local `.takt` are ready. |
| Fresh task has no locked workflow | `takt-pi-workflow-selection`; done means one exact catalog id is locked. |
| Pi task has an explicit model route not yet verified | `takt-pi-model-preflight`; done means the embedded runtime can resolve the exact route. After launch, runner separately verifies target run identity. |
| Goal or acceptance is unclear | Planner clarification; do not enqueue. |
| Task body ready but not confirmed | `takt-pi-queue-gate`; show the body and ask to enqueue. |
| Confirmed body has no verified queue result | `takt-pi-queue-gate` → `takt_enqueue_task`; done means direct workflow and execution-policy verification succeeds. |
| Verified pending task, no run intent | `takt-pi-run-gate`; stop until explicit execution intent. |
| User explicitly asks to run | `takt_run_pending`; done means the bridge-owned `takt run` PTY starts. |
| Session is live or waiting for input | `takt_read_screen`, then runner follow-up or `takt_send_input` only when allowed. |
| Session is stale or checkpointed | Inspect first; use `takt_stop`/`takt_resume_run` only for the requested recovery. |
| Run completed | Inspect validation and delivery requirements; do not claim completion from PTY start. |

## Contract

- Orchestrator owns workflow selection. Use project > user-global > builtin
  standalone catalog, categories, search, and `Other`; never silently select
  `default`.
- Explicit `workflow: <id>` and resume workflows are locked. Planner and
  runner preserve them; they do not reselect.
- Fresh tasks require explicit per-task `worktree` and PR mode choices. Regular
  and draft PR require `worktree: true`; missing or ambiguous choices fail
  closed rather than inheriting defaults.
- Catalog failure, unknown/disabled workflow, or queue mismatch is fail-closed.
  Preserve the pending task, explain the blocker, and do not run it.
- Queueing requires a finalized body plus user confirmation. Queueing never
  starts execution. Normal execution requires explicit user intent and
  `takt_run_pending`.
- For `provider: pi`, preserve one fully qualified `<pi-provider>/<pi-model>`
  route. Preflight it against the embedded TAKT catalog before enqueueing or
  starting; do not treat a stale widget, `models-store.json`, or a successful
  PTY acknowledgement as proof of model/task progress.
- `takt_exec_prompt` is valid only for an explicitly requested instant or
  interactive path. Never shell out to `takt`, use `taskkill`, or guess a cwd
  when bridge tools exist.
- When several next actions are possible, choose the earliest unmet safety
  boundary, not the most ambitious action.

## Response shape

Keep the handoff short:

```text
次: <one concrete action>
理由: <state evidence / blocker>
担当: <tool or Skill>
完了条件: <observable result>
```

If a user decision is required, ask exactly that one decision. If no safe next
action can be determined, report the missing evidence instead of guessing.
