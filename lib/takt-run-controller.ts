import xterm from "@xterm/headless";
import { spawn as spawnPty, type IPty } from "node-pty";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { killUnixProcessGroup, killWindowsProcessTree } from "./process-control.ts";
import { resolveCommand } from "./takt-state.ts";
import type { TaktLastExit, TaktSessionStatus } from "./takt-types.ts";

const { Terminal } = xterm;
const STOP_GRACE_MS = 1_500;

type InterruptPty = (pty: IPty) => void;
type ForceKillPty = (pty: IPty) => Promise<void>;

export interface TaktExitResult extends TaktLastExit {
  code: number;
  signal: number | undefined;
}

export interface TaktRunControllerSnapshot {
  status: TaktSessionStatus;
  pid?: number;
  lastExit?: TaktExitResult;
  hasSession: boolean;
}

export interface TaktRunControllerOptions {
  cwd: string;
  command?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  onScreenChange?: () => void;
  onExit?: (result: TaktExitResult) => void;
  interrupt?: InterruptPty;
  forceKill?: ForceKillPty;
}

/**
 * Encode one multiline value as a terminal bracketed paste followed by Enter.
 * TAKT's interactive editor keeps the pasted newlines as one input instead of
 * treating each line as an immediate command.
 */
export function formatTaktPastedInput(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return `\u001b[200~${normalized}\u001b[201~\r`;
}

/**
 * Check the parsed terminal buffer rather than the PTY's process state. TAKT
 * can be alive while its interactive editor is still starting up, so callers
 * that paste input need a way to wait for the actual prompt.
 */
export function terminalContainsText(terminal: XtermTerminal | undefined, text: string): boolean {
  if (!terminal || !text) {
    return false;
  }

  const buffer = terminal.buffer.active;
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row)?.translateToString(true);
    if (line?.includes(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Return the first buffer line containing the text, or undefined when absent.
 * Like {@link terminalContainsText}, this reads the parsed terminal buffer
 * rather than the PTY process state.
 */
export function terminalLineContaining(
  terminal: XtermTerminal | undefined,
  text: string,
): string | undefined {
  if (!terminal || !text) {
    return undefined;
  }
  const buffer = terminal.buffer.active;
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row)?.translateToString(true);
    if (line?.includes(text)) {
      return line;
    }
  }
  return undefined;
}

/**
 * Check the last non-empty buffer line. Scrollback still contains the previous
 * prompt, so a contains-anywhere check must not satisfy post-submit readiness.
 */
export function terminalEndsWithText(terminal: XtermTerminal | undefined, text: string): boolean {
  if (!terminal || !text) {
    return false;
  }

  const buffer = terminal.buffer.active;
  for (let row = buffer.length - 1; row >= 0; row -= 1) {
    const line = buffer.getLine(row)?.translateToString(true).trimEnd();
    if (!line) {
      continue;
    }
    return line.trim() === text;
  }
  return false;
}

/**
 * Runs TAKT in a real pseudo-terminal and keeps an xterm-compatible screen
 * buffer. A pipe is not enough here: TAKT changes its output and input
 * behavior when stdout/stdin are TTYs.
 */
export class TaktRunController {
  private pty: IPty | undefined;
  private lastPty: IPty | undefined;
  private terminalInstance: XtermTerminal | undefined;
  private exitPromise: Promise<TaktExitResult> | undefined;
  private resolveExit: ((result: TaktExitResult) => void) | undefined;
  private lastExitResult: TaktExitResult | undefined;
  private lastPid: number | undefined;
  private outputVersion = 0;
  private lastOutputAtValue: number | undefined;
  private sessionStatus: TaktSessionStatus = "unknown";
  private readonly options: TaktRunControllerOptions;
  private readonly interrupt: InterruptPty;
  private readonly forceKill: ForceKillPty;
  private readonly screenListeners = new Set<() => void>();

