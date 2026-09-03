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
4. If the task selects `provider: pi` with an explicit model, run
   `takt-pi-model-preflight` before starting or resuming. Preserve the fully
   qualified `<pi-provider>/<pi-model>` route and any supported thinking-level
   suffix exactly; do not substitute the Pi provider for TAKT's `provider`.
5. Call `takt_read_screen` first when a session may already be running.
6. For normal implementation, call `takt_run_pending` only after the user
   explicitly asks to run/execute. It runs **all pending tasks** through the
   shared bridge PTY/widget lifecycle and public `takt run`:

   ```json
   { "profile": "<resolved profile>" }
   ```

   Planning and `takt_enqueue_task` never call it automatically. A successful
   tool return means the PTY started, not that the task completed; inspect
   `takt_read_screen` and the live widget for progress.

7. Use `takt_exec_prompt` only when the user explicitly requests instant /
   interactive `takt exec` behavior. That path may clear, paste, and submit
   `/go`; it is not the queue/run implementation default.

## Project workflow overrides

The orchestrator may provide an exact builtin or project-owned workflow. Use
`takt_run_workflow` for that route; do not leave `workflow:` as prompt prose and
do not replace it with the default Pi lane. This direct workflow tool starts
immediately, so call it only after explicit approval of task, workflow,
provider/model, temporary extensions, and PR behavior. If `provider: pi` is
selected, model preflight must pass before this call. It has no `/go` phase.
Set `pipeline:true` when `autoPr` or `draftPr` is requested; otherwise the tool
rejects the configuration before starting TAKT.

For a PR-review fix, pass the positive PR number as `prNumber` and omit `task`.
The bridge maps it to TAKT's native `--pr <number>` input so TAKT fetches review
comments, checks out the PR branch, and retains base/head diff context. Do not
encode the PR URL or number into task prose when `prNumber` is available.

If this skill is invoked directly and the task body has **no** `workflow:`
line, apply the same ambiguous-only rule as the orchestrator:

1. List `<cwd>/.takt/workflows/*.yaml` stems.
2. If the user already named a workflow/lane, or exactly one candidate matches
   intent, use that id.
3. If two or more candidates remain (same intent class or unspecified lane),
   ask once with `ask_user_question` / `cursor_ask_question`, then pass the
   chosen id as the exact `workflow` argument to `takt_run_workflow`.
4. Do not ask on resume/recovery of an existing session.

For the normal queue/run route, the orchestrator owns selection. Preserve its
exact `workflow: <id>` directive in the task body; do not rewrite it, replace
it, or choose an internal helper. If this skill is invoked directly without a
workflow line, return to `takt-pi-orchestrator` and use `takt_workflow_catalog`
before any enqueue/run. An explicit workflow line and a resume workflow are
locked.

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
- A successful start acknowledgement proves only that a PTY was created. Read
  the target's run metadata and require its project/cwd and model context to
  match the request. The widget may show an older or different project; mark
  that output stale instead of stopping it, claiming it, or starting a
  duplicate.
- If model resolution fails immediately, stop. Do not retry the same route
  blindly, change the provider, or create runtime-v1 configuration as a
  workaround. Return to model preflight with the exact not-found diagnostic.
- Use `takt_set_mode` only when you need an explicit mode change outside the
  automatic post-submit `pi-auto` transition.
- Never use shell `taskkill`, `takt run`, or absolute path guessing when the
  bridge tools are available.

## Exec failure playbook

When `takt_exec_prompt` stalls at `awaiting_go` / `Assistant>` or `/go` is
rejected, the lines above `Assistant>` in `takt_read_screen` name the cause.
Diagnose in this order:

1. `Pi model "<ref>" was not found` — the model never reached Pi. Check:
   - `<cwd>/.takt/persona_sessions.json` pins a stale model from a previous
     failed run. Reset `personaSessions` to `{}` and re-exec with
     `replace: true`.
   - `provider/model:thinking` suffix in the preset `model:` (e.g.
     `...:xhigh`). TAKT's Pi client splits the reference on `/` only and
     never strips a `:suffix`, so the suffixed id misses the catalog. Put the
     bare id in `model:` and the level in
     `provider_options.pi.thinkingLevel`.
   - New model unknown to TAKT's bundled offline catalog. TAKT resolves Pi
     models with network refresh disabled, while `pi --list-models` and
     `pi auth check` refresh from the network — CLI `ready` does not prove
     TAKT can resolve it. After confirming
     `pi auth check --model <ref>` is `ready`, merge the model into the
     built-in provider via `~/.pi/agent/models.json`
     (`providers.<provider>.models[]` upserts by `id`; built-ins are kept).
     Mirror `api`, `baseUrl`, `compat`, `thinkingLevelMap`,
     `contextWindow`, and `maxTokens` from `~/.pi/agent/models-store.json`
     (the CLI-refreshed store). Inheriting a stale built-in `api`/`baseUrl`
     surfaces as provider-side errors (e.g. HTTP 500).
2. `/go` rejected with `Conversation or task text is required` — startup
   model validation failed, so the pasted prompt was never accepted. Fix the
   model error above and re-exec; do not resubmit `/go` into the dead
   session.
3. Plan aborts as unclear requirements on a bare issue URL — the plan step
   has no web tools and `auto_fetch: false` means the body never arrives.
   Embed the full issue title/body/acceptance criteria in the task text
   (fetch with `gh issue view` first). This applies to `takt run` too.
4. After any model/config fix, always re-exec with `replace: true` (a fresh
   PTY picks up `models.json` / preset changes), verify `takt_read_screen`
   shows the `[assistant] Model:` line with no `Failed` above `Assistant>`,
   then submit `/go`.

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
- `pi --list-models` is candidate evidence only. The embedded TAKT runtime must
  also have the route in its shipped catalog or approved `models.json` overlay;
  `models-store.json` alone may not be loaded. Never copy credentials from
  `auth.json` or mutate global model settings without explicit approval.
- If the user explicitly requests a different profile, pass that profile name
  and keep the chosen task body unchanged.

## Explicit invocation

Users can force this skill with:

```text
/skill:takt-pi-runner <task body>
```

The text after the command is the task body. Use the same default profile and
tool call unless the user includes an explicit `profile: <name>` instruction.
