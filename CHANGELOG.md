# Changelog

## 0.5.1 - 2026-08-31

- **`/takt:status` log details**: the diagnostic overlay now reads the latest
  run JSONL log tail (64 KiB, bounded) and shows a compact `log details`
  section with recent step, phase, worker progress, and a sanitized error
  excerpt when available. Missing or malformed logs surface short
  `no logs` / `unavailable` reasons instead of breaking the overlay.
  The live widget and `takt_read_screen` stay summary-only.

## 0.5.0 - 2026-08-29

- **Width-aware name elision**: long project folder names, workflow names,
  and step names in the live widget are now elided as `head…tail` instead of
  being sliced off at the right edge. The elapsed timer (`⏱`) and completion
  duration are always fully visible — the row reserves their width first and
  only then shares the remaining space across names by priority
  (label > workflow > step). CJK and wide emoji are measured by display
  column, so rows stay inside the widget width.
- The compact workflow widget elides task and step names under the same
  budget rule.

## 0.4.0 - 2026-08-29

- **Run outcome retention**: a finished TAKT run's `✅ 完了` / `🔴 ❌ 失敗`
  row now stays visible in the session-owned live widget until the project's
  next run starts or the Pi session ends, instead of disappearing the moment
  the run finishes.
- Run completion notifications now carry the outcome: `✅ TAKT <label>
  finished.` (info) or `🔴 TAKT <label> failed (exit N).` (error).
- A manually stopped session hides immediately and is never rendered as ✅.

## 0.3.6 - 2026-08-28

- `takt_resume_run` no longer reports a successful resume when TAKT picks a
  stale run whose workflow is missing (`Workflow "..." not found for direct
  run "..."`). It now fails with the failing line and a recovery hint (queued
  tasks are recovered with `takt run`) instead of pretending to continue.
- `TAKT status check failed for <profile>` errors now include the underlying
  cause (for example an invalid `.takt/tasks.yaml`) instead of the bare label.

## 0.3.5 - 2026-08-26

- Replace ACP task enqueue with direct, lock-protected writes to
  `.takt/tasks.yaml` and per-task `order.md`. The bridge preserves the exact
  task body, stores workflow/branch/worktree metadata, verifies the persisted
  pending record, and keeps execution behind the existing explicit run gate.

## 0.3.4 - 2026-08-24

- Split the pre-execution TAKT route into dedicated internal Skills for intake,
  project setup, workflow selection, enqueue verification, and the final run
  intent gate. `takt-pi-next-step` now hands off to the exact unmet preflight
  boundary and stops before execution without explicit user intent.

## 0.3.3 - 2026-08-24

- Add the `takt-pi-next-step` Skill, an ask-matt-style navigator that inspects
  target, setup, catalog, queue, run, and recovery state, then routes to one
  concrete next action without bypassing workflow selection or explicit run
  intent.

## 0.3.2 - 2026-08-24

- Add an effective TAKT standalone workflow catalog for project, user-global,
  and builtin workflows. Every fresh route can inspect category/search data;
  builtin enable/ignore settings and source precedence are respected, callable
  and internal helpers are excluded, and catalog failures fail closed.
- Require `workflow: <id>` in queued task bodies and verify the workflow
  reported by ACP. Add `takt_run_pending` for explicit all-pending `takt run`
  execution through the shared PTY/widget lifecycle; keep `takt exec` as an
  explicit instant/interactive path. Builtin workflow rows now show `· builtin`
  instead of the misleading `(default)` label.
- Render raw TAKT screens from the current viewport origin: normal-buffer
  scrollback no longer hides the latest reply behind stale top-of-scrollback
  lines in the live widget, `/takt:live`, and `takt_read_screen`.
- Make `takt` mode a real fullscreen focused terminal: entering it pins one
  bridge-owned running session automatically (or asks which one to pin when
  several run) and shows its raw PTY full-screen while exclusively owning
  human input — `Esc` returns to Pi, `Ctrl+C` forwards unchanged,
  `Ctrl+Alt+T` keeps cycling modes, and dimension changes resize the pinned
  PTY. The pinned view closes idempotently on runner exit, stop, reload, or
  shutdown and never re-targets input to another session.
