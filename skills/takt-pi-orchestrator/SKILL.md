---
name: takt-pi-orchestrator
description: "Act as the front door for TAKT in Pi: resolve the exact target, automatically bootstrap missing project-local TAKT state and profiles, decide whether the request needs task planning, execution, recovery, or next-step navigation, then route to the specialized TAKT Skill. Use whenever the user mentions TAKT, the Pi TAKT bridge, queueing, running, setting up, recovering a TAKT task, or asks what to do next. Do not start task execution or queue work before intent and target are clear."
---

# TAKT Pi Orchestrator

Start here for ambiguous or multi-step TAKT requests. Keep task decisions in
Pi, but make safe, idempotent project bootstrap automatic as soon as the
target is unambiguous. The user should not have to repair registries, create a
`.takt` directory, or remember `/takt:project` before normal TAKT work.

## Intake questions

Resolve only what is missing. Do not ask for information already present in
the current Pi project, an explicit path, or a named profile:

1. **Target** — use an explicit repository/folder, an explicit named profile,
   or the current Pi project when the user says “this project”, “here”, or
   otherwise makes the current folder unambiguous. Never guess a different
   path or silently search for a similarly named repository.
2. **Intent** — setup only, ask for the next action, discuss and queue a pending
   task, execute now, or inspect/recover an existing session.
3. **Execution policy** — preset/profile, Pi-only provider constraint, worktree
   expectation, workflow/provider lane, and whether external side effects are
   allowed. Workflow selection is required for every fresh route. It is not a
   reason to substitute the global Pi default; follow **Workflow selection**
   below before planning or execution.
4. **Task contract** — goal, scope, non-goals, acceptance criteria, and
   validation evidence when the request is implementation work.

Do not ask questions whose answers are already explicit in the user request or
project guidance. Safe bootstrap is not task execution: after the target is
resolved, perform the bootstrap below without an extra confirmation. Do not
create a task, start a process, stop a process, or send `/go` during intake.

## Automatic bootstrap

Run this once before any route that needs a TAKT project, including setup,
planning, execution, and recovery:

1. If the user supplied a named profile, preserve that name. Use it directly;
   do not replace it with `pi-docs` or infer a path for it. If the profile is
   missing and no exact cwd was also supplied, ask for the cwd instead of
   guessing; if both were supplied, pass both to setup.
2. If the target is an exact folder (including the current Pi project), call
   `takt_project_setup` with:

   ```json
   {
     "cwd": "<exact target cwd>",
     "preset": "<explicit preset or pi-docs>",
     "copyGlobalPreset": true
   }
   ```

   Omit `profile` unless the user gave one. The tool derives a stable safe
   profile name from the exact folder and returns the profile to use next.
   Pass that returned profile unchanged to the planner, runner, or recovery
   tool. This avoids the common failure where setup registers `dtm-cursor` but
   the next call falls back to an unrelated `pi-docs` profile.
3. If setup reports that the named profile points to another folder, stop and
   surface the exact conflict. Never pass `overwrite: true` unless the user
   explicitly asked to move that profile.
4. If setup reports that the bridge tool or runtime is missing, stop with the
   exact missing tool/profile/cwd and request a Pi reload or package repair.
   Do not edit `profiles.json`, invoke `/takt:project` manually, shell out to
   `takt`, or guess a replacement path.
5. Treat setup output as the readiness result. It creates missing project-local
   `.takt` scaffolding, the selected preset, and registry entries idempotently.
   It does not select or rewrite a project workflow; validate project-owned
   workflow files separately. It must not copy tasks, runs, sessions, logs, or
   credentials.

After bootstrap, if a session may already exist, call `takt_read_screen` before
starting or replacing anything. Distinguish bridge-owned `live` PTY output from
external `stale`/`unknown` metadata. External runs can be observed but their
original PTY must not be killed or claimed. Route ownerless checkpoint recovery
to `takt-pi-runner`; do not start a duplicate run.

## Workflow selection

Resolve the workflow **before** handing off to planner or runner. Use TAKT's
effective catalog, not a project-only scan. Bootstrap must not invent or
rewrite workflow files.

1. After target + bootstrap, call `takt_workflow_catalog` for the exact profile.
   It resolves project > user-global > builtin, deduplicates names, honors
   `enable_builtin_workflows` / `disabled_builtins`, and returns source,
   description, categories, and standalone workflows only.
2. If the catalog is unavailable or empty, stop with its diagnostic. Do not
   enqueue, run, or silently fall back to `default`.
3. For a fresh route, always show the catalog choice with
   `ask_user_question` / `cursor_ask_question`. Present categories plus a
   search/exact-id path; include the `Others` category for uncategorized
   workflows. A one-item catalog still gets displayed and confirmed.
4. If the user supplied an exact `workflow: <id>` directive, resolve it in the
   catalog and show it as **locked**; do not replace it. An unknown or disabled
   id fails closed. Resume/recovery displays the run's existing workflow as
   locked and never reselects it.
