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
        │       ├── takt_enqueue_task / takt-acp ── enqueue + verify workflow
        │       └── run-gate ── explicit all-pending queue/run intent → runner
        │
        ├── takt_exec_prompt tool ── reconcile → stop → clear → exec → prompt → auto `/go` or manual `awaiting_go`
        ├── takt_submit_go tool ── explicit raw `/go` + Enter → pi-auto
        ├── takt_resume_run tool ── explicit provider/model → resume → Requeue → pi-auto (no clear)
        ├── takt_stop / takt_set_mode tools ── agent recovery without shell/taskkill
        │
        └── node-pty → `takt run` / `takt exec` in selected project
                         │
              ANSI/TTY output → xterm headless screen buffer
                         │
              Pi stacked project live widget
```

## Boundaries

- ACP is the primary protocol for enqueueing.
- `takt-pi-next-step` is the pre-execution route navigator. Its internal phase
  Skills resolve intake, project setup, workflow selection, task planning,
  enqueue verification, and the final run-intent gate. Each phase has one
  owner and a done condition; no phase starts execution implicitly.
- `takt_workflow_catalog` is the read-only selection seam. It follows TAKT's
  project > user-global > builtin resolution, honors builtin enable/ignore
  settings, deduplicates names, exposes categories/source/description, and
  excludes callable/internal workflows. Catalog failure is fail-closed.
- `takt_enqueue_task` is the agent-facing queue seam. It accepts a finalized
  task body with one exact `workflow: <id>` directive, resolves an explicit
  profile/project, and verifies the workflow reported by ACP after the pending
  task is written. A mismatch or missing report leaves the pending task in
  place as unverified and blocks execution. `takt-pi-orchestrator` owns
  selection; planner only clarifies/queues.
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
- Each bridge-owned project has one PTY/xterm screen. Projects are rendered as
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
- Manual GO mode waits for clarification to finish and exposes
  `awaitingGo: true`; only `takt_submit_go` may cross that approval boundary.
  GO commands use raw terminal input rather than bracketed-paste markers.
- Checkpoint recovery uses `takt_resume_run`, not a fresh exec. It drives the
  public resume selection UI through the owned PTY and sends a literal Enter,
  avoiding both task replay and bracketed-paste control sequences in the menu.
- External project processes can be detected from `.takt` metadata, but their
  original PTY is not attachable safely. They use a status card; only
  bridge-owned projects show raw output.
- The background project-stack refresh reads persistent `.takt/runs` metadata
  only. The public `takt list` queue is reconciled on demand by diagnostics and
  explicit task operations, so an invalid queue cannot fail the live widget
  poll or spam Pi notifications. Unexpected repeated refresh failures use one
  warning plus an `xN` status count and reset after recovery.
- Default input mode is `pi`: input is not forwarded implicitly. `/takt:send`
  remains the explicit seam, and `/takt:stop` owns stopping bridge children.
- Optional dual-input modes cycle with a shortcut: `pi` → `takt` (human types
  into the active bridge-owned PTY) → `pi-auto` (Pi may send allowed follow-ups).
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
- A run is not assumed to be singular; the summary is derived from all run
  records in the project when the optional diagnostic overlay is requested.

The bridge does not import TAKT private modules. This keeps the package
compatible with global TAKT installations and makes version drift visible at
the public ACP/CLI boundary.