- Add multi-session navigation inside focus: `Ctrl+Alt+↑/↓` move to the
  previous/next running session with wraparound, each switch updates display
  and input destination atomically with an `old → new` notification, and
  `/takt:session previous|next` provides the same transition as a command
  fallback for terminals that swallow modifier-arrow shortcuts.

## 0.3.1 - 2026-08-22

- Add the pi-takt-marionette mascot icon to the README and package assets:
  a cute `π` puppeteer controls a `TAKT` marionette with three precisely
  anchored strings.
- Include `assets/` in the published package files.

## 0.3.0 - 2026-08-22

- Add `/takt:lang`-style language switching: `/takt:lang [en|ja]` toggles or
  sets the widget UI language per session; English stays the default and the
  input line, header counts, and session-row states are all localized.
- Make the widget self-explanatory at a glance: the input line speaks without
  jargon ("⌨️ You are typing in Pi", "🤖 Autopilot on — Pi watches TAKT"),
  the header reads `N sessions · X running · Y done` instead of the
  marionette-string metaphor, auto-generated exec workflow names are dropped
  from rows entirely (the elapsed clock covers timing), and project-defined
  workflow names stay visible.
- Drop the run-level progress meter: rows keep discrete step position and worker completion only.
- Make TAKT sessions the top-priority entries in the editor's `@` completion:
  matching session labels lead the list with built-in file/path mentions
  underneath, instead of showing one or the other.
- Let `@<session> <verb>` run session actions without a slash command:
  `@playground2 stop|inspect|tasks|flush|status|live|talk <text>` are caught by
  an input router and handled locally; the message never reaches the agent.
- Extend the editor's `@` mention to include running TAKT sessions: type `@`
  and session labels complete alongside file mentions (built-in path completion
  is preserved); the inserted `@<label>` pairs with `/takt:ask`.
- Add `/takt:ask [@label] <message>` conversational routing and make
  `/takt:inspect` actionable: `t` talks to the selected session, `s` stops it,
  `l` lists/edits its queued tasks (reset to pending or delete).
- Make TAKT sessions the top-priority entries in the editor's `@` completion:
  matching session labels lead the list with built-in file/path mentions
  underneath, instead of showing one or the other.
- Let `@<session> <verb>` run session actions without a slash command:
  `@playground2 stop|inspect|tasks|flush|status|live|talk <text>` are caught by
  an input router and handled locally; the message never reaches the agent.
- Extend the editor's `@` mention to include running TAKT sessions: typing `@`
  completes session labels alongside the built-in file mention (path
  completion stays intact); the inserted `@<label>` pairs with `/takt:ask`.
- Add `/takt:ask [@label] <message>` for @-routed conversational input, and
  make `/takt:inspect` actionable: `t` talks to the selected session, `s`
  stops it, `l` lists/edits its queued tasks (reset to pending or delete).
- Add `/takt:inspect`, a live session inspector: arrow through running
  sessions, see what each is doing right now (step, workers, elapsed,
  heartbeat, queued depth), and Enter to peek its raw screen.
- Keep `Ctrl+Alt+T` working while takt focus owns the terminal: the raw-input
  interceptor recognizes the shortcut encoding, cycles the mode locally, and
  forwards every other byte unchanged.
- Queue input typed while a workflow is executing instead of dropping it: rows
  show `⏳q<N>`, the buffer flushes automatically when the session is ready
  or via `/takt:flush`, and destructive lines are held back for confirmation.
- Add an activity heartbeat and live elapsed clock to active rows: spinner
  speed follows real TAKT output (fast when writing, slowing when quiet,
  ⚠️ after ~30s of silence), and rows tick a `⏱ mm:ss` timer from run start.
- Cap workflow names in session rows to 22 characters so auto-generated exec
  slugs no longer truncate the rest of the line.
- Rename the package and repository to `pi-takt-marionette` (npm was never
  published under the old name; GitHub redirects the old URL). Saved profiles
  and registered projects keep using the stable `pi-takt-bridge` config
  directory, so existing setups keep working.
