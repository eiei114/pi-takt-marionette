# pi-takt-marionette

[![CI](https://github.com/eiei114/pi-takt-marionette/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-takt-marionette/actions/workflows/ci.yml)
[![Publish](https://github.com/eiei114/pi-takt-marionette/actions/workflows/publish.yml/badge.svg)](https://github.com/eiei114/pi-takt-marionette/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/pi-takt-marionette)](https://www.npmjs.com/package/pi-takt-marionette)
[![npm downloads](https://img.shields.io/npm/dw/pi-takt-marionette)](https://www.npmjs.com/package/pi-takt-marionette)
[![License: MIT](https://img.shields.io/github/license/eiei114/pi-takt-marionette)](https://github.com/eiei114/pi-takt-marionette/blob/main/LICENSE)
![Pi Package](https://img.shields.io/badge/Pi-Package-blue)
[![Trusted Publishing](https://img.shields.io/badge/npm-provenance-yellow)](https://docs.npmjs.com/generating-provenance-statements)

<p align="center">
  <img src="assets/icon-pi-takt.png" alt="pi-takt-marionette icon" width="320">
</p>

Pi extension for running and monitoring [TAKT](https://github.com/eiei114/takt)
projects in stacked live widgets inside the Pi TUI.

## Status

This is an early MVP. It deliberately uses TAKT's public `takt-acp` stdio
interface for enqueueing and runs public TAKT CLI commands inside real PTYs.
The live widget renders TAKT's terminal screen (including in-progress output,
ANSI control sequences, and prompts) instead of reducing bridge-owned
execution to a status widget. It clears automatically when the bridge-owned
process exits or is stopped, or when the bridge-tracked exec run reaches a
terminal status. Historical completed runs never trigger that transition;
when counts are all zero during startup, only the current project gets a
compact `preparing` card. Final diagnostics remain available through
`/takt:status` and `takt_read_screen`.

## Prerequisites

- Pi 0.83 or later
- TAKT 0.58 or later installed as the `takt` and `takt-acp` commands
- A configured TAKT provider/model
- On macOS, `node-pty` may need Xcode Command Line Tools when a matching
  native prebuild is unavailable (`xcode-select --install`). Fresh installs
  also need executable `spawn-helper` bits; this package chmods them in
  `postinstall` (otherwise macOS can fail with `posix_spawnp failed`).

## Install

```text
pi install npm:pi-takt-marionette
pi install git:github.com/eiei114/pi-takt-marionette
```

For local development:

```text
pi -e C:/path/to/pi-takt-marionette/extensions/index.ts
```

## Commands

| Command | Purpose |
|---|---|
| `/takt` | Start or attach to the live TAKT widget |
| `/takt:live [path]` | Peek a session's raw TAKT screen (Esc closes) |
| `/takt:sessions` | List TAKT sessions with status and pick one to peek |
| `/takt:ask [@label] <msg>` | Talk to a TAKT session, routed by @mention |
| `/takt:inspect` | Live session inspector: ↑/↓ pick a session, see its state, Enter peeks raw screen |
| `/takt:flush [path]` | Send queued input lines to the running TAKT session |
| `/takt:lang [en|ja]` | Switch widget language for this session (no argument toggles) |
| `/takt:enqueue [path]` | Ask TAKT ACP to add a worktree task in a selected folder |
| `/takt:project [path]` | Register another repo/folder for detection and stacked display |
| `/takt:project:init [profile]` | Create project-local `.takt` scaffolding and register a profile |
| `/takt:project:remove [path]` | Stop watching a registered folder |
| `/takt:profile:add [name]` | Save a named folder and optional exec preset once |
| `/takt:profile [name]` | List saved project profiles |
| `/takt:profile:remove [name]` | Remove a saved project profile |
| `/takt:models [workflow]` | Pick per-step Pi models for a TAKT workflow into `.takt/runtime.yaml` |
| `/takt:start [path]` | Confirm and start pending tasks in the selected folder |
| `/takt:clear [path]` | Clear the selected project's previous TAKT exec session |
| `/takt:exec [path]` | Start a fresh interactive `takt exec` PTY in a selected folder |
| `/takt:send [path]` | Paste multiline input into a bridge-owned interactive TAKT session |
| `/takt:mode [pi\|takt\|pi-auto]` | Cycle or set dual-input mode (`Ctrl+Alt+T`) |
| `/takt:session previous\|next` | Switch fullscreen focus to the previous/next running session (same ordering as `Ctrl+Alt+↑/↓`) |
| `/takt:stop [path]` | Confirm and interrupt a TAKT process started by Pi |
| `/takt:status` | Open the optional diagnostic state overlay |

The bundled `takt-pi-orchestrator` Skill is the front door for TAKT requests. It
asks the minimum setup/intent questions, prepares the exact project, and routes
to `takt-pi-task-planner` or `takt-pi-runner`. The `takt_enqueue_task` agent
tool queues a finalized task through ACP without starting execution. The
planner uses it after a Pi-side conversation has settled goal, scope,
non-goals, acceptance criteria, and validation; the runner remains the
separate execution path.

The bundled `takt-pi-runner` Agent Skill calls the `takt_exec_prompt` tool for
the common issue-body → `/go` flow. Its published schema includes the `replace`
option; the normal call passes `replace: true`. It uses the `pi-docs` profile by
default, prefers a concise prompt, replaces a running bridge-owned session when
needed, clears the old session, starts a fresh preset, submits `/go`, and
switches to `pi-auto`. Raw output stays in the stacked Pi widget; long pastes
show a truncated preview while `stage` is `pasting` / `sending_go`. Agents can
also use `takt_stop`, `takt_resume_run`, and `takt_set_mode` for recovery.
`takt_resume_run` continues a checkpoint through TAKT's `Requeue` action with
an explicit provider/model and does not clear or replay the task.
`takt_read_screen` reports
`live`, `stale`, `completed`, or `unknown` with PID, stage, and last exit when
available. If a fresh Pi runtime is missing one of these tools or the named
profile does not resolve to the requested cwd, the skill reports the exact
reload/package or profile/cwd mismatch instead of guessing a path.

For approval-gated execution, pass `goMode: "manual"`. The bridge submits the
task, waits for TAKT to return to a fresh `Assistant>` prompt, and returns with
`awaitingGo: true` without sending `/go`. After reviewing the live screen, call
`takt_submit_go`. The explicit GO tool sends raw `/go` + Enter, avoiding
bracketed-paste control bytes.

For a new target, the skill first uses `takt_project_setup` when available. It
creates project-local `.takt/exec/presets` and `.takt/workflows`, registers the
project/profile, and copies only the selected exec preset from the global TAKT
directory when the project does not already have it. Runtime state, tasks,
runs, sessions, logs, and credentials are never copied. Setup is idempotent;
`overwrite` is required to move an existing profile to another folder.

After a session is live, dual input modes let you keep talking to TAKT without
leaving Pi:

- `pi` (default): editor stays on Pi; use `/takt:send` or tools
- `takt`: fullscreen focus — Pi pins a bridge-owned running session and shows
  its raw PTY in a full-terminal view while your keys go only to that session.
  With one running session it pins automatically; with several, pick one first
  (current cwd is highlighted but Enter still confirms). `Esc` returns to Pi,
  `Ctrl+C` reaches TAKT unchanged, and `Ctrl+Alt+T` still cycles modes
  (intercepted before TAKT sees it).
- Input typed programmatically while a workflow is executing is queued
  (`⏳q3` on the row) and flushed automatically when the session is ready, or
  via `/takt:flush`; queued lines stay owned by their original project when
  you switch focus
- `Ctrl+Alt+↑` / `Ctrl+Alt+↓` move to the previous/next running session with
  wraparound; each switch updates the raw display and input destination
  atomically and prints a concise `old → new` note. If your terminal eats
  those shortcuts, `/takt:session previous|next` does the same thing.
- When the pinned session finishes or stops, focus closes and Pi returns to
  `pi` mode — input is never re-targeted to another session automatically.
- `pi-auto`: entered automatically after a successful `takt_exec_prompt`; Pi can
  inspect with `takt_read_screen` and send follow-ups with `takt_send_input`
  (destructive input still confirms)

The current Pi folder plus registered folders are monitored. The stacked live
widget is a session-owned, summary-only view: it renders one compact row per
TAKT process launched from this Pi session, with the most active first —

```
🎭 TAKT · 3 sessions · 1 running · 2 done
⠋ 🟢 repo-a · dual    ███▓░░░░░░░ 🔨 implement 2/3 w1/2
✅ repo-b · default    done · 12m
```

The heartbeat spinner spins at the speed of real TAKT output: fresh writes
keep it fast, a quiet stretch slows it, and ~30s of silence flags the row with
⚠️ as possibly stuck. Actively operated rows tick a live `⏱ mm:ss` elapsed
clock from run start. Completed
and failed sessions stop spinning (`✅` done, `🔴 … ❌ failed` plus an error
snippet). Rows show discrete facts only — step position and parallel worker
completion (w2/3) — instead of a synthetic progress bar. Raw PTY output is never shown by
default: peek it explicitly with `/takt:live [path]` or `/takt:sessions`, or
inspect external runs (other terminals or other Pi sessions) via
`/takt:status [path]` or `takt_read_screen`. Inside `takt` mode the pinned
session's raw screen is the display itself, always showing the latest viewport
after scrollback. This only cleans the Pi display;
it never deletes TAKT tasks or run history automatically. The bridge only stops
PTYs it created, and bounded stop failures are reported instead of retried
indefinitely.

Default mode keeps Pi focused. Use `/takt:mode` or `Ctrl+Alt+T` when you want
direct TAKT focus or Pi-auto follow-ups.
Registered folders and named profiles are saved outside the vault in the user
config directory. A profile makes a folder path optional for every command:

```text
/takt:profile:add pi-docs
# enter C:\Users\Keisu\Projects\OSS\takt and pi-docs once
/takt:clear pi-docs
/takt:exec pi-docs
```

Profile names also work with an `@` prefix. An Agent Skill alone cannot change
the child process working directory, so the bridge uses a persistent profile
instead of silently guessing a path.

## Configuration

The bridge uses `takt-acp` and `takt` from `PATH`. Override the executable names
when needed with `TAKT_ACP_COMMAND` and `TAKT_COMMAND`. Pi launched from a
macOS GUI, Finder, or a launch agent may not inherit Homebrew, nvm, Volta, or
npm-global paths; use absolute command paths in that case, for example:

```text
TAKT_COMMAND=/opt/homebrew/bin/takt
TAKT_ACP_COMMAND=/opt/homebrew/bin/takt-acp
```

No Pi provider setting is changed by this package.

See [`docs/usage.md`](docs/usage.md) and
[`docs/architecture.md`](docs/architecture.md) for the current boundaries and
known limitations.