  constructor(options: TaktRunControllerOptions) {
    this.options = options;
    this.interrupt = options.interrupt !== undefined ? options.interrupt : interruptPty;
    this.forceKill = options.forceKill !== undefined ? options.forceKill : forceKillPty;
  }

  get isRunning(): boolean {
    return this.pty !== undefined;
  }

  get hasSession(): boolean {
    return this.terminalInstance !== undefined;
  }

  get terminal(): XtermTerminal | undefined {
    return this.terminalInstance;
  }

  get status(): TaktSessionStatus {
    return this.sessionStatus;
  }

  get pid(): number | undefined {
    return this.pty?.pid ?? this.lastPid;
  }

  get lastExit(): TaktExitResult | undefined {
    return this.lastExitResult;
  }

  get screenVersion(): number {
    return this.outputVersion;
  }

  /** Timestamp of the most recent PTY output; the heartbeat signal for liveness. */
  get lastOutputAt(): number | undefined {
    return this.lastOutputAtValue;
  }

  subscribe(listener: () => void): () => void {
    this.screenListeners.add(listener);
    return () => this.screenListeners.delete(listener);
  }

  reconcile(): TaktRunControllerSnapshot {
    if (this.pty && this.sessionStatus !== "stale") {
      this.sessionStatus = "live";
    } else if (this.lastExitResult) {
      this.sessionStatus = "completed";
    } else if (!this.terminalInstance) {
      this.sessionStatus = "unknown";
    }
    return this.snapshot();
  }

  async start(args = this.options.args ?? ["run"]): Promise<void> {
    this.reconcile();
    if (this.isRunning) {
      throw new Error("TAKT process is already running; stop it before starting a fresh process");
    }
    if (this.hasSession) {
      throw new Error("TAKT session must be disposed before starting a fresh process");
    }

    const cols = this.options.cols ?? 120;
    const rows = this.options.rows ?? 30;
    const terminal = new Terminal({
      cols,
      rows,
      scrollback: 2_000,
      convertEol: false,
      allowProposedApi: true,
    });
    const command = resolveCommand(this.options.command);
    const ptyCommand = createPtyCommand(command, args);

    let pty: IPty;
    try {
      pty = spawnPty(ptyCommand.file, ptyCommand.args, {
        cwd: this.options.cwd,
        cols,
        rows,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color",
          FORCE_COLOR: "1",
        },
        ...(process.platform !== "win32" ? { encoding: "utf8" } : {}),
        // winpty is more reliable than ConPTY for a nested Windows terminal
        // and still provides the TTY semantics TAKT needs.
        ...(process.platform === "win32" ? { useConpty: false } : {}),
      });
    } catch (error) {
      terminal.dispose();
      throw error;
    }