- Redesign the stacked live widget as a marionette-style session list: one row
  per session-owned TAKT process with a rotating braille spinner while actively
  operated, emoji status (🟢 running, ⏳ starting/waiting, ✅ done with duration,
  🔴 failed with an error snippet, ⚠️ stale), and a `🎭 TAKT · N strings`
  header. Raw PTY output is no longer shown by default; `/takt:live [path]` now
  opens an Esc-closable raw-screen peek overlay, and the new `/takt:sessions`
  lists every known session with status before picking one to peek.
- Make the stacked live widget a session-owned view: it renders only TAKT
  processes launched from the current Pi session. TAKT activity started in
  other terminals or other Pi sessions no longer mounts or populates the widget;
  inspect it explicitly with `/takt:status [path]` or `takt_read_screen`.
- Add `/takt:models [workflow]`: pick a Pi model per workflow step through
  type-to-filter dialogs and merge the result into the project's
  `.takt/runtime.yaml` as runtime-v1 profiles plus `<workflow>/<step>`
  targets. Model candidates come from `pi --list-models`, so auth-configured
  extension providers appear automatically; steps may also inherit the global
  default.
- Mark workflows resolved from TAKT's built-in set with a `(default)` suffix in
  the `flow` progress line (for example `flow dual (default)`), using the
  workflow bundle manifest's opaque ref source layer; project-defined and
  legacy manifests without an opaque ref stay unmarked.
- Fix macOS CI/`node-pty` startups that failed with `posix_spawnp failed`
  because the published `spawn-helper` binaries are mode `0644`; chmod them
  `0755` via root `postinstall` and an explicit CI step.
- Teach the TAKT Pi skills to ask once when a project has multiple matching
  workflows and the lane is still ambiguous (for example DTM Cursor
  `plan-verify` vs `plan-verify-grok`), while keeping explicit user/lane
  choices and resume/recovery paths silent.
- Make the TAKT Pi Orchestrator automatically bootstrap exact current or
  explicitly targeted projects before planning, execution, and recovery,
  carrying the returned profile forward instead of falling back to `pi-docs`,
  and route DTM Cursor work through its Devin SWE workflow.
- Discover persistent TAKT run metadata inside registered project worktree
  clones, so externally started worktree tasks remain visible in the stacked
  project widget without polling or locking the task queue.
- Prefer an active registered project over an idle current folder when reading
  external TAKT status through `takt_read_screen`.
- Fix a macOS PTY race where a clean, fast TAKT exit could arrive before the
  final `/go` acknowledgement was parsed, causing a successful submission to
  be reported as failed.
- Terminate ACP descendants through a dedicated POSIX process group and always
  clean up the owned child when ACP cancellation fails or times out.
- Add macOS CI coverage and document native `node-pty` and GUI-launched Pi
  `PATH` requirements.

## 0.2.0 - 2026-08-15

- Add `goMode: "manual"` and `takt_submit_go` so task clarification can finish
  without any automatic `/go`; send GO commands as raw text + Enter instead of
  bracketed paste.
- Add bridge-native checkpoint recovery with `takt_resume_run`, explicit
  provider/model routing, and automatic `Requeue` selection without clearing
  or replaying the task body.
- Wait for a fresh post-clarification `Assistant>` prompt before `/go`, then
  verify acknowledgement instead of relying on a fixed delay.
- Reconcile bridge-owned stops and explicitly forced stale/unknown metadata to
  `aborted` atomically while preserving checkpoint fields; external live PIDs
  remain read-only.
- Report terminal workflow state as `status: completed` / `running: false`
  even when the bridge still owns TAKT's long-lived interactive PTY; expose
  that transport detail separately as `ptyRunning`.
- Show the active workflow's current step and phase as a compact ASCII progress
  bar, using the immutable run workflow bundle with a bridge-stage fallback
  while metadata is still being created.
- Keep the background project-stack refresh on persistent run metadata instead
  of invoking `takt list`; queue reconciliation remains available on demand
  through diagnostics and malformed task queues no longer spam Pi warnings.
