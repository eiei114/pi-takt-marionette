# Usage

## Queue a task

1. Run `/takt:enqueue [path]` in Pi. Omit the path for the current Pi project.
2. Enter the task description.
3. The extension sends `/go <task>` through `takt-acp` with
   `defaultAction: "enqueue"`.
4. TAKT writes the pending task using its own worktree defaults.

The bridge does not write `.takt/tasks.yaml` itself. ACP is the control
boundary for task creation.

For agent-driven work, start with the bundled `takt-pi-orchestrator` Skill. It
asks the minimum TAKT target/intent/setup questions, then routes to
`takt-pi-task-planner` or `takt-pi-runner`. The planner discusses the goal,
scope, non-goals, acceptance criteria, and validation in Pi, asks for
confirmation, then calls `takt_enqueue_task`. The tool queues the finalized
body through ACP and does not start execution. The runner handles explicit
execution and recovery.

## Start and stop

`/takt:start` asks for confirmation, then starts `takt run` in the selected
project inside a PTY. Pass an absolute folder path to target another registered
or unregistered project, for example `/takt:start C:\\work\\repo`. TAKT owns
task execution and worktree creation. The live widget shows the same terminal
output that a normal `takt run` terminal shows, including intermediate output.
`/takt:stop [path]` sends Ctrl-C and uses a bounded force-kill fallback when the
child does not exit. A stop timeout is reported as an error; Pi never retries
indefinitely or stops a PTY it did not create.

`/takt:project C:\\work\\repo` registers a folder for recurring detection. The
registry is stored in the user config directory, not in the vault. The current
Pi folder is always included.

For a one-shot project bootstrap, use `/takt:project:init [profile]`. It creates
the project-local `.takt/exec/presets/` and `.takt/workflows/` directories,
registers the project, and saves a named profile. The equivalent agent tool is
`takt_project_setup`:

```json
{
  "profile": "pi-takt-marionette",
  "cwd": "C:/work/repo",
  "preset": "pi-docs",
  "copyGlobalPreset": true
}
```

When the selected preset is absent locally, setup copies only that preset from
the global TAKT directory. It does not copy tasks, runs, sessions, logs, or
credentials. Existing local presets are never overwritten, so the operation is
safe to repeat.

### Named project profiles

Use a profile when a project is used repeatedly. Register the path and default
exec preset once:

```text
/takt:profile:add pi-docs
```

Enter `C:\\Users\\Keisu\\Projects\\OSS\\takt` as the folder and `pi-docs` as
the optional preset. Later, the profile name resolves to that folder for all
project-targeting commands:

```text
/takt:clear pi-docs
/takt:exec pi-docs
/takt:send pi-docs
/takt:status pi-docs
```

`/takt:profile` lists saved profiles and `/takt:profile:remove pi-docs` removes
the alias without removing the watched project folder. Profile data lives in
the user config directory. The bridge never searches arbitrary directories or
silently selects a similarly named repository. `@pi-docs` is accepted as an
explicit alias form.

## Agent Skill automation

The package includes `takt-pi-runner`. When the user asks Pi to execute an issue
through TAKT, the skill first calls `takt_read_screen` when an existing run
may be present, then calls `takt_exec_prompt` with a concise task body and
`replace: true`. The tool resolves the named profile, reconciles the current
session, stops only a bridge-owned PTY, waits for its exit, disposes its PTY and
screen, then runs `takt clear` and starts a fresh `takt exec <preset>`, submits
the body as a bracketed paste, then submits `/go`. With `replace: true`, the
clear step is mandatory even if `clear: false` is supplied. It returns after
submission, switches input mode to `pi-auto`, and keeps
the live raw PTY visible in the Pi project stack.

When the user requires an exact builtin or project workflow, the runner uses
`takt_run_workflow` instead of treating `workflow:` as prompt prose. The tool
starts a bridge-owned direct TAKT run and forwards `--task`, `--workflow`,
provider/model, repository, and PR flags as separate arguments. Pass
`prNumber` instead of `task` for PR-review fixes; the bridge emits `--pr <N>` so
TAKT fetches review comments and preserves the PR base/head and branch context.
`task` and `prNumber` are mutually exclusive. Pi extension sources can be
injected temporarily for that run without modifying Pi settings.
An exact `#<number>` task remains a positional issue reference so TAKT fetches
the issue instead of treating it as literal task prose.
`autoPr` and `draftPr` require `pipeline:true`, matching TAKT's CLI contract;
the bridge rejects that invalid combination before launching a child process.

