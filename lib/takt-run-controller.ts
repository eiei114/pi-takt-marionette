import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { resolveCommand } from "./takt-state.ts";
import type { TaktLastExit, TaktSessionStatus } from "./takt-types.ts";

const { Terminal } = xterm;
const BROKER_CONNECT_TIMEOUT_MS = 4_000;
const BROKER_REQUEST_TIMEOUT_MS = 10_000;

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
  /** @deprecated Broker-owned runs no longer expose the node-pty handle. */
  interrupt?: unknown;
  /** @deprecated Broker-owned runs no longer expose the node-pty handle. */
  forceKill?: unknown;
}

interface BrokerState {
  status: TaktSessionStatus;
  pid?: number;
  lastExit?: TaktExitResult;
  running: boolean;
  hasSession: boolean;
  outputVersion: number;
  lastOutputAt?: number;
  cols: number;
  rows: number;
  sequence: number;
  controlState?: TaktRunControlState;
  transcript?: string;
}

export interface TaktRunControlState {
  stage?: string;
  promptPreview?: string;
  queuedInputs?: Array<{ text: string; queuedAt: string }>;
}

interface BrokerDescriptor {
  version: 1;
  pid: number;
  socketPath: string;
  authToken: string;
}

interface BrokerResponse {
  id?: number;
  ok?: boolean;
  error?: string;
  state?: BrokerState;
  event?: "output" | "exit";
  data?: string;
  outputVersion?: number;
  lastOutputAt?: number;
  result?: TaktExitResult;
  sequence?: number;
}

