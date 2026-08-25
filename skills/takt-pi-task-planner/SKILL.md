---
name: takt-pi-task-planner
description: Turn a vague request into one concrete TAKT pending task through a Pi-side planning conversation, then persist it directly without starting execution. Use after takt-pi-orchestrator routes a queue request or when the user explicitly invokes takt-pi-task-planner. Do not trigger as the front door for generic TAKT requests and do not use for immediate execution; use takt-pi-runner instead.
---

# TAKT Pi Task Planner

Use Pi for the thinking, then use TAKT for the queued execution unit. This
skill creates **one pending task**; it does not start `takt run` or
`takt_exec_prompt`.

## Workflow

1. Identify the exact target project. Use the current Pi project only when it
   is unambiguous; otherwise ask for the path or named profile. Never guess a
   repository path.
2. Inspect the relevant project guidance, issue/PRD, existing implementation,
   and tests. Keep research proportional to the request.
3. Discuss and resolve the smallest set of gaps:
   - goal and user-visible outcome
   - in-scope files or boundaries
   - explicit non-goals
   - acceptance criteria
   - validation commands or evidence
   - provider/agent constraints, if any
4. Require a workflow directive from the orchestrator before presenting the
   final body. If it is missing, return to `takt-pi-orchestrator`; planner is
   not a workflow-selection owner and must not choose `default`.
5. Present one final task body in the template below. Ask for confirmation
   before enqueueing. Do not silently turn an idea into a task.
6. If the target profile or project-local TAKT setup is missing, call
   `takt_project_setup` with the exact target cwd first.
7. After confirmation, call `takt_enqueue_task` with the finalized body and
   named profile. Preserve the body exactly.
   The body must contain exactly one literal `workflow: <id>` line. The bridge
   verifies the directly persisted workflow. A post-write mismatch is a failed,
   unverified enqueue; the pending task is intentionally preserved for
   inspection and execution is blocked.
8. Report the queued project, cwd, verified workflow, task name, and tasks file; remind
   the user that execution is still pending. Do not call `takt_exec_prompt` or
   `takt_run_pending` in this skill.

## Final task template

```markdown
## Goal
<one sentence describing the outcome>

## Scope
- <files, modules, or boundaries to change>

## Non-goals
- <explicitly excluded work>

## Acceptance criteria
- [ ] <observable requirement>
- [ ] <regression or compatibility requirement>

## Validation
- `<exact command>`
- <manual or evidence check, if needed>

## Constraints
- workflow: <selected standalone workflow id>
- <provider, safety, rollout, or other explicit constraint>
```

The `workflow: <id>` line is mandatory under **Constraints**. Keep the exact
selected standalone id so direct enqueue and later `takt run` preserve it. Workflow
selection is locked for this task; changing it requires a new orchestrator
selection, not a planner rewrite.

## Boundary

- Planning and queueing belong here.
- Execution, review output, and recovery belong to `takt-pi-runner`; normal
  execution uses `takt_run_pending` and public `takt run`.
- Keep user decisions visible in the task body; do not invent acceptance
  criteria or claim that a queued task is complete.
