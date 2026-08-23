import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { renderTaktTerminal } from "./takt-live-panel.ts";
import { isCtrlAltTSequence, type TaktInputMode } from "./takt-input-mode.ts";

/**
 * One bridge-owned running TAKT session eligible for fullscreen focus.
 * The focused view pins a stable session identity instead of repeatedly
 * resolving an implicit active-session target.
 */
export interface TaktFocusSession {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly terminal?: XtermTerminal;
  readonly inputMode?: TaktInputMode;
  /** True while the underlying PTY process is alive. */
  isRunning(): boolean;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  /** Optional screen-change subscription; returns an unsubscribe function. */
  subscribe?(listener: () => void): () => void;
}

export type TaktFocusExitReason =
  | "user-escape"
  | "runner-ended"
  | "external-close";

export interface TaktFocusExitResult {
  reason: TaktFocusExitReason;
  session: TaktFocusSession | undefined;
}

export interface TaktFocusViewCallbacks {
  /** Invoked exactly once when the view closes for any reason. */
  onExit(result: TaktFocusExitResult): void;
  /** Ctrl+Alt+T was pressed; the runtime owns mode cycling. */
  onModeCycle(): void;
  notify(message: string, level?: "info" | "warning"): void;
  requestRender(): void;
}

export interface TaktFocusViewOptions {
  sessions: readonly TaktFocusSession[];
  /** Session to highlight first in selection (usually the current cwd). */
  initialSessionId?: string;
  callbacks: TaktFocusViewCallbacks;
  refreshIntervalMs?: number;
}

export type TaktFocusPhase = "select" | "pinned" | "closed";

const DEFAULT_REFRESH_MS = 100;

/**
 * Deterministic ordering shared by the session selector, navigation
 * shortcuts, and the command fallback so every path cycles identically.
 */
export function orderTaktFocusSessions<T extends { readonly id: string; readonly label: string; readonly cwd: string }>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort((left, right) =>
    left.label.localeCompare(right.label) ||
    left.cwd.localeCompare(right.cwd) ||
    left.id.localeCompare(right.id)
  );
}

/** Raw legacy encodings for Ctrl+Alt+Up/Down (`;7` modifier byte). */
export function isCtrlAltArrowSequence(data: string, direction: "up" | "down"): boolean {
  const finalByte = direction === "up" ? "A" : "B";
  if (data === `\u001b[1;7${finalByte}`) {
    return true;
  }
  return matchesKey(data, Key.ctrlAlt(direction));
}

/**
 * Fullscreen pinned-session interaction controller.
 *
 * Owns human terminal input exclusively while takt mode is active:
 * reserved control sequences are consumed here and never forwarded, and
 * every other byte reaches only the pinned runner. Lifecycle cleanup
 * (subscriptions, refresh timer, exit callback) is idempotent so repeated
 * close calls, runner exits, and external closes can race safely.
 *
 * This is the single high-level behavioral test seam for focus entry,
 * forwarding, switching, rendering, and teardown.
 */
export class TaktFullscreenFocusView {
  private phase: TaktFocusPhase;
  private selectCursor = 0;
  private pinnedSession: TaktFocusSession | undefined;
  private readonly sessions: TaktFocusSession[];
  private readonly callbacks: TaktFocusViewCallbacks;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private lastColumns = 0;
  private lastBodyRows = 0;
  private exitFired = false;
  private readonly initialHighlightId: string | undefined;

  constructor(options: TaktFocusViewOptions) {
    this.sessions = orderTaktFocusSessions(options.sessions);
    this.initialHighlightId = options.initialSessionId;
    if (this.sessions.length === 0) {
      throw new Error("TAKT focus requires at least one eligible running session");
    }
    this.callbacks = options.callbacks;

    const initialIndex = Math.max(0, this.sessions.findIndex(
      (session) => session.id === options.initialSessionId,
    ));
    this.selectCursor = initialIndex;
    // One eligible running session pins automatically; several require an
    // explicit Enter before any human input may reach a PTY.
    this.phase = this.sessions.length === 1 ? "pinned" : "select";
    if (this.phase === "pinned") {
      this.pinSession(this.sessions[initialIndex] ?? this.sessions[0]);
    }

    for (const session of this.sessions) {
      this.unsubscribes.push(session.subscribe?.(() => this.handleRunnerEvent()) ?? (() => {}));
    }    const intervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.refreshTimer = setInterval(() => this.handleTick(), Math.max(20, intervalMs));
    this.refreshTimer.unref?.();
  }

  get currentPhase(): TaktFocusPhase {
    return this.phase;
  }

  get pinnedId(): string | undefined {
    return this.pinnedSession?.id;
  }

  get eligibleSessions(): readonly TaktFocusSession[] {
    return this.sessions.filter((session) => session.isRunning());
  }

  private pinSession(session: TaktFocusSession): void {
    this.pinnedSession = session;
    this.lastColumns = 0;
    this.lastBodyRows = 0;
  }

  private handleRunnerEvent(): void {
    if (this.checkPinnedAlive()) {
      this.callbacks.requestRender();
    }
  }

  private handleTick(): void {
    if (this.phase === "closed") {
      return;
    }
    if (this.phase === "select" && this.eligibleSessions.length === 0) {
      // Every candidate died before the user confirmed a target.
      this.close("runner-ended");
      return;
    }
    if (!this.checkPinnedAlive()) {
      return;
    }
    this.callbacks.requestRender();
  }

  /**
   * Returns false exactly once when the pinned runner stopped; closes the
   * view without ever re-pinning another session.
   */
  private checkPinnedAlive(): boolean {
    if (this.phase === "closed") {
      return false;
    }
    const pinned = this.pinnedSession;
    if (pinned !== undefined && !pinned.isRunning()) {
      this.close("runner-ended");
      return false;
    }
    return true;
  }

