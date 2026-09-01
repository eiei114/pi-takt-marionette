---
name: takt-pi-orchestrator
description: "Act as the front door for TAKT in Pi: resolve the exact target, automatically bootstrap missing project-local TAKT state and profiles, decide whether the request needs task planning, execution, or recovery, then route to the specialized TAKT Skill. Use whenever the user mentions TAKT, the Pi TAKT bridge, queueing, running, setting up, or recovering a TAKT task. Do not start task execution or queue work before intent and target are clear."
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
2. **Intent** — setup only, discuss and queue a pending task, execute now, or
   inspect/recover an existing session.
3. **Execution policy** — preset/profile, Pi-only provider constraint, worktree
   expectation, workflow/provider lane, and whether external side effects are
   allowed. A project-specific workflow is an explicit user/project
   constraint, not a reason to substitute the global Pi default. When the
   workflow/lane is still ambiguous after target resolution, follow
   **Workflow selection** below before planning or execution.
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

Resolve the project workflow **before** handing off to the planner or runner.
Bootstrap must not invent or rewrite workflow files; this step only chooses
among workflows that already exist under the target's `.takt/workflows/`.

1. After target + bootstrap, list project workflow YAML basenames
   (stem without `.yaml`) under `<cwd>/.takt/workflows/`. Ignore empty dirs.
2. **Do not ask** when any of these already pin one workflow:
   - user named an exact workflow id (`workflow: …`) or lane alias
   - intent maps to exactly one matching project workflow
   - recovery/resume of an existing session (keep that run's workflow)
3. **Ask once** with `ask_user_question` / `cursor_ask_question` when the lane
   is still ambiguous, for example:
   - intent class has **two or more** candidates (e.g. `dtm-cursor-plan-verify`
     vs `dtm-cursor-plan-verify-grok` for audit)
   - user said “run TAKT” / “このプロジェクトで” without a lane, and the project
     has multiple workflows
   - intent could fit more than one lane (audit vs implement vs bug, etc.)
4. Build options from the real files: label = workflow id, short description
   from the YAML `description:` when present. Prefer project lane docs /
   `scripts/takt-lane.mjs` aliases when they exist. Cap to the real candidates;
   do not invent workflows that are not on disk.
5. Carry the chosen id as a literal `workflow: <id>` directive into the
   planner/runner handoff. Never substitute the global Pi default when a
   project workflow was chosen or is required.

If only the default Pi lane applies (no project workflows, or a single
project workflow that matches intent), proceed without a selection UI.

## DTM Cursor lane

When the user names **DTM Cursor**, or the resolved target folder basename is
`dtm-cursor`, route with the project's current lanes:

1. Prefer `dtm-cursor-plan-verify` for audit/design (`audit` / `normal`),
   `dtm-cursor-plan-verify-grok` for the Grok+Composer audit variant
   (`audit-grok` / `normal-grok`),
   `dtm-cursor-implement` for feature work (`implement` → builtin
   `development-core` + project knowledge `dtm-boundary`),
   `dtm-cursor-bug-investigate` for bug diagnosis (`bug` / `bug-investigate`
   → handoff to `implement`),
   `dtm-cursor-perf-investigate` for perf diagnosis (`perf` / `perf-investigate`
   → handoff to `implement`), or
   `dtm-cursor-design-optimize` for local redesign options (`design` /
   `design-optimize` → handoff to `implement`, or short `audit` if needed).
   If the user says only `audit` / `normal` / “監査” and both
   `dtm-cursor-plan-verify` and `dtm-cursor-plan-verify-grok` exist, treat
   that as ambiguous and follow **Workflow selection** (do not silently pick
   Luna or Grok).
2. Preserve the project's existing `.takt/config.yaml` and custom workflow
   files. Bootstrap may add missing bridge scaffolding.
3. Resume and recovery use the project's configured Pi provider/workflow.

This routing applies only to DTM Cursor. Other projects keep their explicit
provider/workflow constraints; if none are specified, use the normal Pi
workflow defaults.

## Route

| Resolved intent | Specialized path |
|---|---|
| Discuss requirements, then make a pending task | `takt-pi-task-planner` |
| Run an already finalized task/issue | `takt-pi-runner` |
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

For review fixes on an existing pull request, carry its positive number as
structured `prNumber` into the runner. Do not reduce the PR URL or number to task
prose: the native PR source is what lets TAKT fetch review comments, check out
the head branch, and retain the base/head diff context.

## Safety boundary

- Queueing requires a finalized body and user confirmation.
- Execution requires explicit intent to run; planning alone never runs.
- Project bootstrap is safe and idempotent; it may happen automatically after
  the exact target is known, without turning into queueing or execution.
- Preserve Pi-only/provider/worktree constraints exactly; do not invent them.
- For DTM Cursor, route `audit`/`normal` → `dtm-cursor-plan-verify`,
  `audit-grok`/`normal-grok` → `dtm-cursor-plan-verify-grok`,
  `implement` → `dtm-cursor-implement`, `bug`/`bug-investigate` →
  `dtm-cursor-bug-investigate`, `perf`/`perf-investigate` →
  `dtm-cursor-perf-investigate`, and `design`/`design-optimize` →
  `dtm-cursor-design-optimize` as documented in the project. When both audit
  variants exist and the user did not name one, ask per **Workflow selection**.
- Never silently pick among multiple matching project workflows; ask once,
  then carry `workflow: <id>` into the next skill.
- Carry the profile returned by setup into the next skill; never fall back to a
  guessed profile after setup succeeds.
- Keep the handoff seamless. Briefly state the next step in human terms
  (`要件を詰めます`, `タスクとして積みます`, or `実行します`) without
  exposing internal routing mechanics unless useful.
