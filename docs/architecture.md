# Architecture

```text
Pi command / project path
        │
        ├── project registry ── current cwd + registered repo/folder paths
        │                         │
        │                         └── `.takt` metadata polling for external runs
        │
        ├── profile registry ── explicit alias → project cwd + exec preset
        │
        ├── takt_workflow_catalog tool ── effective project → user → builtin
        │                                  standalone catalog + categories/search
        ├── orchestrator → next-step ── one unmet preflight boundary
        │       │
        │       ├── intake → project-setup → workflow-selection
        │       ├── planner → queue-gate ── exact `workflow: <id>` task contract
        │       ├── takt_enqueue_task ── direct task-file enqueue + verify workflow/policy
        │       └── run-gate ── explicit all-pending queue/run intent → runner
        │
        ├── takt_exec_prompt tool ── reconcile → stop → clear → exec → prompt → auto `/go` or manual `awaiting_go`
        ├── takt_run_workflow tool ── exact workflow/task/provider/model → bridge-owned direct PTY run
        ├── takt_submit_go tool ── explicit raw `/go` + Enter → pi-auto
        ├── takt_resume_run tool ── explicit provider/model → resume → Requeue → pi-auto (no clear)
        ├── takt_stop / takt_set_mode tools ── agent recovery without shell/taskkill
        │
        ├── takt_enqueue_task ── direct task-file enqueue + verification
        │
        ├── keyboard adapter → normalized mode-cycle action
        └── socket client ↔ detached PTY broker → node-pty → `takt run` / `takt exec`
                               │                         │
                     bounded raw transcript      ANSI/TTY output
                               │                         │
                         reconnect/replay → xterm headless screen buffer
                                                     │
                                          Pi stacked project live widget
```

## Boundaries

- Direct `.takt/tasks.yaml` plus `order.md` persistence is the enqueue boundary.
- `takt-pi-next-step` is the pre-execution route navigator. Its internal phase
  Skills resolve intake, project setup, workflow selection, task planning,
  enqueue verification, and the final run-intent gate. Each phase has one
  owner and a done condition; no phase starts execution implicitly.
- `takt_workflow_catalog` is the read-only selection seam. It follows TAKT's
  project > user-global > builtin resolution, honors builtin enable/ignore
  settings, deduplicates names, exposes categories/source/description, and
  excludes callable/internal workflows. Catalog failure is fail-closed.
- `takt_enqueue_task` is the agent-facing queue seam. It accepts a finalized
  task body with one exact `workflow: <id>` directive, an explicit per-task
  worktree choice, and PR mode (`none`, `regular`, or `draft`). It resolves an
  explicit profile/project and verifies the workflow plus persisted
  `worktree`/`auto_pr`/`draft_pr` fields after writing the pending task. A
  mismatch or missing report leaves the task unverified and blocks execution.
  `takt-pi-orchestrator` owns selection; planner only clarifies/queues.
- `takt_run_pending` is the agent-facing execution seam. It requires explicit
  run intent and shares the `/takt:start` run-controller/PTY/widget lifecycle;
  it starts public `takt run` for all pending tasks. `takt_exec_prompt` remains
  an explicit instant/interactive escape hatch, not the normal route.
- Public TAKT CLI commands are used through a PTY so TAKT sees a real terminal
  and keeps its normal screen behavior.
- `.takt/runs/*/meta.json` is the persistent run state source. NDJSON logs are
  a diagnostic source; they are not used to replace the live terminal output.
  Status views distinguish `live`, `stale`, `completed`, and `unknown`, and
  expose the observed PID, stage, and last exit when available.
  After an owned stop, the bridge atomically reconciles its tracked `running`
  record to `aborted` while retaining unknown fields and checkpoint payloads.
  Explicit forced recovery applies only to stale/unknown records, never a live
  externally owned PID.
- Each bridge-owned project has one detached PTY broker and one extension-side
  xterm screen. On `/reload`, the old extension disconnects without stopping
  TAKT; the new extension reconnects through the persisted broker descriptor
  and rebuilds xterm by replaying the broker's bounded transcript. Discovery
  uses an atomic authenticated descriptor inside a mode-0700 per-user runtime
  directory; each broker owns a unique mode-0600 socket, preventing concurrent
  starters from unlinking one another. Unix uses a user-local Unix socket and
  Windows uses a named pipe. Stage, prompt preview, and queued input live beside
  the broker state so approval controls survive reconnect. Real session shutdown
  stops the owned process and broker, and a disconnected live broker enforces a
  bounded five-minute reconnect lease. Projects are rendered as
  a single stacked widget above the normal Pi editor, with active projects first.
  The live widget keeps a lightweight 100 ms repaint fallback while a PTY is
  active because host-side screen callbacks may be coalesced during in-place
  terminal updates.
- Named profiles persist an explicit alias, project cwd, and optional exec preset
  in the user config directory. The bridge does not scan arbitrary folders or
  silently guess a similarly named repository.