    this.terminalInstance = terminal;
    this.pty = pty;
    this.lastPty = pty;
    this.lastPid = pty.pid;
    this.lastExitResult = undefined;
    this.sessionStatus = "live";
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    pty.onData((data) => {
      terminal.write(data, () => {
        this.outputVersion += 1;
        this.lastOutputAtValue = Date.now();
        this.notifyScreenChange();
      });
    });
    pty.onExit(({ exitCode, signal }) => {
      const result: TaktExitResult = { code: exitCode, signal };
      const isCurrent = this.pty === pty;
      if (isCurrent) {
        this.pty = undefined;
        this.lastPty = undefined;
        this.lastExitResult = result;
        this.sessionStatus = "completed";
        disposePty(pty);
        this.resolveExit?.(result);
        this.resolveExit = undefined;
        this.notifyScreenChange();
        this.options.onExit?.(result);
        return;
      }
      disposePty(pty);
    });
  }

  write(data: string): void {
    if (!data || !this.pty) {
      return;
    }
    this.pty.write(data);
  }

  async waitForExit(timeoutMs?: number): Promise<TaktExitResult | undefined> {
    if (!this.exitPromise) {
      return this.lastExitResult;
    }
    if (timeoutMs === undefined) {
      return this.exitPromise;
    }
    if (await settles(this.exitPromise, timeoutMs)) {
      return this.exitPromise;
    }
    throw new Error(`TAKT process did not exit within ${timeoutMs / 1_000} seconds`);
  }

  private notifyScreenChange(): void {
    this.options.onScreenChange?.();
    for (const listener of this.screenListeners) {
      listener();
    }
  }

  resize(cols: number, rows: number): void {
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    if (this.terminalInstance && (this.terminalInstance.cols !== safeCols || this.terminalInstance.rows !== safeRows)) {
      this.terminalInstance.resize(safeCols, safeRows);
    }
    try {
      this.pty?.resize(safeCols, safeRows);
    } catch {
      // The process may have exited between render and resize.
    }
  }

  async stop(): Promise<void> {
    this.reconcile();
    const pty = this.pty;
    const exitPromise = this.exitPromise;
    if (!pty || !exitPromise) {
      return;
    }

    try {
      // Writing Ctrl-C follows the same path as pressing Ctrl-C in the
      // terminal and works for both Windows winpty and Unix PTYs.
      this.interrupt(pty);
    } catch {
      // Fall through to the process-tree fallback below.
    }

    if (await settles(exitPromise, STOP_GRACE_MS)) {
      return;
    }

    let forceKillError: unknown;
    if (this.pty === pty) {
      try {
        await this.forceKill(pty);
      } catch (error) {
        forceKillError = error;
      }
    }
    if (await settles(exitPromise, STOP_GRACE_MS)) {
      return;
    }

    this.sessionStatus = "stale";
    const detail = forceKillError ? `: ${errorMessage(forceKillError)}` : "";
    throw new Error(`TAKT process did not stop within ${STOP_GRACE_MS * 2 / 1_000} seconds${detail}`);
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.pty) {
      this.sessionStatus = "stale";
      throw new Error("TAKT process is still running; refusing to dispose its active PTY");
    }
    if (this.lastPty) {
      disposePty(this.lastPty);
    }
    this.lastPty = undefined;
    this.terminalInstance?.dispose();
    this.terminalInstance = undefined;
    this.exitPromise = undefined;
    this.resolveExit = undefined;
    this.sessionStatus = this.lastExitResult ? "completed" : "unknown";
  }

  private snapshot(): TaktRunControllerSnapshot {
    return {
      status: this.sessionStatus,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      ...(this.lastExitResult ? { lastExit: this.lastExitResult } : {}),
      hasSession: this.hasSession,
    };
  }
}

function interruptPty(pty: IPty): void {
  pty.write("\u0003");
}

async function forceKillPty(pty: IPty): Promise<void> {
  if (process.platform === "win32") {
    await killWindowsProcessTree(pty.pid);
    return;
  }
  if (!killUnixProcessGroup(pty.pid, "SIGKILL")) {
    pty.kill("SIGKILL");
  }
}

function createPtyCommand(command: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    const commandLine = [command, ...args].map(quoteWindowsArg).join(" ");
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
    };
  }
  return { file: command, args };
}

function quoteWindowsArg(value: string): string {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

async function settles<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(true),
      () => finish(false),
    );
  });
}

function disposePty(pty: IPty): void {
  try {
    const destroyable = pty as IPty & { destroy?: () => void };
    if (destroyable.destroy) {
      destroyable.destroy();
    } else {
      pty.kill();
    }
  } catch {
    try {
      pty.kill();
    } catch {
      // Best effort cleanup for PTY handles after the child has exited.
    }
  }

  if (process.platform === "win32") {
    // node-pty's winpty path does not always dispose its conout worker when a
    // process exits naturally. Close that internal worker/socket so a short
    // `takt clear` or `takt exec` does not keep the Pi process alive.
    const internal = pty as unknown as {
      _agent?: { _conoutSocketWorker?: { dispose(): void } };
      _socket?: { destroy(): void };
    };
    try {
      internal._agent?._conoutSocketWorker?.dispose();
      internal._socket?.destroy();
    } catch {
      // Best effort cleanup; the public PTY lifecycle remains authoritative.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
