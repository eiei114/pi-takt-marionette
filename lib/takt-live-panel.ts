import {
  CURSOR_MARKER,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { Terminal } from "@xterm/headless";
import {
  type TaktExecStage,
} from "./takt-exec-stage.ts";
import {
  formatTaktInputModeLine,
  type TaktInputMode,
} from "./takt-input-mode.ts";
import { workflowLabel } from "./takt-progress.ts";
import { t, taktLang } from "./takt-i18n.ts";
import {
  hasTaktSummaryActivity,
  type TaktRunSnapshot,
  type TaktSummary,
} from "./takt-types.ts";

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 30;
const MAX_WIDGET_ROWS = 10;
const MAX_STACK_ROWS = 30;
const LIVE_WIDGET_REFRESH_INTERVAL_MS = 100;
const SPINNER_INTERVAL_MS = 120;

/** Braille spinner shown on actively operated sessions; still means alive. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function taktSpinnerFrame(nowMs: number, intervalMs = SPINNER_INTERVAL_MS): string {
  const safeNow = Number.isFinite(nowMs) ? Math.max(0, nowMs) : 0;
  const safeInterval = Math.max(40, intervalMs);
  return SPINNER_FRAMES[Math.floor(safeNow / safeInterval) % SPINNER_FRAMES.length];
}

const HEARTBEAT_FRESH_MS = 10_000;
const HEARTBEAT_STALLED_MS = 30_000;

/**
 * Heartbeat tiers: fresh TAKT writes spin fast, a quiet stretch slows the
 * rotation, and a long silent gap flags the session as possibly stuck.
 */
export function heartbeat(
  run: Pick<TaktRunSnapshot, "updatedAt"> | undefined,
  runnerLastOutputAt: number | undefined,
  nowMs: number,
): { intervalMs: number; stalled: boolean } {
  const candidates = [runnerLastOutputAt, run?.updatedAt !== undefined ? Date.parse(run.updatedAt) : undefined]
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const activityAt = Math.max(...candidates, Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(activityAt)) {
    return { intervalMs: SPINNER_INTERVAL_MS, stalled: false };
  }
  const age = Math.max(0, nowMs - activityAt);
  if (age >= HEARTBEAT_STALLED_MS) {
    return { intervalMs: 480, stalled: true };
  }
  if (age >= HEARTBEAT_FRESH_MS) {
    return { intervalMs: 240, stalled: false };
  }
  return { intervalMs: SPINNER_INTERVAL_MS, stalled: false };
}

/** Live elapsed clock for an actively operated run, e.g. `⏱04:32`. */
export function formatElapsed(startIso: string | undefined, nowMs: number): string {
  if (startIso === undefined) {
    return "";
  }
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) {
    return "";
  }
  let totalSeconds = Math.max(0, Math.floor((nowMs - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  totalSeconds -= hours * 3600;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const mm = String(minutes).padStart(2, "0");
  const body = `${mm}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `⏱ ${hours}:${body}` : `⏱ ${body}`;
}

export interface TaktLiveRunner {
  readonly terminal: Terminal | undefined;
  readonly hasSession: boolean;
  readonly isRunning: boolean;
  /** Timestamp of the most recent PTY output; drives the heartbeat spinner. */
  readonly lastOutputAt?: number;
  resize(columns: number, rows: number): void;
  subscribe(listener: () => void): () => void;
}

export interface TaktProjectWidgetEntry {
  id: string;
  label: string;
  cwd: string;
  isCurrent?: boolean;
  runner?: TaktLiveRunner;
  summary?: TaktSummary;
  stage?: TaktExecStage;
  promptPreview?: string;
  /** Lines buffered because the session was mid-execution when they were typed. */
  queueDepth?: number;
}

export interface TaktProjectStackSource {
  getProjects(): readonly TaktProjectWidgetEntry[];
  getInputMode?(): TaktInputMode;
  subscribe(listener: () => void): () => void;
}

export interface TaktProjectStackRenderOptions {
  now?: number;
}

/** Create a non-capturing widget that keeps normal Pi visible and focused. */
export function createTaktLiveWidget(
  runner: TaktLiveRunner,
  tui: { requestRender(): void },
): Component & { dispose(): void } {
  return new TaktLiveTerminalWidget(runner, tui);
}

/** Create one stacked widget for all registered TAKT project folders. */
export function createTaktProjectStackWidget(
  source: TaktProjectStackSource,
  tui: { requestRender(): void },
): Component & { dispose(): void } {
  return new TaktProjectStackWidget(source, tui);
}

class TaktLiveTerminalWidget implements Component {
  private readonly runner: TaktLiveRunner;
  private readonly tui: { requestRender(): void };
  private readonly unsubscribe: () => void;
  private lastWidth = 0;
  private lastRows = 0;

  constructor(
    runner: TaktLiveRunner,
    tui: { requestRender(): void },
  ) {
    this.runner = runner;
    this.tui = tui;
    this.unsubscribe = runner.subscribe(() => {
      this.invalidate();
      this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    const rows = terminalRows();
    const columns = Math.max(1, Math.floor(width || DEFAULT_COLUMNS));
    if (columns !== this.lastWidth || rows !== this.lastRows) {
      this.lastWidth = columns;
      this.lastRows = rows;
      this.runner.resize(columns, rows);
    }

    const terminal = this.runner.terminal;
    if (!terminal) {
      return fitTaktWidgetLines(["TAKT terminal is not available."], columns);
    }
    const lines = renderTaktTerminal(terminal);
    return fitTaktWidgetLines(visibleWidgetLines(lines), columns);
  }

  invalidate(): void {
    // The terminal buffer is read directly on every render. This method exists
    // to satisfy Component and to document that cached output is not used.
  }

  dispose(): void {
    this.unsubscribe();
  }
}

class TaktProjectStackWidget implements Component {
  private readonly source: TaktProjectStackSource;
  private readonly tui: { requestRender(): void };
  private readonly unsubscribe: () => void;
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(
    source: TaktProjectStackSource,
    tui: { requestRender(): void },
  ) {
    this.source = source;
    this.tui = tui;
    this.unsubscribe = source.subscribe(() => {
      this.invalidate();
      this.tui.requestRender();
    });
    // PTY output can arrive while the terminal parser is still settling, and
    // some TAKT screens update in place without producing a source-level state
    // change. Keep the mounted live screen fresh even when that event is
    // coalesced or missed by the host UI.
    this.refreshTimer = setInterval(() => {
      if (!this.source.getProjects().some((project) => project.runner?.isRunning && project.runner.terminal)) {
        return;
      }
      this.invalidate();
      this.tui.requestRender();
    }, LIVE_WIDGET_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  render(width: number): string[] {
    return renderTaktProjectStack(
      this.source.getProjects(),
      normalizeWidgetWidth(width),
      this.source.getInputMode?.() ?? "pi",
    );
  }

  invalidate(): void {
    // Projects and terminal buffers are read directly on every render.
  }

  dispose(): void {
    this.unsubscribe();
    clearInterval(this.refreshTimer);
  }
}

export function renderTaktProjectStack(
  projects: readonly TaktProjectWidgetEntry[],
  width: number,
  inputMode: TaktInputMode = "pi",
  options: TaktProjectStackRenderOptions = {},
): string[] {
  const columns = normalizeWidgetWidth(width);
  const now = options.now ?? Date.now();
  // The live widget is a session-owned view: only projects whose TAKT process
  // was launched from THIS Pi session render here. External activity stays
  // available through explicit diagnostics (/takt:status, /takt:sessions,
  // takt_read_screen).
  const displayableProjects = [...projects]
    .filter(hasOwnedRunner)
    .filter((project) => isDisplayableProject(project, now))
    .sort(compareProjectActivity);
  const currentIsPreparing = displayableProjects.some(isPreparingProject);
  const visibleProjects = currentIsPreparing
    ? displayableProjects.filter((project) => project.isCurrent)
    : displayableProjects;

  if (visibleProjects.length === 0) {
    return fitTaktWidgetLines([
      `input: ${formatTaktInputModeLine(inputMode)}`,
      t("noActiveSessions"),
    ], columns);
  }

  const lines: string[] = [
    `input: ${formatTaktInputModeLine(inputMode)}`,
    headerLine(visibleProjects),
  ];
  for (const project of visibleProjects) {
    if (lines.length >= MAX_STACK_ROWS - 1 && visibleProjects.indexOf(project) < visibleProjects.length - 1) {
      lines.push(`… ${visibleProjects.length - visibleProjects.indexOf(project)} more`);
      break;
    }
    lines.push(sessionRow(project, columns, now));
  }
  return fitTaktWidgetLines(lines, columns);
}

/**
 * Buffer row that the visible viewport starts at. Normal buffers use the
 * current viewport (xterm keeps it pinned to the bottom page while output
 * streams), alternate buffers always start at their own row zero.
 */
export function taktViewportOrigin(
  buffer: { readonly type: string; readonly viewportY: number; readonly length: number },
  rows: number,
): number {
  if (buffer.type === "alternate") {
    return 0;
  }
  const maxOrigin = Math.max(0, buffer.length - Math.max(1, rows));
  return Math.min(Math.max(0, buffer.viewportY), maxOrigin);
}

/** Localized header: session count plus plain-word running/done detail. */
function headerLine(projects: readonly TaktProjectWidgetEntry[]): string {
  const count = projects.length;
  const plural = taktLang() === "ja" ? "" : count === 1 ? "" : "s";
  return t("headerSessions", { count, plural, detail: summaryCounts(projects) });
}

/** One compact row per session: spinner + status emoji + label + run state. */
export function sessionRow(project: TaktProjectWidgetEntry, width: number, now: number): string {
  void width;
  const run = findActiveRun(project.summary);
  const hb = heartbeat(run, project.runner?.lastOutputAt, now);
  const spin = taktSpinnerFrame(now, hb.intervalMs);
  // Auto-generated exec workflow names are per-task noise (the elapsed timer
  // already covers timing); hide them. Project-defined names stay visible.
  const rawWorkflow = run !== undefined ? workflowLabel(run) : undefined;
  const workflow = rawWorkflow !== undefined && !EXEC_NAME_PATTERN.test(rawWorkflow)
    ? truncateInline(rawWorkflow, 22)
    : undefined;
  const workflowTag = workflow !== undefined ? ` · ${workflow}` : "";
  // Bridge lifecycle states that precede or wrap the actual TAKT run.
  if (project.stage === "clearing") {
    return `${spin} 🟡 ${project.label}${workflowTag} — ${t("clearingStep")}`;
  }
  if (project.stage === "starting" || isPreparingProject(project)) {
    return `${spin} ⏳ ${project.label}${workflowTag} — ${t("startingStep")}`;
  }
  if (project.stage === "waiting_prompt") {
    return `${spin} ⏳ ${project.label}${workflowTag} — ${t("waitingPromptStep")}`;
  }
  if (project.stage === "pasting") {
    const chars = project.promptPreview?.length ?? 0;
    return `${spin} 📋 ${project.label}${workflowTag} — ${t("pastingPromptStep", { chars })}`;
  }
  if (project.stage === "sending_go") {
    return `${spin} 📨 ${project.label}${workflowTag} — ${t("sendingGoStep")}`;
  }

  const failureText = run?.failure ?? run?.reason;
  if (run?.status === "stale" || run?.sessionStatus === "stale") {
    const detail = failureText ? ` · ${truncateInline(failureText, 40)}` : "";
    return `${spin} ⚠️  ${project.label}${workflowTag} — ${t("staleState")}${detail}`;
  }

  if (run && isActiveRunState(run)) {
    const elapsed = formatElapsed(run.startTime, now);
    const dot = hb.stalled ? "⚠️" : "🟢";
    const queued = project.queueDepth !== undefined && project.queueDepth > 0
      ? ` ⏳q${project.queueDepth}`
      : "";
    return `${spin} ${dot} ${project.label}${workflowTag} ${describeActiveRun(run)}${queued}${elapsed ? ` · ${elapsed}` : ""}`;
  }

  if (project.stage === "failed") {
    const detail = failureText ? ` · ${truncateInline(failureText, 44)}` : "";
    return `🔴 ${project.label}${workflowTag} ❌ ${t("failedState")}${detail}`;
  }

  // Running without run metadata yet (or right after a lifecycle transition).
  if (project.runner?.isRunning) {
    return `${spin} 🟢 ${project.label}${workflowTag} — ${t("workingState")}`;
  }

  const finishedRun = project.summary?.runs.find((candidate) => candidate.status === "completed");
  const duration = finishedRun?.startTime && finishedRun?.endTime
    ? formatDuration(Date.parse(finishedRun.startTime), Date.parse(finishedRun.endTime))
    : undefined;
  return `✅ ${project.label}${workflowTag} — ${t("doneState")}${duration ? ` · ${duration}` : ""}`;
}

export function describeActiveRun(run: TaktRunSnapshot): string {
  const steps = run.workflowSteps?.filter((step) => step.length > 0) ?? [];
  const currentIndex = run.currentStep ? steps.indexOf(run.currentStep) : -1;
  const position = currentIndex >= 0 ? ` ${currentIndex + 1}/${steps.length}` : "";
  const workerSuffix = run.workers && run.workers.total > 0
    ? ` w${run.workers.done}/${run.workers.total}`
    : "";
  const stepName = run.currentStep ?? "working";
  return `🔨 ${stepName}${position}${workerSuffix}`;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(1, maxLength - 1))}…` : normalized;
}

function formatDuration(startMs: number, endMs: number): string {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return "";
  }
  const totalSeconds = Math.round((endMs - startMs) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ""}`;
}

function isActiveRunState(run: Pick<TaktRunSnapshot, "status" | "sessionStatus">): boolean {
  return run.status === "running" || run.sessionStatus === "live";
}

function isDisplayableProject(project: TaktProjectWidgetEntry, now: number): boolean {
  if (isTerminalProjectStage(project.stage)) {
    return false;
  }
  return Boolean(
    project.runner?.isRunning ||
    (!project.runner?.hasSession && project.stage !== undefined && project.stage !== "idle"),
  );
}

/** True when this Pi session owns the TAKT process behind the entry. */
function hasOwnedRunner(project: TaktProjectWidgetEntry): boolean {
  return Boolean(project.runner?.hasSession || project.runner?.isRunning);
}

function isTerminalProjectStage(stage: TaktExecStage | undefined): boolean {
  return stage === "stopped" || stage === "completed" || stage === "failed";
}

/** Keep custom widget output inside Pi's terminal-width invariant. */
export function fitTaktWidgetLines(lines: readonly string[], width: number): string[] {
  const columns = normalizeWidgetWidth(width);
  return lines.map((line) => truncateToWidth(line, columns));
}

const EXEC_NAME_PATTERN = /^exec-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/;

/** `exec-20260822-051544-…` → `exec@05:15`; other names pass through capped. */
/** Plain-words running/done counts for the header line. */
function summaryCounts(projects: readonly TaktProjectWidgetEntry[]): string {
  let running = 0;
  let done = 0;
  for (const project of projects) {
    if (isPreparingProject(project)) continue;
    const run = findActiveRun(project.summary);
    if (run !== undefined && isActiveRunState(run)) running += 1;
    else done += 1;
  }
  const parts: string[] = [];
  if (running > 0) parts.push(t("runningCount", { n: running }));
  if (done > 0) parts.push(t("doneCount", { n: done }));
  return parts.length > 0 ? parts.join(" · ") : t("startingCount");
}

function isPreparingProject(project: TaktProjectWidgetEntry): boolean {
  return Boolean(project.isCurrent && project.runner?.isRunning && !hasTaktSummaryActivity(project.summary));
}

function findActiveRun(summary: TaktSummary | undefined): TaktRunSnapshot | undefined {
  return summary?.runs.find((run) =>
    run.status === "running" || run.status === "stale" ||
    run.sessionStatus === "live" || run.sessionStatus === "stale",
  );
}

function compareProjectActivity(left: TaktProjectWidgetEntry, right: TaktProjectWidgetEntry): number {
  return projectActivityScore(right) - projectActivityScore(left) || left.label.localeCompare(right.label);
}

function projectActivityScore(project: TaktProjectWidgetEntry): number {
  if (project.runner?.isRunning) return 4;
  if (project.summary?.running) return 2;
  if (project.summary && hasTaktSummaryActivity(project.summary)) return 1;
  return 0;
}

export function renderTaktTerminal(terminal: Terminal, options: { showCursor?: boolean } = {}): string[] {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  // Normal buffers keep scrollback above the live viewport: rendering absolute
  // row zero would draw stale top-of-scrollback lines instead of the latest
  // reply. Start at the current viewport origin instead. Alternate screens
  // have no scrollback and keep their absolute screen origin.
  const origin = taktViewportOrigin(buffer, terminal.rows);
  const cursorRow = options.showCursor ? buffer.baseY + buffer.cursorY - origin : -1;
  const cursorColumn = options.showCursor ? buffer.cursorX : -1;

  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(origin + row);
    const rendered = renderLine(
      line as unknown as TerminalLine | undefined,
      terminal.cols,
      row === cursorRow ? cursorColumn : -1,
    );
    lines.push(truncateToWidth(rendered, Math.max(1, terminal.cols)));
  }
  return lines;
}

export function visibleWidgetLines(lines: string[], maxRows = MAX_WIDGET_ROWS): string[] {
  const lastContent = lines.reduce((last, line, index) => (stripTerminalSequences(line).trim() ? index : last), -1);
  if (lastContent < 0) {
    return lines.slice(0, maxRows);
  }
  const start = Math.max(0, lastContent - maxRows + 1);
  return lines.slice(start, Math.min(lines.length, start + maxRows));
}

function stripTerminalSequences(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

interface TerminalLine {
  getCell(column: number): TerminalCell | undefined;
}

function renderLine(line: TerminalLine | undefined, columns: number, cursorColumn: number): string {
  if (!line) {
    return `${" ".repeat(columns)}${cursorColumn >= 0 ? CURSOR_MARKER : ""}`;
  }

  let output = "";
  let previousStyle = "";
  for (let column = 0; column < columns; column += 1) {
    if (column === cursorColumn) {
      output += CURSOR_MARKER;
    }

    const current = line.getCell(column) ?? createBlankCell();
    const style = cellStyle(current);
    if (style !== previousStyle) {
      output += style ? `\u001b[${style}m` : "\u001b[0m";
      previousStyle = style;
    }

    const chars = current.getChars();
    output += chars || (current.getWidth() === 0 ? "" : " ");
  }

  if (cursorColumn >= columns) {
    output += CURSOR_MARKER;
  }
  if (previousStyle) {
    output += "\u001b[0m";
  }
  return output;
}

interface TerminalCell {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
}

function createBlankCell(): TerminalCell {
  return {
    getChars: () => "",
    getWidth: () => 1,
    getFgColor: () => 0,
    getBgColor: () => 0,
    isFgRGB: () => false,
    isBgRGB: () => false,
    isFgPalette: () => false,
    isBgPalette: () => false,
    isBold: () => 0,
    isDim: () => 0,
    isItalic: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isOverline: () => 0,
  };
}

function cellStyle(cell: TerminalCell): string {
  const codes: string[] = [];
  if (cell.isBold()) codes.push("1");
  if (cell.isDim()) codes.push("2");
  if (cell.isItalic()) codes.push("3");
  if (cell.isUnderline()) codes.push("4");
  if (cell.isBlink()) codes.push("5");
  if (cell.isInverse()) codes.push("7");
  if (cell.isInvisible()) codes.push("8");
  if (cell.isStrikethrough()) codes.push("9");
  if (cell.isOverline()) codes.push("53");
  if (cell.isFgPalette()) codes.push(`38;5;${cell.getFgColor()}`);
  else if (cell.isFgRGB()) codes.push(`38;2;${rgbRed(cell.getFgColor())};${rgbGreen(cell.getFgColor())};${rgbBlue(cell.getFgColor())}`);
  if (cell.isBgPalette()) codes.push(`48;5;${cell.getBgColor()}`);
  else if (cell.isBgRGB()) codes.push(`48;2;${rgbRed(cell.getBgColor())};${rgbGreen(cell.getBgColor())};${rgbBlue(cell.getBgColor())}`);
  return codes.join(";");
}

function rgbRed(color: number): number {
  return (color >> 16) & 0xff;
}

function rgbGreen(color: number): number {
  return (color >> 8) & 0xff;
}

function rgbBlue(color: number): number {
  return color & 0xff;
}

function terminalRows(): number {
  const rows = process.stdout.rows;
  return Math.max(4, Number.isInteger(rows) && rows > 0 ? rows : DEFAULT_ROWS);
}

function normalizeWidgetWidth(width: number): number {
  return Math.max(1, Math.floor(width || DEFAULT_COLUMNS));
}