- `takt_project_setup` is the explicit bootstrap seam for new targets. It
  creates project-local `.takt/exec/presets` and `.takt/workflows`, registers
  the project/profile, and may copy only the selected global exec preset. It
  never copies run state, sessions, logs, tasks, or credentials.
- Project registry loading drops folders that no longer exist, preventing a
  stale registration from failing runtime initialization before the active
  project can be observed.
- The bundled Agent Skill uses queue/run for normal profile-bound execution;
  shell execution is not used as a substitute because it would hide the child
  PTY from the Pi widget. `takt_exec_prompt` is reserved for explicit
  instant/interactive requests.
- Exact builtin or project workflow execution uses `takt_run_workflow`. It
  forwards the task or native `--pr` source, workflow id, provider/model,
  repository, and PR flags as discrete CLI arguments. Native PR input retains
  TAKT's review-comment and base/head context instead of reducing it to task
  prose. Optional Pi extensions are injected through the child environment for
  that run only and never persist into Pi settings.
- Manual GO mode waits for clarification to finish and exposes
  `awaitingGo: true`; only `takt_submit_go` may cross that approval boundary.
  GO commands use raw terminal input rather than bracketed-paste markers.
- Checkpoint recovery uses `takt_resume_run`, not a fresh exec. It drives the
  public resume selection UI through the owned PTY and sends a literal Enter,
  avoiding both task replay and bracketed-paste control sequences in the menu.
- External project processes can be detected from `.takt` metadata, but their
  original PTY is not attachable safely. They use a status card; only
  broker-owned projects show reconnectable raw output.
- The background project-stack refresh reads persistent `.takt/runs` metadata
  only. The public `takt list` queue is reconciled on demand by diagnostics and
  explicit task operations, so an invalid queue cannot fail the live widget
  poll or spam Pi notifications. Unexpected repeated refresh failures use one
  warning plus an `xN` status count and reset after recovery.
- Default input mode is `pi`: input is not forwarded implicitly. `/takt:send`
  remains the explicit seam, and `/takt:stop` owns stopping bridge children.
- Optional dual-input modes use a platform keyboard adapter and cycle with
  `F6` (`Fn+F6` on macOS media-key layouts) or the platform compatibility
  alias: `pi` → `takt` (human types into the active bridge-owned PTY) →
  `pi-auto` (Pi may send allowed follow-ups). Windows keeps `Ctrl+Alt+T`;
  macOS displays `Ctrl+Option+T` as the compatibility label. The adapter
  normalizes terminal bytes before they reach the platform-neutral mode state
  machine. A raw terminal-input interceptor backs up the registered shortcut
  for macOS terminal encodings that bypass Pi's editor key matcher; unknown
  bytes pass through unchanged.
  A successful `takt_exec_prompt` enters `pi-auto` automatically. Destructive
  auto actions still require confirmation. External status cards are never
  writable. Stop retries are bounded; a timeout is returned as an explicit
  bridge error instead of starting a second process.
- Exec progress is tracked as stages and shown in tool updates, `takt_read_screen`,
  and the widget header. Once a run bundle is available, the project card also
  renders an ASCII progress bar from the workflow's current step and phase;
  bridge lifecycle stages provide the fallback before `meta.json` is complete.
  Natural PTY exits reconcile the controller, retained
  screen session, stage, and last exit before another exec is allowed. For an
  interactive `takt exec`, the bridge also tracks the run slug created after
  submission and clears the live widget when that run reaches a terminal
  status; historical completed runs are not treated as the current run.
  Diagnostics keep workflow completion separate from PTY ownership:
  `running` becomes false at terminal run status, while `ptyRunning` may remain
  true for TAKT's long-lived interactive process.
  When no active counts are observed during startup, only the current project
  renders a compact preparing card. During paste stages the widget overlays a
  truncated prompt preview instead of the full raw body.
- Workflow rows show the resolved source layer (`builtin`, `user`, or
  `project`) rather than labeling every builtin as `(default)`.
- External pending, blocked, failed, and stale activity keeps its latest queue
  or run timestamp. Non-running cards disappear after 30 minutes without new
  activity, but the bridge never mutates `.takt/tasks.yaml` or run history as
  part of that display cleanup.
- Session-owned history uses a separate three-day presentation window. Running,
  pending, and blocked work remains visible; completed, failed, stale, and
  aborted history older than three days is omitted from session selectors and
  retained outcome rows. This is filtering only: persisted task and run records
  remain available to explicit diagnostics.
- The macOS PTY preflight repairs `node-pty` `spawn-helper` permissions during
  install and again in the detached broker, resolving both package-local and
  hoisted npm dependency layouts. This keeps the global `takt` executable as
  the runtime default and avoids requiring a local TAKT build.
- A run is not assumed to be singular; the summary is derived from all run
  records in the project when the optional diagnostic overlay is requested.

The bridge does not import TAKT private modules. Its direct queue writer mirrors
TAKT's public task-file shape, lock-file convention, and atomic replacement;
execution remains on the public CLI boundary.
