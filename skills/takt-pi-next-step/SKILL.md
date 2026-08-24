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
target → setup → catalog/select → clarify → confirm → enqueue
       → explicit run → inspect/follow-up → validate → deliver
```

The route is stateful. Do not skip a completed boundary, repeat a task body,
or use `takt exec` as a shortcut for the queue/run path.

## Navigator procedure

1. Resolve the exact target and named profile from the conversation. If either
   is missing, ask for the exact folder or profile; never guess a path.
2. Read current evidence before recommending a mutation:
   - use `takt_read_screen` when a bridge-owned session may be live;
   - use `takt_project_setup` only when an exact target needs safe bootstrap;
   - use `takt_workflow_catalog` for every fresh task route.
3. Classify the route using the state table below. Prefer one blocker or one
   user decision over a list of possibilities.
4. State the next action, why it is next, the tool/Skill that owns it, and the
   observable done condition. Then perform only a safe read or ask for the
   required user intent/confirmation.
5. Hand off to `takt-pi-orchestrator`, `takt-pi-task-planner`, or
   `takt-pi-runner` as indicated. After the handoff, let that Skill own the
   route; do not create a parallel plan.

## State table

| Evidence | Next action |
|---|---|
| Target/profile unresolved | Ask for the exact target; stop. |
| Exact target lacks bridge setup | `takt_project_setup`; done means profile and local `.takt` are ready. |
| Fresh task has no locked workflow | `takt_workflow_catalog`, then orchestrator selection. |
| Goal or acceptance is unclear | Planner clarification; do not enqueue. |
| Task body ready but not confirmed | Show the body and ask to enqueue. |
| Confirmed body has no verified queue result | `takt_enqueue_task`; done means ACP workflow verification succeeds. |
| Verified pending task, no run intent | Tell the user the next action is explicit execution; do not run yet. |
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
- Catalog failure, unknown/disabled workflow, or ACP mismatch is fail-closed.
  Preserve the pending task, explain the blocker, and do not run it.
- Queueing requires a finalized body plus user confirmation. Queueing never
  starts execution. Normal execution requires explicit user intent and
  `takt_run_pending`.
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
