# Roadmap

Released behavior is documented in [`CHANGELOG.md`](CHANGELOG.md) and the
[`docs/`](docs) guides. This file tracks shipped scope and what is left.

## Shipped (through 0.7.0)

- Direct, lock-protected enqueue: `.takt/tasks.yaml` plus per-task `order.md`,
  with the persisted `workflow`, `worktree`, `auto_pr`, and `draft_pr` fields
  verified before a task counts as queued
- Public `takt run` / `takt exec` / `takt resume` execution inside a detached
  PTY broker with raw-screen replay across Pi `/reload`
- Session-owned stacked live widget with width-aware name elision, heartbeat
  spinner, elapsed clock, retained run outcomes, and three-day history filtering
- Actionable workflow catalog (project > user-global > builtin) with explicit
  per-task workflow selection
- Exact builtin or project workflow execution (`takt_run_workflow`) with native
  `--pr` review context, provider/model routing, and per-run temporary Pi
  extensions
- Queue auto-continue: a successful bridge-owned `takt run` drains remaining
  pending tasks without a manual `takt_run_pending` between tasks
- Killed-run recovery without metadata surgery: explicit ownership, the
  `forceObserved` stop, and TAKT's own startup reconciliation
- Dual input modes (`pi` → `takt` → `pi-auto`) with a platform keyboard
  adapter, macOS `spawn-helper` repair, and required Pi model-route preflight
- Diagnostic overlay with bounded NDJSON log details and an ASCII workflow
  progress line

## Next

- PTY resize, mouse/scrollback, and alternate-screen polish
- Linked NDJSON detail view reached from the diagnostic overlay, beyond the
  compact `log details` line
- Safe raw-output capture/attach protocol for TAKT sessions started outside
  Marionette

## Later

- Structured live-execution updates from TAKT instead of screen state alone, if
  TAKT exposes a non-PTY surface for them
- Richer cross-project history views that keep the session-owned execution
  boundary intact
