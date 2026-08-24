---
name: takt-pi-runner
description: Execute finalized issue and development tasks through TAKT using Pi-only agents, a named project profile, and the Pi stacked raw-output widget. Use after takt-pi-orchestrator routes an execution or recovery request, or when the user explicitly invokes takt-pi-runner. Do not trigger as the front door for generic TAKT requests or vague setup/planning; route those through takt-pi-orchestrator first.
---

# TAKT Pi Runner

Run TAKT through the `pi-takt-bridge` tool. The bridge owns the PTY, project
cwd, preset, prompt submission, and `/go`; this keeps raw TAKT output visible
above the normal Pi editor.

## Project bootstrap

Use `takt_project_setup` before the first run for a repository that is not yet
registered or does not have a project-local `.takt` directory. Pass the exact
target `cwd`, a stable `profile` name, and the intended `preset`:

```json
{
  "profile": "pi-takt-bridge",
  "cwd": "C:/Users/Keisu/Projects/OSS/pi-takt-marionette",
  "preset": "pi-docs",
  "copyGlobalPreset": true
}
```

This creates `.takt/exec/presets/` and `.takt/workflows/`, registers both the
project and named profile, and copies only the selected preset from the global
TAKT directory when the project does not already have it. It never copies
tasks, runs, sessions, logs, credentials, or other global runtime state.
The operation is idempotent. Use `overwrite: true` only when explicitly moving
an existing profile to a different folder.

For interactive setup, `/takt:project:init [profile]` performs the same setup
for the current Pi project. Use `/takt:project` or `/takt:profile:add` only for
manual registration or when the setup tool is unavailable.

## Queue/run workflow (normal)

1. Require a workflow selected by `takt-pi-orchestrator`. If the task body has
   no exact `workflow: <id>` line, return to the orchestrator; runner does not
   select or silently default a workflow.
2. If the target profile/project is not ready, call `takt_project_setup` first.
3. Use the profile returned by setup unchanged. Use `pi-docs` only when the
   target was already explicitly registered as `pi-docs`.
4. Call `takt_read_screen` first when a session may already be running.
5. For normal implementation, call `takt_run_pending` only after the user
   explicitly asks to run/execute. It runs **all pending tasks** through the
   shared bridge PTY/widget lifecycle and public `takt run`:

   ```json
   { "profile": "<resolved profile>" }
   ```

   Planning and `takt_enqueue_task` never call it automatically. A successful
   tool return means the PTY started, not that the task completed; inspect
   `takt_read_screen` and the live widget for progress.

6. Use `takt_exec_prompt` only when the user explicitly requests instant /
   interactive `takt exec` behavior. That path may clear, paste, and submit
   `/go`; it is not the queue/run implementation default.

## Project workflow overrides

The orchestrator owns selection. Preserve its exact `workflow: <id>` directive
in the task body; do not rewrite it, replace it, or choose an internal helper.
If this skill is invoked directly without a workflow line, return to
`takt-pi-orchestrator` and use `takt_workflow_catalog` before any enqueue/run.
An explicit workflow line and a resume workflow are locked.

For DTM Cursor (`dtm-cursor`):

- DTM lane names (`audit`, `implement`, `bug`, `perf`, `design-optimize`) are
  search hints only. Resolve a standalone id from the effective catalog; do
  not target internal helpers such as `development-core`.
- Bare `audit` / `normal` with multiple candidates → ask through the
  orchestrator; do not silently default to Luna or Grok.
- Resume and recovery use the project's configured Pi provider/workflow.

## Recovery

- When the user asks to continue the existing checkpoint rather than restart
  the task, call `takt_stop` if the bridge-owned PTY is still live, then call
  `takt_resume_run` with the same profile and the explicit `provider` / `model`.
  The resume tool opens TAKT's resume UI, selects `Requeue`, preserves the run
  checkpoint, and does not call `takt clear` or submit the task body again.
- If only stale or ownerless `running` metadata remains, inspect it first with
  `takt_read_screen`, then use `takt_stop` with `forceObserved: true`. This may
  mark stale/unknown metadata aborted but never kills an external live PID.
- If `takt_run_pending` reports an already-running session, call
  `takt_read_screen` first, then use `takt_stop` only when the user explicitly
  wants to interrupt it. Do not start a second queue/run PTY.
- If the user explicitly requests instant `takt exec`, an already-running
  session may be replaced with `takt_exec_prompt` and `replace: true`.
- If the profile is missing, call `takt_project_setup` with the exact target cwd
  instead of editing `profiles.json` manually. If the setup tool is missing,
  report the runtime/package mismatch and stop.
- If the widget looks frozen, read `status:`, `pid:`, `stage:`, and `lastExit:`
  from `takt_read_screen` before assuming a hang. `pasting` / `sending_go`
  intentionally show a prompt preview; `live`, `stale`, `completed`, and
  `unknown` describe lifecycle ownership.
- Use `takt_set_mode` only when you need an explicit mode change outside the
  automatic post-submit `pi-auto` transition.
- Never use shell `taskkill`, `takt run`, or absolute path guessing when the
  bridge tools are available.

## Rules

- All TAKT agents, workers, reviewers, replans, and loop judges must use Pi
  when the task asks for Pi-only execution. Preserve that requirement exactly.
- Never use shell `takt run`, `takt exec`, `cd`, or a manually typed absolute
  path when the bridge tools are available. The named profile is the path
  boundary.
- Do not use `--continue`. Use `takt_resume_run` for checkpoint recovery; use
  `takt_run_pending` for queued work and `takt_exec_prompt` only when a fresh
  instant/interactive exec task is explicitly intended.
- Do not send the task body and `/go` through separate ad-hoc mechanisms unless
  recovering inside an already-running `pi-auto` session with `takt_send_input`.
- If any required bridge tool is missing or its runtime is not initialized after
  a fresh Pi reload, stop. Report the exact tool name, profile name, and target
  cwd as a reload/package mismatch; do not use `taskkill`, Computer Use, guessed
  paths, or fall back to Claude/Codex/direct shell execution.
- If the user explicitly requests a different profile, pass that profile name
  and keep the chosen task body unchanged.

## Explicit invocation

Users can force this skill with:

```text
/skill:takt-pi-runner <task body>
```

The text after the command is the task body. Use the same default profile and
tool call unless the user includes an explicit `profile: <name>` instruction.