Use `takt_stop` to stop a stuck bridge-owned session without confirmation, and
`takt_set_mode` for explicit mode changes. `takt_read_screen` reports status,
PID, stage, and last exit so agents can tell `live` / `stale` / `completed` /
`unknown` apart and distinguish `pasting` / `sending_go` / `running`. During
paste stages the widget shows a truncated prompt preview instead of the full
body.

`running` describes workflow activity. `ptyRunning` separately reports whether
the bridge still owns a live interactive TAKT terminal. A completed workflow
can therefore report `status: completed`, `running: false`, and
`ptyRunning: true` until that reusable terminal exits or is stopped; this does
not mean the workflow is still executing.

To continue a checkpoint without resubmitting the task, call
`takt_resume_run` after the owned PTY has stopped:

```json
{
  "profile": "dtm-cursor",
  "provider": "devin",
  "model": "swe-1-7"
}
```

For DTM Cursor, the bridge runs `takt --provider devin --model swe-1-7 resume`,
waits for TAKT's `Requeue` menu, and selects it with a literal Enter.
It does not run `takt clear` or paste the original task again. `takt_stop` also
accepts `forceObserved: true` to close stale/ownerless `running` metadata while
preserving unknown fields such as TAKT's checkpoint data. It never kills an
external live PID.

For non-DTM projects using a custom Pi provider, configure required Pi
extensions in the project's `.takt/config.yaml` under
`provider_options.pi.extensions`. TAKT 0.58 does not reliably carry
actor-local `provider_options` from an exec preset into the generated immutable
workflow, so the project-level setting is the stable route for models such as
`cursor/composer-2.5-fast`.

## Manual GO mode

Use manual mode when task clarification should never start execution
automatically:

```json
{
  "profile": "dtm-cursor",
  "prompt": "<task body>",
  "goMode": "manual",
  "replace": true
}
```

The bridge waits for the assistant's clarification response and a fresh
`Assistant>` prompt, then returns `sentGo: false` and `awaitingGo: true`.
Nothing sends `/go` until `takt_submit_go` is called. Legacy `sendGo: false`
selects the same manual behavior. Auto and explicit GO both send raw `/go` plus
Enter; bracketed paste remains reserved for multiline task bodies.

Force the skill with `/skill:takt-pi-runner <task body>`. If the bridge tool or
profile is unavailable, or the named profile resolves to a different cwd, the
skill stops with the exact reload/package or profile/cwd mismatch; it never uses
`taskkill`, Computer Use, a guessed cwd, direct shell `takt exec`, or another
provider.

The extension only controls child processes it started. A `takt run` or
`takt exec` process started in another terminal is observed through `.takt`
metadata once it creates a run, but Pi cannot safely attach to that terminal's
raw PTY. Such external activity never renders in the live widget automatically;
inspect it explicitly with `/takt:status [path]` or `takt_read_screen`, and Pi
still never kills it.

Typing `@<label> <verb>` in the editor runs those actions without any
slash command — the message never reaches the main agent:

- `@playground2 stop` — stop that session
- `@playground2 inspect` — open the live inspector
- `@playground2 tasks` — list/delete/reset its queued tasks
- `@playground2 flush` — flush its queued input
- `@playground2 status` — diagnostic status overlay
- `@playground2 live` — peek its raw screen
- `@playground2 talk <text>` — send a message (queued while executing)

A matching session is resolved from the `@` label (exact, then unique
prefix/suffix); unknown labels fall through to the agent.

## Conversational control and @ mentions

`/takt:ask @<label> <message>` sends a message to a specific TAKT session; with
one session `@` is optional. While a workflow is executing the message is
queued and flushed when the session is ready. The editor's `@` completion
now also lists running TAKT sessions next to file mentions — pick one to insert
`@<label>` and use it with `/takt:ask`.

`/takt:inspect` doubles as a control panel:

- `t` — talk to the selected session (conversational input)
- `s` — stop the selected session (confirms first)
- `l` — list the session's queued tasks, then reset one to pending or delete it

Stopping or mutating tasks edits `.takt/tasks.yaml` directly and is safe while
the bridge owns the terminal; avoid doing it while another daemon is running
the same queue.

## Inspecting what a session is doing