5. Carry the chosen id as one literal `workflow: <id>` directive into the
   planner task body. The orchestrator owns selection; planner and runner only
   preserve and validate it.

Callable/internal workflows are not picker candidates. If a project lane alias
points at one, resolve it to a standalone workflow or ask for a valid
standalone id; never expose an internal helper as a selectable route.

## DTM Cursor lane

When the user names **DTM Cursor**, or the resolved target folder basename is
`dtm-cursor`, route with the project's current lanes:

1. Use DTM lane names only as intent hints: audit/design, implement, bug, perf,
   or design-optimize. Resolve the final id from the effective standalone
   catalog and still perform the required fresh-route selection. Do not map a
   lane directly to an internal helper such as `development-core`.
   If the user says only `audit` / `normal` / “監査” and multiple candidates
   exist, show the catalog and ask; never silently pick Luna, Grok, or default.
2. Preserve the project's existing `.takt/config.yaml` and custom workflow
   files. Bootstrap may add missing bridge scaffolding.
3. Resume and recovery use the project's configured Pi provider/workflow.

This routing applies only to DTM Cursor. Other projects keep their explicit
provider/workflow constraints; if none are specified, catalog selection is
still required. The selected workflow is a task contract, not an exec preset.

## Route

| Resolved intent | Specialized path |
|---|---|
| Ask what to do next or how to continue | `takt-pi-next-step` |
| Resolve target and intent | `takt-pi-intake` |
| Prepare exact target/profile | `takt-pi-project-setup` |
| Select and lock a workflow | `takt-pi-workflow-selection` |
| Discuss requirements, then make a pending task | `takt-pi-task-planner` |
| Confirm and verify enqueue | `takt-pi-queue-gate` |
| Ask for final execution intent | `takt-pi-run-gate` |
| Run an already finalized queued task/issue | `takt-pi-runner` |
| Inspect, stop, replace, or recover a session | `takt-pi-runner` recovery flow |
| Setup only | `takt_project_setup` and stop |

## Setup handoff

Once the target is resolved, follow **Automatic bootstrap** before handing off.
For a current-folder target, the current Pi cwd is the exact path; do not ask
the user to register it manually. Prefer the `pi-docs` preset only when the
user did not name another preset. Setup is idempotent and must not copy tasks,
runs, sessions, logs, or credentials. If the target is not exact, stop and ask
rather than guess.

After setup, automatically read the selected specialized Skill and continue in
the same conversation; do not make the human choose an internal Skill name.
Planner and runner handoffs happen only after workflow selection. For next-step
requests, read `../takt-pi-next-step/SKILL.md` immediately after target/readiness
resolution so it can inspect current evidence (including the catalog when
needed) before handing back to this orchestrator or the planner/runner. The
navigator recommends one next action; it does not bypass workflow selection,
confirmation, or explicit run intent.
Read `../takt-pi-task-planner/SKILL.md` for the planner route and
`../takt-pi-runner/SKILL.md` for the runner/recovery route.
The orchestrator does not replace the planner or runner instructions. It does
not call `takt_enqueue_task` until the planner has a finalized task body and
user confirmation, and it does not call `takt_exec_prompt` directly for a
request that still needs planning.

## Delivery handoff

If the user asks for a commit, push, or pull request, keep that request in the
task contract and verify it at the end; do not infer delivery side effects from
a branch name. Before claiming completion, confirm terminal workflow status,
validation evidence, changed files, and the actual commit/remote/PR result.
`auto_pr: true` means a regular PR; `draft_pr: true` means a draft. If the
available bridge tool cannot set the requested delivery option, report that
limitation instead of claiming that a PR will appear.

## Safety boundary

- Queueing requires a finalized body, a selected workflow, and user
  confirmation. `takt_enqueue_task` verifies the ACP-reported workflow before
  returning success; mismatch or missing result leaves the pending task in
  place as unverified and blocks execution.
- Execution requires explicit intent to run; planning and enqueueing alone
  never run. The normal route calls `takt_run_pending`, which runs all pending
  tasks through the shared `takt run` PTY/widget lifecycle.
- Project bootstrap is safe and idempotent; it may happen automatically after
  the exact target is known, without turning into queueing or execution.
- Preserve Pi-only/provider/worktree constraints exactly; do not invent them.
- For DTM Cursor, use lane names only to filter catalog search; never bypass
  catalog selection or target an internal workflow. Every fresh route displays
  the effective catalog, then carries `workflow: <id>` into the next skill.
- Direct planner/runner invocation without a workflow returns here for catalog
  selection. `takt exec` is an explicit instant/interactive escape hatch, not
  the normal implementation route.
- Carry the profile returned by setup into the next skill; never fall back to a
  guessed profile after setup succeeds.
- Keep the handoff seamless. Briefly state the next step in human terms
  (`要件を詰めます`, `タスクとして積みます`, or `実行します`) without
  exposing internal routing mechanics unless useful.