- Aggregate repeated unexpected background refresh failures into one warning
  plus an `xN` status count, resetting after recovery.
- Hide quiet external pending/blocked/failed/stale cards after 30 minutes and
  show all queue counts, without deleting TAKT task or run data.
- Add `takt_enqueue_task` and the `takt-pi-task-planner` Skill for a confirmed
  Pi-side planning → ACP queue flow that does not start execution.
- Add `takt-pi-orchestrator` as the TAKT front door for intake, setup, and
  routing to the planner or runner Skills.
- Clear the stacked live widget when a bridge-owned TAKT process exits or is
  stopped; final lifecycle diagnostics remain available through status tools.
- Clear the live widget when a bridge-tracked interactive exec run completes
  before its long-lived `takt exec` prompt process exits; ignore historical
completed runs and PTY silence as completion signals.
- Show only the current project as a compact preparing card when startup has
  no active TAKT counts, instead of retaining multiple idle project panels.
- Add `takt_project_setup` and `/takt:project:init` to create project-local
  `.takt` scaffolding, copy one selected global exec preset without copying
  runtime state, and register a reusable project profile idempotently.
- Ignore removed folders when loading the project registry so stale entries do
  not prevent a fresh runtime from starting.
- Add `takt_stop` and `takt_set_mode` tools so agents can recover without
  shell `taskkill` or manual `/takt:stop` / mode commands.
- Add `replace` to `takt_exec_prompt` (default true) to reconcile, stop, wait,
  dispose, and replace a running bridge-owned session before clear/exec/submit;
  `replace: true` always performs the clear step.
- Reconcile natural PTY exits and expose `live`, `stale`, `completed`, or
  `unknown` status with PID, stage, and last exit diagnostics; completed/stale
  state no longer blocks the next bridge-owned exec.
- Keep clear-session failures bounded and clean up their bridge-owned PTY before
  returning the timeout or exit error.
- Add fresh-runtime contract and natural-exit regression coverage for the five
  Pi tools and controller lifecycle.
- Track exec stages (`clearing` -> `waiting_prompt` -> `pasting` -> `sending_go` ->
  `running`, `completed`, plus stop/fail states) in tool updates,
  `takt_read_screen`, and the stacked widget header.
- Overlay a truncated prompt preview during `pasting` / `sending_go` so long
  issue bodies do not look like a frozen widget.
- Keep the bridge-owned live widget repainting at a short interval while a PTY
  is active, so in-place TAKT output remains visible even when host-side screen
  events are coalesced.
- Switch to `pi-auto` automatically after a successful `takt_exec_prompt`
  submit; abort/failure paths always stop the child PTY before returning.
- Update `takt-pi-runner` Skill for replace/stop recovery and concise prompts.
- Add ACP-first TAKT task enqueueing.
- Add worktree-safe `takt run` PTY process control.
- Add stacked live ANSI terminal widgets for multiple project folders.
- Add explicit `takt clear` before fresh exec when requested.
- Add fresh `takt exec` PTY launch and explicit multiline input sending.
- Add persistent named project profiles for path-free repeated commands.
- Add bundled `takt-pi-runner` Skill and `takt_exec_prompt` tool for exact
  issue-body → `/go` submission through the Pi PTY widget.
- Clamp every live-panel line to Pi's current terminal width so narrow
  terminals do not crash during rendering.
- Wait for the live `Assistant>` prompt before pasting, then send `/go`
  after a short settle instead of a 600s assistant-response wait.
- Stop the bridge-owned TAKT PTY when `takt_exec_prompt` fails mid-submit
  so orphan processes do not block retries.
- Add dual input modes cycled by `Ctrl+Alt+T` / `/takt:mode`:
  `pi` (default), `takt` (direct PTY focus), and `pi-auto`.
- Add `takt_read_screen` and `takt_send_input` tools for pi-auto follow-ups,
  with confirmation for destructive auto input.
- Detect external project activity through `.takt` state with status-only cards.
- Keep the queue/run reconciliation overlay as an optional diagnostic view.