`/takt:inspect` opens a live, arrow-driven session list: every known session
shows its current state (`⏳q<N>` queue depth, step/phase/worker position,
elapsed clock, heartbeat/spinner). `↑`/`↓` move between sessions,
`Enter` opens the raw screen peek of the selected session, `Esc` closes. The
list refreshes once a second while open, so you can watch a workflow advance
without staring at the raw PTY.

## Queued input while executing

Input typed while the workflow is executing no longer vanishes. Lines from
`/takt:send`, pi-mode submits, or takt-focus keystrokes are buffered per
project and shown as `⏳q<N>` on the session row. When the session reaches a
prompt again the buffer flushes as one ordered batch (`/takt:flush` forces it
early). Destructive lines (`/clear`, `rm -rf`, ...) are never auto-sent: they
stay queued behind a warning until confirmed.

## Interactive `takt exec`

`/takt:clear [path]` optionally clears the previous project exec session first.
Then `/takt:exec [path]` starts a fresh `takt exec` process in a selected project.
The command intentionally does not pass `--continue`. Use `/takt:send [path]`
to open Pi's multiline editor and send the issue body or `/go` explicitly to
that project. The bridge uses terminal bracketed-paste markers, so newlines stay
inside one TAKT input; submit the issue body first, then send `/go`. This keeps
normal Pi input focused on Pi while preserving the raw TAKT PTY screen above it.

## Dual input modes

The stacked widget shows the current input mode:

```text
input: [pi] | takt | pi-auto
```

Cycle with `F6` or `/takt:mode`. On Mac keyboards configured for media keys,
press `Fn+F6`; `Ctrl+Option+T` remains the macOS compatibility shortcut.
Windows keeps `Ctrl+Alt+T` unchanged. The first supported macOS terminals are
Apple Terminal and iTerm2.

| Mode | Behavior |
|---|---|
| `pi` | Default. Pi keeps editor focus. Use `/takt:send` or `takt_exec_prompt`. |
| `takt` | Human keys go to the active bridge-owned TAKT PTY. `F6` (macOS `Fn+F6`) and the platform compatibility shortcut are intercepted before TAKT sees them, so mode cycling keeps working; `/takt:mode` also switches. |
| `pi-auto` | Pi may call `takt_read_screen` / `takt_send_input` for short follow-ups. |

`takt_exec_prompt` enters `pi-auto` automatically after a successful submit.
`takt_read_screen` and `/takt:status` report `live`, `stale`, `completed`, or
`unknown`, plus PID, stage, and last exit when available. `takt` and `pi-auto`
require a running bridge-owned session. If that session exits, the bridge falls
back to `pi`. Destructive auto input such as `/clear`
still asks for confirmation. `/takt:stop` keeps an interactive confirm; the
`takt_stop` tool skips confirm so agents can recover cleanly.

### macOS startup and keyboard troubleshooting

The mode-cycle shortcut uses a platform keyboard adapter at the raw terminal
input boundary. The input-mode state machine remains platform-neutral. `F6` is
the primary shortcut on every OS; macOS displays `F6 / Fn+F6` because Mac
function keys may be configured as media keys. Unknown terminal bytes pass
through unchanged.

The bridge defaults to the globally installed `takt` command. It does not
require a local TAKT checkout or per-session PATH setup. Before starting a
broker-owned PTY, Marionette repairs executable bits on `node-pty`'s
`spawn-helper`, including the hoisted npm layout used by Pi. If macOS still
reports `posix_spawnp failed`, check Xcode Command Line Tools and use an
absolute `TAKT_COMMAND` only when Pi was launched without the expected PATH.

## Live widget and diagnostics

`/takt` starts a run in the current project if no terminal session exists, or
shows the current stack. `/takt:live [path]` and `/takt:sessions` open an
Esc-closable overlay with the raw TAKT screen of the chosen session; the
stacked widget itself stays summary-only. The widget is placed above the normal
Pi editor, so Pi and multiple TAKT sessions stay visible together. Raw peek
overlays use a detached `node-pty` broker plus an xterm-compatible headless buffer so ANSI cursor
movement, clear-screen sequences, colors, and progress updates are rendered as
a screen rather than dumped as broken escape codes. Peek output is capped to
the latest lines to preserve Pi's editor space. While a bridge-owned PTY is
active, the widget also performs a lightweight 100 ms repaint fallback so the
spinner keeps turning even if host-side screen events are coalesced.