  /** Move to the previous/next eligible running session with wraparound. */
  switchTarget(delta: -1 | 1): boolean {
    if (this.phase === "closed") {
      return false;
    }
    this.checkPinnedAlive();
    if (this.phase !== "pinned") {
      return false;
    }
    const eligible = this.eligibleSessions;
    if (eligible.length <= 1) {
      return false;
    }
    // Eligibility is evaluated after liveness checks so stop-during-switch
    // cannot land on a dead session or leave a stale pin behind.
    const currentIndex = eligible.findIndex((session) => session.id === this.pinnedId);
    const nextIndex = ((currentIndex < 0 ? 0 : currentIndex) + delta + eligible.length) % eligible.length;
    const previous = this.pinnedSession;
    const next = eligible[nextIndex];
    if (next === undefined || next.id === previous?.id) {
      return false;
    }
    // Atomic switch: one identity update; renderer and forwarding both read
    // this same field before any further input is accepted.
    this.pinSession(next);
    this.callbacks.notify(`TAKT focus: ${previous?.label ?? "?"} → ${next.label}`, "info");
    this.callbacks.requestRender();
    return true;
  }

  handleInput(data: string): void {
    if (this.phase === "closed") {
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.close("user-escape");
      return;
    }
    if (matchesKey(data, Key.ctrlAlt("t")) || isCtrlAltTSequence(data)) {
      this.callbacks.onModeCycle();
      return;
    }
    if (this.phase === "select") {
      if (matchesKey(data, Key.up)) {
        this.selectCursor = (this.selectCursor - 1 + this.sessions.length) % this.sessions.length;
        this.callbacks.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.selectCursor = (this.selectCursor + 1) % this.sessions.length;
        this.callbacks.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const candidate = this.sessions[this.selectCursor];
        if (candidate?.isRunning()) {
          this.phase = "pinned";
          this.pinSession(candidate);
          this.callbacks.requestRender();
        }
      }
      // Selection swallows everything else; no PTY receives input until a
      // target is explicitly confirmed.
      return;
    }

    // Pinned phase navigation shortcuts — consumed, never forwarded.
    if (isCtrlAltArrowSequence(data, "up")) {
      this.switchTarget(-1);
      return;
    }
    if (isCtrlAltArrowSequence(data, "down")) {
      this.switchTarget(1);
      return;
    }

    this.pinnedSession?.write(data);
  }

  /**
   * Render the focused screen. `totalRows` is the usable terminal height;
   * the output fills it with header + raw viewport + help footer. Width is
   * clamped through the existing ANSI-aware truncation invariant.
   */
  render(width: number, totalRows: number): string[] {
    const columns = Math.max(1, Math.floor(width || 80));
    const rows = Math.max(3, Math.floor(totalRows || 24));
    if (this.phase === "closed") {
      return [];
    }
    if (this.phase === "select") {
      return this.renderSelection(columns, rows);
    }
    return this.renderPinned(columns, rows);
  }

  invalidate(): void {
    // Terminal buffers are read on every render; nothing cached.
  }

  /** Idempotent close used by user escape and runtime-forced shutdown paths. */
  close(reason: TaktFocusExitReason): void {
    if (this.phase === "closed") {
      return;
    }
    this.phase = "closed";
    clearInterval(this.refreshTimer);
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes.length = 0;
    if (!this.exitFired) {
      this.exitFired = true;
      const session = this.pinnedSession;
      this.callbacks.onExit({ reason, session });
      // No stale pin may survive a close; identity lives only in the exit
      // result from here on.
      this.pinnedSession = undefined;
    }
  }

  private renderSelection(columns: number, rows: number): string[] {
    const lines = [
      truncateToWidth("🎭 TAKT · select a running session", columns),
      "",
    ];
    this.sessions.forEach((session, index) => {
      const marker = index === this.selectCursor ? "❯ " : "  ";
      const currentTag = session.id === this.initialHighlightId ? " · current" : "";
      lines.push(truncateToWidth(`${marker}${session.label}${currentTag} · ${session.cwd}`, columns));
    });
    lines.push("");
    lines.push(truncateToWidth("enter focus · ↑/↓ move · esc back", columns));
    return lines.slice(0, rows);
  }

  private renderPinned(columns: number, rows: number): string[] {
    const pinned = this.pinnedSession;
    if (pinned === undefined) {
      return [truncateToWidth("TAKT focus lost its pinned session.", columns)];
    }
    const others = Math.max(0, this.eligibleSessions.length - 1);
    const header = truncateToWidth(
      `🎭 TAKT · ${pinned.label} · ${pinned.cwd}`
        + ` · input: ${pinned.inputMode ?? "takt"}`
        + ` · +${others} other${others === 1 ? "" : "s"} running`,
      columns,
    );
    const footer = truncateToWidth("esc back to Pi · ctrl+alt+↑/↓ switch session · ctrl+alt+t modes", columns);

    const bodyRows = rows - 2;
    let body: string[];
    if (pinned.terminal) {
      body = renderTaktTerminal(pinned.terminal).slice(-bodyRows);
    } else {
      body = [truncateToWidth("(no raw TAKT screen available)", columns)];
    }

    // Dimension changes propagate to the pinned PTY so TAKT lays out its own
    // TUI against the focused-view size.
    if (columns !== this.lastColumns || bodyRows !== this.lastBodyRows) {
      this.lastColumns = columns;
      this.lastBodyRows = bodyRows;
      pinned.resize(columns, bodyRows);
    }

    return [header, ...body, footer];
  }
}