interface PendingRequest {
  resolve(value: BrokerResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Encode multiline input as one bracketed terminal paste plus Enter. */
export function formatTaktPastedInput(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return `\u001b[200~${normalized}\u001b[201~\r`;
}

export function terminalContainsText(terminal: XtermTerminal | undefined, text: string): boolean {
  if (!terminal || !text) return false;
  const buffer = terminal.buffer.active;
  for (let row = 0; row < buffer.length; row += 1) {
    if (buffer.getLine(row)?.translateToString(true).includes(text)) return true;
  }
  return false;
}

export function terminalEndsWithText(terminal: XtermTerminal | undefined, text: string): boolean {
  if (!terminal || !text) return false;
  const buffer = terminal.buffer.active;
  for (let row = buffer.length - 1; row >= 0; row -= 1) {
    const line = buffer.getLine(row)?.translateToString(true).trimEnd();
    if (line) return line.trim() === text;
  }
  return false;
}

/**
 * Controls a detached PTY broker instead of owning node-pty directly. The
 * broker survives Pi's extension reload; a new controller reconnects and
 * rebuilds its xterm screen by replaying the bounded raw transcript.
 */
export class TaktRunController {
  private socket: Socket | undefined;
  private terminalInstance: XtermTerminal | undefined;
  private connectPromise: Promise<void> | undefined;
  private exitPromise: Promise<TaktExitResult> | undefined;
  private resolveExit: ((result: TaktExitResult) => void) | undefined;
  private lastExitResult: TaktExitResult | undefined;
  private lastPid: number | undefined;
  private running = false;
  private hasBrokerSession = false;
  private outputVersion = 0;
  private lastOutputAtValue: number | undefined;
  private sessionStatus: TaktSessionStatus = "unknown";
  private buffered = "";
  private requestId = 0;
  private brokerDescriptor: BrokerDescriptor | undefined;
  private appliedSequence = 0;
  private attaching = false;
  private queuedAttachEvents: BrokerResponse[] = [];
  private restoredControlState: TaktRunControlState = {};
  private controlSyncPromise: Promise<void> = Promise.resolve();
  private controlSyncError: Error | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly options: TaktRunControllerOptions;
  private readonly screenListeners = new Set<() => void>();

  constructor(options: TaktRunControllerOptions) {
    this.options = options;
  }

  get isRunning(): boolean { return this.running; }
  get hasSession(): boolean { return this.hasBrokerSession || this.terminalInstance !== undefined; }
  get terminal(): XtermTerminal | undefined { return this.terminalInstance; }
  get status(): TaktSessionStatus { return this.sessionStatus; }
  get pid(): number | undefined { return this.lastPid; }
  get lastExit(): TaktExitResult | undefined { return this.lastExitResult; }
  get screenVersion(): number { return this.outputVersion; }
  get lastOutputAt(): number | undefined { return this.lastOutputAtValue; }
  get controlState(): Readonly<TaktRunControlState> { return this.restoredControlState; }

  subscribe(listener: () => void): () => void {
    this.screenListeners.add(listener);
    return () => this.screenListeners.delete(listener);
  }

  /** Connect to an existing broker, or leave the controller empty if none exists. */
  async attach(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    this.attaching = true;
    this.queuedAttachEvents = [];
    try {
      await this.connectToBroker(false);
      const response = await this.request("snapshot");
      if (response.state) await this.applyState(response.state, true);
      this.attaching = false;
      this.drainAttachEvents();
    } catch (error) {
      this.attaching = false;
      this.queuedAttachEvents = [];
      if (!isMissingBrokerError(error)) throw error;
      this.disconnect();
    }
  }

  reconcile(): TaktRunControllerSnapshot {
    if (this.running) this.sessionStatus = "live";
    else if (this.lastExitResult) this.sessionStatus = "completed";
    else if (!this.hasSession) this.sessionStatus = "unknown";
    return this.snapshot();
  }

  async start(
    args = this.options.args ?? ["run"],
    envOverrides: Record<string, string> = {},
  ): Promise<void> {
    await this.ensureBroker();
    await this.refreshSnapshot();
    if (this.isRunning) throw new Error("TAKT process is already running; stop it before starting a fresh process");
    if (this.hasSession) throw new Error("TAKT session must be disposed before starting a fresh process");

    this.resetTerminal(this.options.cols ?? 120, this.options.rows ?? 30);
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    const response = await this.request("start", {
      cwd: this.options.cwd,
      command: resolveCommand(this.options.command),
      args,
      env: envOverrides,
      cols: this.options.cols ?? 120,
      rows: this.options.rows ?? 30,
    });
    if (response.state) await this.applyState(response.state, false);
  }

  write(data: string): void {
    if (!data || !this.running) return;
    this.send({ type: "write", data });
  }

  setControlState(controlState: TaktRunControlState): void {
    this.restoredControlState = structuredClone(controlState);
    if (this.socket && !this.socket.destroyed) {
      const nextState = structuredClone(this.restoredControlState);
      this.controlSyncError = undefined;
      this.controlSyncPromise = this.controlSyncPromise
        .then(async () => {
          await this.request("control", { controlState: nextState });
        })
        .catch((error: unknown) => {
          this.controlSyncError = error instanceof Error ? error : new Error(String(error));
        });
    }
  }

  async waitForExit(timeoutMs?: number): Promise<TaktExitResult | undefined> {
    if (!this.exitPromise) return this.lastExitResult;
    if (timeoutMs === undefined) return this.exitPromise;
    return await withTimeout(this.exitPromise, timeoutMs, `TAKT process did not exit within ${timeoutMs / 1_000} seconds`);
  }

  resize(cols: number, rows: number): void {
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    if (this.terminalInstance && (this.terminalInstance.cols !== safeCols || this.terminalInstance.rows !== safeRows)) {
      this.terminalInstance.resize(safeCols, safeRows);
    }
    if (this.socket && !this.socket.destroyed) this.send({ type: "resize", cols: safeCols, rows: safeRows });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    const response = await this.request("stop", {}, BROKER_REQUEST_TIMEOUT_MS);
    if (response.state) await this.applyState(response.state, true);
  }

  /** Disconnect on /reload while leaving the broker and TAKT process alive. */
  async detach(): Promise<void> {
    await this.controlSyncPromise;
    if (this.controlSyncError) throw this.controlSyncError;
    this.disconnect();
    this.terminalInstance?.dispose();
    this.terminalInstance = undefined;
  }

  /** Stop the run and clear its broker-owned screen for the next execution. */
  async dispose(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      try {
        await this.request("dispose", {}, BROKER_REQUEST_TIMEOUT_MS);
      } finally {
        this.disconnect();
      }
    }
    this.running = false;
    this.hasBrokerSession = false;
    this.terminalInstance?.dispose();
    this.terminalInstance = undefined;
    this.exitPromise = undefined;
    this.resolveExit = undefined;
    this.sessionStatus = this.lastExitResult ? "completed" : "unknown";
  }

  /** Stop the run and terminate its detached broker during real Pi shutdown. */
  async shutdown(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      try {
        await this.request("shutdown", {}, BROKER_REQUEST_TIMEOUT_MS);
      } finally {
        this.disconnect();
      }
    }
    this.running = false;
    this.hasBrokerSession = false;
    this.terminalInstance?.dispose();
    this.terminalInstance = undefined;
  }