`/reload` detaches the old extension client but leaves its broker-owned TAKT
process alive. The replacement extension reconnects through a Unix socket on
macOS/Linux or a named pipe on Windows, keeps the same PID, and replays the
bounded raw transcript to restore the xterm screen. Execution stage, prompt
preview, and queued input are restored too, so an `awaiting_go` session can
still use `takt_submit_go` after reload. Broker discovery uses an authenticated
descriptor in a private per-user runtime directory. Quit and other real session
shutdowns still stop the owned process; a live broker with no reconnecting
client self-stops after five minutes. External terminals cannot be adopted
retroactively because Marionette never owned their PTY.

The background project-stack refresh reads persistent `.takt/runs` metadata and
does not invoke `takt list`. The stacked widget itself only renders TAKT
processes owned by this Pi session; observed pending, blocked, failed, and stale
activity from other sessions stays out of the widget entirely. Queue
reconciliation is an on-demand diagnostic operation, so `/takt:status` may show
queue counts that the widget never displays. This is presentation cleanup only:
the bridge does not delete `.takt/tasks.yaml` entries or run history, so a
pending task can still be inspected and deliberately removed with TAKT's own
task-management flow.

When a running run has a workflow bundle, each project card shows its current
step and phase as a compact monospace bar, for example
`flow default [##########>---------] 2/3 step: implement · p1/3 execute`.
Workflows resolved from TAKT's built-in set are marked with `(default)`, for
example `flow dual (default)`, so they stay distinguishable from workflows
defined in the project's `.takt/workflows`. Before run metadata is available,
the bar tracks bridge stages such as `waiting prompt` and `sending go` instead.

### Per-step model selection (`/takt:models`)

`/takt:models [workflow]` selects a Pi model per workflow step before the
workflow starts. The command lists steps from project, user-global, and
builtin workflow YAML (top-level `workflow_call` steps expand one level),
then shows one type-to-filter dialog per step with every model `pi
--list-models` reports — auth-configured extension providers appear
automatically, so provider prerequisites stay linked behind the scenes.
Choosing `(inherit global default)` leaves a step untouched.

Selections merge into the project's `.takt/runtime.yaml` as runtime-v1
profiles (`provider: pi`) plus `<workflow>/<step>` targets, preserving
existing profiles and unrelated step targets. TAKT resolves these at run
start; an active runtime section must not coexist with legacy provider
settings such as `config.yaml` `provider_routing`, so projects using those
must migrate first or keep using their current configuration.

In the default `pi` mode the widget does not capture keyboard focus. Use
`/takt:send` for explicit interactive input, `/takt:mode takt` for direct PTY
focus, and `/takt:stop` to stop TAKT. When a bridge-owned child exits, is
stopped, or its bridge-tracked exec run reaches a terminal status, the live
widget is cleared. A historical completed run is not enough to clear a newly
started session. While a bridge-owned PTY is preparing and TAKT reports no
active counts, the stack keeps only the current project as a compact
`preparing` card. Use `/takt:status` or `takt_read_screen` for final diagnostics.

`/takt:status` remains available as an optional diagnostic overlay. It is not
the execution view and is not polled into the live output widget. It is the
explicit path that reconciles `.takt/runs` with `takt list`; a malformed task
queue therefore produces one actionable diagnostic error instead of a
repeating background warning. Unexpected background refresh failures follow
the same policy: one warning, then an inline `xN` count for the same error;
successful refresh resets the counter.

The diagnostic overlay's `running`, `pending`, `blocked`, `failed`, and
`completed` counts are reconciled from both sources. A running metadata record
is `live` only when a matching metadata/task record exposes a live owner PID; a
dead PID is `stale`, and a missing PID is `unknown`. `completed` and `stale`
observations do not block the next bridge-owned exec; `live` and unresolved
`unknown` sessions remain protected from duplicate starts.

## macOS environment

Pi started from Finder or a launch agent can have a shorter `PATH` than a
Terminal session. If `takt` works in Terminal but Pi reports `ENOENT`, set
absolute paths with `TAKT_COMMAND=/opt/homebrew/bin/takt` and
`TAKT_ACP_COMMAND=/opt/homebrew/bin/takt-acp` (adjust for Intel Homebrew or a
custom install). If `node-pty` has no matching native prebuild, install Xcode
Command Line Tools with `xcode-select --install`.

After `npm ci` / `npm install`, this package runs
`scripts/ensure-node-pty-helpers.mjs` so `node-pty`'s `spawn-helper` binaries
are executable. Without that chmod, macOS can fail PTY spawn with
`posix_spawnp failed` because the published helpers are mode `0644`.