  private async refreshSnapshot(): Promise<void> {
    const response = await this.request("snapshot");
    if (response.state) await this.applyState(response.state, true);
  }

  private async ensureBroker(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    try {
      await this.connectToBroker(false);
      return;
    } catch (error) {
      if (!isMissingBrokerError(error)) throw error;
    }

    this.cleanupStaleDescriptor();
    const paths = brokerPaths(this.options.cwd);
    const authToken = randomBytes(32).toString("hex");
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\pi-takt-marionette-${paths.id}-${authToken.slice(0, 12)}`
      : join(paths.directory, `${paths.id.slice(0, 12)}-${authToken.slice(0, 8)}.s`);
    const brokerPath = fileURLToPath(new URL("./takt-run-broker.mjs", import.meta.url));
    const child = spawn(process.execPath, [brokerPath, paths.descriptorPath, socketPath, authToken], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();

    const deadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.connectToBroker(true);
        return;
      } catch (error) {
        lastError = error;
        await delay(50);
      }
    }
    throw new Error(`TAKT PTY broker did not start: ${errorMessage(lastError)}`);
  }

  private async connectToBroker(retrying: boolean): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let descriptor: BrokerDescriptor;
      try {
        descriptor = readBrokerDescriptor(this.options.cwd);
      } catch (error) {
        reject(error);
        return;
      }
      const socket = connect(descriptor.socketPath);
      const onError = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        this.brokerDescriptor = descriptor;
        this.socket = socket;
        this.buffered = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => this.handleData(String(chunk)));
        socket.on("error", (error) => this.handleDisconnect(error));
        socket.on("close", () => this.handleDisconnect());
        resolve();
      });
    });
    try {
      await this.connectPromise;
    } catch (error) {
      if (!retrying) this.disconnect();
      throw error;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private request(type: string, extra: Record<string, unknown> = {}, timeoutMs = BROKER_REQUEST_TIMEOUT_MS): Promise<BrokerResponse> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("TAKT PTY broker is not connected"));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TAKT PTY broker ${type} request timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, type, ...extra });
    });
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    socket.write(`${JSON.stringify({ ...message, token: this.brokerDescriptor?.authToken })}\n`);
  }

  private handleData(chunk: string): void {
    this.buffered += chunk;
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (!line.trim()) continue;
      let message: BrokerResponse;
      try { message = JSON.parse(line) as BrokerResponse; } catch { continue; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok === false) pending.reject(new Error(message.error ?? "TAKT PTY broker request failed"));
        else pending.resolve(message);
      } else if (message.event === "output" && typeof message.data === "string") {
        if (this.attaching) this.queuedAttachEvents.push(message);
        else this.applyEvent(message);
      } else if (message.event === "exit" && message.result) {
        if (this.attaching) this.queuedAttachEvents.push(message);
        else this.applyEvent(message);
      }
    }
  }

  private async applyState(state: BrokerState, replayTranscript: boolean): Promise<void> {
    if (state.sequence < this.appliedSequence) return;
    this.appliedSequence = state.sequence;
    this.running = state.running;
    this.hasBrokerSession = state.hasSession;
    this.sessionStatus = state.status;
    this.lastPid = state.pid;
    this.lastExitResult = state.lastExit;
    this.outputVersion = state.outputVersion;
    this.lastOutputAtValue = state.lastOutputAt;
    this.restoredControlState = structuredClone(state.controlState ?? {});
    if (state.running && !this.exitPromise) {
      this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    }
    if (replayTranscript && state.hasSession) {
      this.resetTerminal(state.cols, state.rows);
      if (state.transcript) await writeTerminal(this.terminalInstance, state.transcript);
      this.notifyScreenChange();
    }
  }

  private resetTerminal(cols: number, rows: number): void {
    this.terminalInstance?.dispose();
    this.terminalInstance = new Terminal({
      cols,
      rows,
      scrollback: 2_000,
      convertEol: false,
      allowProposedApi: true,
    });
  }

  private handleDisconnect(error?: Error): void {
    if (!this.socket) return;
    this.socket = undefined;
    this.brokerDescriptor = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("TAKT PTY broker disconnected"));
      this.pending.delete(id);
    }
  }

  private disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.brokerDescriptor = undefined;
    socket?.removeAllListeners();
    socket?.destroy();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("TAKT PTY broker disconnected"));
      this.pending.delete(id);
    }
  }

  private notifyScreenChange(): void {
    this.options.onScreenChange?.();
    for (const listener of this.screenListeners) listener();
  }

  private applyEvent(message: BrokerResponse): void {
    const sequence = message.sequence ?? this.appliedSequence + 1;
    if (sequence <= this.appliedSequence) return;
    this.appliedSequence = sequence;
    if (message.event === "output" && typeof message.data === "string") {
      this.terminalInstance?.write(message.data, () => {
        this.outputVersion = message.outputVersion ?? this.outputVersion + 1;
        this.lastOutputAtValue = message.lastOutputAt ?? Date.now();
        this.notifyScreenChange();
      });
      return;
    }
    if (message.event === "exit" && message.result) {
      this.running = false;
      this.lastExitResult = message.result;
      this.sessionStatus = "completed";
      this.resolveExit?.(message.result);
      this.resolveExit = undefined;
      this.notifyScreenChange();
      this.options.onExit?.(message.result);
    }
  }

  private drainAttachEvents(): void {
    const events = this.queuedAttachEvents.sort(
      (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
    );
    this.queuedAttachEvents = [];
    for (const event of events) this.applyEvent(event);
  }

  private cleanupStaleDescriptor(): void {
    const paths = brokerPaths(this.options.cwd);
    let descriptor: BrokerDescriptor;
    try {
      descriptor = readBrokerDescriptor(this.options.cwd);
    } catch (error) {
      if (isMissingBrokerError(error)) return;
      throw error;
    }
    if (isProcessAlive(descriptor.pid)) return;
    try { unlinkSync(paths.descriptorPath); } catch { /* another starter won */ }
    if (process.platform !== "win32" && descriptor.socketPath.startsWith(`${paths.directory}/`)) {
      try { unlinkSync(descriptor.socketPath); } catch { /* stale socket already gone */ }
    }
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

function brokerPaths(cwd: string): { id: string; directory: string; descriptorPath: string } {
  const identity = typeof process.getuid === "function"
    ? String(process.getuid())
    : userInfo().username;
  const identityHash = createHash("sha256").update(identity).digest("hex").slice(0, 6);
  // Keep Unix socket paths below macOS's short sockaddr_un limit.
  const directory = join(tmpdir(), `.pm-${identityHash}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const stat = statSync(directory);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`TAKT broker runtime directory is not owned by the current user: ${directory}`);
    }
    chmodSync(directory, 0o700);
  }
  const id = createHash("sha256").update(cwd).digest("hex").slice(0, 20);
  return { id, directory, descriptorPath: join(directory, `${id}.json`) };
}

function readBrokerDescriptor(cwd: string): BrokerDescriptor {
  const { descriptorPath } = brokerPaths(cwd);
  const value = JSON.parse(readFileSync(descriptorPath, "utf8")) as Partial<BrokerDescriptor>;
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    typeof value.socketPath !== "string" ||
    typeof value.authToken !== "string" ||
    value.authToken.length < 32
  ) {
    throw new Error(`Invalid TAKT broker descriptor: ${descriptorPath}`);
  }
  return value as BrokerDescriptor;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeTerminal(terminal: XtermTerminal | undefined, data: string): Promise<void> {
  if (!terminal || !data) return Promise.resolve();
  return new Promise((resolve) => terminal.write(data, resolve));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingBrokerError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EPIPE";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
