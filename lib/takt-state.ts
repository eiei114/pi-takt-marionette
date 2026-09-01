import { existsSync, closeSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnCommand } from "./process-control.ts";
import type {
  TaktLastExit,
  TaktRunLogDiagnostics,
  TaktRunMeta,
  TaktRunSnapshot,
  TaktSessionStatus,
  TaktSummary,
  TaktTaskItem,
  TaktStatus,
} from "./takt-types.ts";

const MAX_LIST_OUTPUT = 1_000_000;
const TASK_LIST_ARGS = ["list", "--non-interactive", "--format", "json"] as const;
const REQUIRED_META_STRING_FIELDS = [
  "task",
  "workflow",
  "runSlug",
  "runRoot",
  "reportDirectory",
  "contextDirectory",
  "logsDirectory",
  "startTime",
] as const;
const OPTIONAL_META_STRING_FIELDS = ["reason", "endTime", "currentStep", "updatedAt", "stage"] as const;
const TASK_TEXT_FIELDS = ["name", "content", "summary", "stage"] as const;
const TASK_TIME_FIELDS = ["createdAt", "startedAt", "completedAt"] as const;

export interface TaktStateOptions {
  command?: string;
  now?: number;
  /** Skip the CLI task queue and derive the snapshot from persistent run metadata only. */
  includeTaskList?: boolean;
}

export interface TaktRunReconcileResult {
  runSlug: string;
  reconciled: boolean;
}

/**
 * Close a persisted `running` record after the bridge has conclusively stopped
 * its owner, or after an operator explicitly chooses to recover stale state.
 * Unknown TAKT fields (including resume_point) are intentionally preserved.
 */
export function reconcileRunAsAborted(
  cwd: string,
  runSlug: string,
  reason: string,
  now = new Date(),
): TaktRunReconcileResult {
  const metaPath = resolve(cwd, ".takt", "runs", runSlug, "meta.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return { runSlug, reconciled: false };
  }
  if (!isRecord(value) || value.runSlug !== runSlug || value.status !== "running") {
    return { runSlug, reconciled: false };
  }

  const timestamp = now.toISOString();
  const step = isNonEmptyString(value.currentStep) ? value.currentStep : "unknown";
  const next = {
    ...value,
    status: "aborted",
    endTime: timestamp,
    updatedAt: timestamp,
    reason,
    failure: { step, error: reason },
  };
  const temporaryPath = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, metaPath);
  return { runSlug, reconciled: true };
}

export function parseRunMeta(value: unknown): TaktRunMeta | undefined {
  if (!isRecord(value) || !isPersistedStatus(value.status)) {
    return undefined;
  }
  if (REQUIRED_META_STRING_FIELDS.some((key) => !isNonEmptyString(value[key]))) {
    return undefined;
  }

  const result: TaktRunMeta = {
    task: value.task as string,
    workflow: value.workflow as string,
    runSlug: value.runSlug as string,
    runRoot: value.runRoot as string,
    reportDirectory: value.reportDirectory as string,
    contextDirectory: value.contextDirectory as string,
    logsDirectory: value.logsDirectory as string,
    status: value.status,
    startTime: value.startTime as string,
  };

  for (const key of OPTIONAL_META_STRING_FIELDS) {
    if (isNonEmptyString(value[key])) {
      result[key] = value[key];
    }
  }
  const ownerPid = parsePid(value.ownerPid);
  if (ownerPid !== undefined) {
    result.ownerPid = ownerPid;
  }
  const pid = parsePid(value.pid);
  if (pid !== undefined) {
    result.pid = pid;
  }
  if (isNonNegativeInteger(value.iterations)) {
    result.iterations = value.iterations;
  }
  if (isNonNegativeInteger(value.currentIteration)) {
    result.currentIteration = value.currentIteration;
  }
  if (value.phase === 1 || value.phase === 2 || value.phase === 3) {
    result.phase = value.phase;
  }
  const lastExit = parseLastExit(value.lastExit);
  if (lastExit) {
    result.lastExit = lastExit;
  }
  if (isRecord(value.failure) && isNonEmptyString(value.failure.step) && isNonEmptyString(value.failure.error)) {
    result.failure = { step: value.failure.step, error: value.failure.error };
  }

  return result;
}

export function classifyRunStatus(
  meta: Pick<TaktRunMeta, "status">,
  ownerPid?: number,
): TaktStatus {
  if (meta.status !== "running") {
    return meta.status;
  }
  if (ownerPid !== undefined && !isProcessAlive(ownerPid)) {
    return "stale";
  }
  return "running";
}

export function classifySessionStatus(
  meta: Pick<TaktRunMeta, "status"> & Partial<Pick<TaktRunMeta, "ownerPid" | "pid">>,
  ownerPid?: number,
): TaktSessionStatus {
  if (meta.status !== "running") {
    return "completed";
  }
  const pid = ownerPid ?? meta.ownerPid ?? meta.pid;
  if (pid === undefined) {
    return "unknown";
  }
  return isProcessAlive(pid) ? "live" : "stale";
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Workflow bundle facts the bridge can read without invoking TAKT. */
export interface TaktWorkflowBundleInfo {
  /** Top-level workflow step names from the immutable workflow bundle. */
  steps?: readonly string[];
  /** Workflow source layer parsed from the manifest's opaque ref (builtin/user/project/repertoire). */
  source?: string;
}

/** Live intra-step phase counts parsed from the run's JSONL log tail. */
export interface TaktStepPhaseProgress {
  started: number;
  completed: number;
  workers?: { done: number; total: number };
}

export function snapshotRun(
  meta: TaktRunMeta,
  ownerPid?: number,
  bundleInfo?: TaktWorkflowBundleInfo,
  livePhases?: TaktStepPhaseProgress,
  logDiagnostics?: TaktRunLogDiagnostics,
): TaktRunSnapshot {
  const pid = ownerPid ?? meta.ownerPid ?? meta.pid;
  const status = classifyRunStatus(meta, pid);
  const sessionStatus = classifySessionStatus(meta, pid);
  const stage = meta.stage ?? meta.currentStep;
  return {
    slug: meta.runSlug,
    task: meta.task,
    workflow: meta.workflow,
    ...(bundleInfo?.steps && bundleInfo.steps.length > 0 ? { workflowSteps: [...bundleInfo.steps] } : {}),
    ...(bundleInfo?.source ? { workflowSource: bundleInfo.source } : {}),
    ...(livePhases?.started ? { stepPhases: { started: livePhases.started, completed: livePhases.completed } } : {}),
    ...(livePhases?.workers && livePhases.workers.total > 0
      ? { workers: { ...livePhases.workers } }
      : {}),
    status,
    sessionStatus,
    ...(pid !== undefined ? { pid } : {}),
    ...(stage ? { stage } : {}),
    ...(meta.lastExit ? { lastExit: meta.lastExit } : {}),
    ...(meta.startTime ? { startTime: meta.startTime } : {}),
    ...(meta.endTime ? { endTime: meta.endTime } : {}),
    ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
    ...(meta.currentStep ? { currentStep: meta.currentStep } : {}),
    ...(meta.currentIteration !== undefined ? { currentIteration: meta.currentIteration } : {}),
    ...(meta.phase !== undefined ? { phase: meta.phase } : {}),
    ...(meta.reason ? { reason: meta.reason } : {}),
    ...(meta.failure ? { failure: meta.failure.error } : {}),
    ...(logDiagnostics ? { logDiagnostics } : {}),
  };
}

export function readRunSnapshots(cwd: string, taskItems: readonly TaktTaskItem[] = []): TaktRunSnapshot[] {
  const snapshotsBySlug = new Map<string, TaktRunSnapshot>();
  for (const runCwd of readRunWorkspaces(cwd)) {
    const runsDirectory = resolve(runCwd, ".takt", "runs");
    if (!existsSync(runsDirectory)) {
      continue;
    }
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
      entries = readdirSync(runsDirectory, { withFileTypes: true });
    } catch (error) {
      if (runCwd === cwd) {
        throw error;
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const metaPath = resolve(runsDirectory, entry.name, "meta.json");
      try {
        const meta = parseRunMeta(JSON.parse(readFileSync(metaPath, "utf8")));
        if (!meta || meta.runSlug !== entry.name) {
          continue;
        }
        const ownerPid = findOwnerPid(meta, taskItems);
        const bundleInfo = meta.status === "running"
          ? readWorkflowBundleInfo(runCwd, entry.name)
          : undefined;
        let livePhases: TaktStepPhaseProgress | undefined;
        let logDiagnostics: TaktRunLogDiagnostics | undefined;
        if (meta.status === "running" || meta.status === "failed") {
          const tail = readLatestRunLogTail(runCwd, entry.name);
          logDiagnostics = summarizeLogDiagnostics(tail);
          if (meta.status === "running" && !("unavailable" in tail)) {
            livePhases = summarizePhaseProgress(tail.events);
          }
        }
        const snapshot = { ...snapshotRun(meta, ownerPid, bundleInfo, livePhases, logDiagnostics), workspace: runCwd };
        const existing = snapshotsBySlug.get(entry.name);
        if (!existing || compareRuns(snapshot, existing) < 0) {
          snapshotsBySlug.set(entry.name, snapshot);
        }
      } catch {
        // A run can be observed while TAKT is replacing meta.json. Ignore it
        // for this poll and let the next refresh reconcile it.
      }
    }
  }

  return [...snapshotsBySlug.values()].sort(compareRuns);
}

function readRunWorkspaces(cwd: string): string[] {
  const workspaces = [cwd];
  const seen = new Set([resolve(cwd)]);
  const cloneMetaDirectory = resolve(cwd, ".takt", "clone-meta");
  if (!existsSync(cloneMetaDirectory)) {
    return workspaces;
  }
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = readdirSync(cloneMetaDirectory, { withFileTypes: true });
  } catch {
    return workspaces;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const metadata: unknown = JSON.parse(readFileSync(resolve(cloneMetaDirectory, entry.name), "utf8"));
      if (!isRecord(metadata) || !isNonEmptyString(metadata.clonePath)) {
        continue;
      }
      const clonePath = resolve(metadata.clonePath);
      if (!seen.has(clonePath) && existsSync(clonePath)) {
        seen.add(clonePath);
        workspaces.push(clonePath);
      }
    } catch {
      // Ignore stale or partially-written clone metadata for this poll.
    }
  }
  return workspaces;
}

const LOG_TAIL_BYTES = 64 * 1_024;
const LOG_EXCERPT_MAX_LENGTH = 280;
const LOG_FIELD_MAX_LENGTH = 120;
const DIAGNOSTIC_EVENT_TYPES = new Set([
  "workflow_start",
  "workflow_complete",
  "workflow_failed",
  "step_start",
  "step_complete",
  "step_failed",
  "phase_start",
  "phase_complete",
  "phase_judge_stage",
  "phase_failed",
  "error",
]);
const ERROR_EVENT_TYPES = new Set([
  "workflow_failed",
  "step_failed",
  "phase_failed",
  "error",
]);
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*[a-zA-Z]/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

interface RunLogTail {
  events: Array<Record<string, unknown>>;
  skippedLines: number;
}

type RunLogTailUnavailable = {
  unavailable: true;
  reason: "no_logs" | "unreadable";
  skippedLines?: number;
};

type RunLogTailResult = RunLogTail | RunLogTailUnavailable;

export interface ReadRunLogDiagnosticsOptions {
  maxExcerptLength?: number;
}

/**
 * Parse the run's JSONL log tail for live intra-step phase activity: how many
 * phase executions started vs completed inside the current step execution, and
 * parallel worker completion (worker-N style names). Best-effort; any parse
 * trouble yields undefined and the meter falls back to meta phase only.
 */
export function readRunPhaseProgress(cwd: string, runSlug: string): TaktStepPhaseProgress | undefined {
  const tail = readLatestRunLogTail(cwd, runSlug);
  if ("unavailable" in tail) {
    return undefined;
  }
  return summarizePhaseProgress(tail.events);
}

/**
 * Read bounded, sanitized diagnostic facts from the latest run JSONL log tail.
 * Never throws; unavailable tails return a short reason instead.
 */
export function readRunLogDiagnostics(
  cwd: string,
  runSlug: string,
  options: ReadRunLogDiagnosticsOptions = {},
): TaktRunLogDiagnostics {
  return summarizeLogDiagnostics(readLatestRunLogTail(cwd, runSlug), options.maxExcerptLength);
}

function readLatestRunLogTail(cwd: string, runSlug: string): RunLogTailResult {
  try {
    const logsDirectory = resolve(cwd, ".takt", "runs", runSlug, "logs");
    if (!existsSync(logsDirectory)) {
      return { unavailable: true, reason: "no_logs" };
    }
    const logFiles = readdirSync(logsDirectory)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    const latest = logFiles.at(-1);
    if (latest === undefined) {
      return { unavailable: true, reason: "no_logs" };
    }
    const logPath = resolve(logsDirectory, latest);
    const size = statSync(logPath).size;
    let start = 0;
    const handle = openSync(logPath, "r");
    let tailText: string;
    try {
      start = Math.max(0, size - LOG_TAIL_BYTES);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, start);
      tailText = buffer.toString("utf8");
    } finally {
      closeSync(handle);
    }

    const events: Array<Record<string, unknown>> = [];
    let skippedLines = 0;
    for (const line of tailText.split(/\r?\n/).slice(start > 0 ? 1 : 0)) {
      if (line.length === 0) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) {
          events.push(parsed);
        } else {
          skippedLines += 1;
        }
      } catch {
        skippedLines += 1;
      }
    }
    return { events, skippedLines };
  } catch {
    return { unavailable: true, reason: "unreadable" };
  }
}

function summarizePhaseProgress(events: readonly Record<string, unknown>[]): TaktStepPhaseProgress | undefined {
  const lastStepStartIndex = findLastIndex(events, (event) => event.type === "step_start");
  if (lastStepStartIndex < 0) {
    return undefined;
  }
  const started = new Set<string>();
  const completed = new Set<string>();
  const workerNames = new Set<string>();
  const startedIdsByWorkerName = new Map<string, Set<string>>();
  for (const event of events.slice(lastStepStartIndex + 1)) {
    const executionId = typeof event.phaseExecutionId === "string" ? event.phaseExecutionId : undefined;
    const phaseName = typeof event.phaseName === "string" ? event.phaseName : "";
    if (executionId === undefined) {
      continue;
    }
    if (/^worker/i.test(phaseName)) {
      workerNames.add(phaseName);
      let ids = startedIdsByWorkerName.get(phaseName);
      if (ids === undefined) {
        ids = new Set<string>();
        startedIdsByWorkerName.set(phaseName, ids);
      }
      ids.add(executionId);
    }
    switch (event.type) {
      case "phase_start":
        started.add(executionId);
        break;
      case "phase_complete":
        started.add(executionId);
        completed.add(executionId);
        break;
      case "phase_judge_stage":
        break;
    }
  }
  if (started.size === 0) {
    return undefined;
  }
  const progress: TaktStepPhaseProgress = { started: started.size, completed: completed.size };
  if (workerNames.size > 1) {
    const doneWorkers = [...workerNames].filter((name) => {
      const ids = startedIdsByWorkerName.get(name);
      return ids !== undefined && ids.size > 0 && [...ids].every((id) => completed.has(id));
    }).length;
    progress.workers = { done: Math.min(doneWorkers, workerNames.size), total: workerNames.size };
  }
  return progress;
}

function summarizeLogDiagnostics(
  tail: RunLogTailResult,
  maxExcerptLength = LOG_EXCERPT_MAX_LENGTH,
): TaktRunLogDiagnostics {
  if ("unavailable" in tail) {
    return {
      available: false,
      reason: tail.reason,
      ...(tail.skippedLines ? { skippedLines: tail.skippedLines } : {}),
    };
  }
  const { events, skippedLines } = tail;
  if (events.length === 0) {
    return {
      available: false,
      reason: "no_events",
      ...(skippedLines > 0 ? { skippedLines } : {}),
    };
  }

  const result: Extract<TaktRunLogDiagnostics, { available: true }> = { available: true };
  if (skippedLines > 0) {
    result.skippedLines = skippedLines;
  }

  const lastStepStart = findLast(events, (event) => event.type === "step_start");
  if (lastStepStart && isNonEmptyString(lastStepStart.step)) {
    result.step = sanitizeLogExcerpt(lastStepStart.step, LOG_FIELD_MAX_LENGTH);
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const eventType = typeof event.type === "string" ? event.type : undefined;
    if (eventType === undefined || !DIAGNOSTIC_EVENT_TYPES.has(eventType)) {
      continue;
    }
    result.eventType = eventType;
    if (isNonEmptyString(event.phaseName)) {
      result.phase = sanitizeLogExcerpt(event.phaseName, LOG_FIELD_MAX_LENGTH);
    }
    if (isNonEmptyString(event.status)) {
      result.status = sanitizeLogExcerpt(event.status, 80);
    }
    const timestamp = pickLogTimestamp(event);
    if (timestamp) {
      result.timestamp = timestamp;
    }
    break;
  }

  const phaseProgress = summarizePhaseProgress(events);
  if (phaseProgress?.workers) {
    result.workers = { ...phaseProgress.workers };
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const eventType = typeof event.type === "string" ? event.type : "";
    const message = extractAllowlistedMessage(event, eventType, maxExcerptLength);
    if (message) {
      result.message = message;
      break;
    }
  }

  const hasContent = result.eventType !== undefined ||
    result.step !== undefined ||
    result.phase !== undefined ||
    result.status !== undefined ||
    result.workers !== undefined ||
    result.timestamp !== undefined ||
    result.message !== undefined;
  if (!hasContent) {
    return {
      available: false,
      reason: "no_events",
      ...(skippedLines > 0 ? { skippedLines } : {}),
    };
  }

  return result;
}

export function sanitizeLogExcerpt(value: string, maxLength: number): string {
  let cleaned = value.replace(ANSI_ESCAPE_PATTERN, "").replace(CONTROL_CHAR_PATTERN, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  if (maxLength <= 1) {
    return "…";
  }
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function extractAllowlistedMessage(
  event: Record<string, unknown>,
  eventType: string,
  maxLength: number,
): string | undefined {
  const raw = isNonEmptyString(event.error)
    ? event.error
    : ERROR_EVENT_TYPES.has(eventType) && isNonEmptyString(event.message)
      ? event.message
      : undefined;
  return raw ? sanitizeLogExcerpt(raw, maxLength) : undefined;
}

function pickLogTimestamp(event: Record<string, unknown>): string | undefined {
  for (const key of ["timestamp", "time", "at"] as const) {
    if (isNonEmptyString(event[key])) {
      return sanitizeLogExcerpt(event[key], 40);
    }
  }
  return undefined;
}

function findLast<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return items[index];
    }
  }
  return undefined;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

function readWorkflowBundleInfo(cwd: string, runSlug: string): TaktWorkflowBundleInfo | undefined {
  try {
    const bundleRoot = resolve(cwd, ".takt", "runs", runSlug, "workflow-bundle");
    const manifest = JSON.parse(readFileSync(resolve(bundleRoot, "manifest.json"), "utf8"));
    if (!isRecord(manifest) || !isRecord(manifest.root) || !isRecord(manifest.nodes)) {
      return undefined;
    }
    const rootNodeId = manifest.root.nodeId;
    if (!isNonEmptyString(rootNodeId) || !isSha256(rootNodeId)) {
      return undefined;
    }
    const objectHash = manifest.nodes[rootNodeId];
    if (!isNonEmptyString(objectHash) || !isSha256(objectHash)) {
      return undefined;
    }
    const node = JSON.parse(readFileSync(resolve(bundleRoot, "objects", `${objectHash}.json`), "utf8"));
    const info: TaktWorkflowBundleInfo = {};
    const source = parseWorkflowSource(manifest.root.originalWorkflowRef);
    if (source !== undefined) {
      info.source = source;
    }
    if (isRecord(node) && isRecord(node.config) && Array.isArray(node.config.steps)) {
      const names = node.config.steps
        .map((step) => isRecord(step) && isNonEmptyString(step.name) ? step.name.trim() : undefined)
        .filter((name): name is string => name !== undefined);
      if (names.length > 0) {
        info.steps = names;
      }
    }
    return Object.keys(info).length > 0 ? info : undefined;
  } catch {
    // Workflow bundles are published after run metadata; use currentStep/phase
    // until the immutable bundle becomes available or when running older TAKT.
    return undefined;
  }
}

/** TAKT opaque workflow refs look like `<source>:sha256:<hash>` with source builtin|user|project|repertoire. */
function parseWorkflowSource(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  return /^([a-z][a-z0-9_-]*):sha256:/i.exec(value)?.[1]?.toLowerCase();
}

export async function readTaktSummary(cwd: string, options: TaktStateOptions = {}): Promise<TaktSummary> {
  const taskItems = options.includeTaskList === false
    ? []
    : await readTaskItems(cwd, options.command);
  const runs = readRunSnapshots(cwd, taskItems);
  const pending = taskItems.filter((item) => item.kind === "pending").length;
  const queueRunning = taskItems.filter((item) => item.kind === "running").length;
  const queueBlocked = taskItems.filter((item) => item.kind === "blocked" || item.kind === "exceeded").length;
  const queueFailed = taskItems.filter((item) => item.kind === "failed").length;
  const queueCompleted = taskItems.filter((item) => item.kind === "completed").length;
  const failedRun = runs.find((run) => run.status === "failed" || run.status === "stale");
  const representativeRun = runs[0];
  const representativeTask = taskItems.find((item) => item.kind === "running");
  const status = deriveSummarySessionStatus(runs, taskItems);
  const pid = representativeRun?.pid ?? representativeTask?.ownerPid;
  const stage = representativeRun?.stage ?? representativeTask?.stage;
  const lastExit = representativeRun?.lastExit ?? representativeTask?.lastExit;
  const activityAt = findLatestActivityAt(runs, taskItems);

  return {
    cwd,
    runs,
    status,
    ...(pid !== undefined ? { pid } : {}),
    ...(stage ? { stage } : {}),
    ...(lastExit ? { lastExit } : {}),
    running: Math.max(queueRunning, runs.filter((run) => run.status === "running").length),
    pending,
    blocked: queueBlocked + runs.filter((run) => run.status === "blocked").length,
    failed: queueFailed + runs.filter((run) => run.status === "failed").length,
    completed: queueCompleted + runs.filter((run) => run.status === "completed").length,
    stale: runs.filter((run) => run.status === "stale").length,
    ...(activityAt ? { activityAt } : {}),
    ...(failedRun?.failure || failedRun?.reason ? { lastError: failedRun.failure ?? failedRun.reason } : {}),
  };
}

export function deriveSummarySessionStatus(
  runs: readonly Pick<TaktRunSnapshot, "sessionStatus">[],
  taskItems: readonly TaktTaskItem[] = [],
): TaktSessionStatus {
  const statuses = [
    ...runs.map((run) => run.sessionStatus),
    ...taskItems.filter((item) => item.kind === "running").map(classifyTaskSessionStatus),
  ];
  if (statuses.includes("live")) {
    return "live";
  }
  if (statuses.includes("stale")) {
    return "stale";
  }
  if (statuses.includes("unknown")) {
    return "unknown";
  }
  if (statuses.includes("completed")) {
    return "completed";
  }
  return "unknown";
}

export async function readTaskItems(cwd: string, command?: string): Promise<TaktTaskItem[]> {
  const resolvedCommand = resolveCommand(command);
  const stdout = await runTaskList(resolvedCommand, cwd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`TAKT task list returned invalid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
    throw new Error("TAKT task list returned an invalid response shape");
  }
  return parsed.tasks.map(normalizeTaskItem).filter((item): item is TaktTaskItem => item !== undefined);
}

function runTaskList(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(command, [...TASK_LIST_ARGS], {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`TAKT task list could not start: ${errorMessage(error)}`));
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_LIST_OUTPUT) {
        fail(new Error(`TAKT task list exceeded the ${MAX_LIST_OUTPUT}-byte output limit`));
        try {
          child.kill();
        } catch {
          // The owned task-list child is already exiting.
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-500);
    });
    child.once("error", (error) => fail(new Error(`TAKT task list could not start: ${errorMessage(error)}`)));
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (code !== 0 || signal !== null) {
        const detail = stderr.trim();
        fail(new Error(
          `TAKT task list failed (exit ${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`,
        ));
        return;
      }
      settled = true;
      resolve(stdout);
    });
  });
}

export function resolveCommand(command?: string): string {
  const selectedCommand = command ?? process.env.TAKT_COMMAND ?? "takt";
  if (process.platform !== "win32" || /[\\/]/.test(selectedCommand) || /\.(?:cmd|exe|bat)$/i.test(selectedCommand)) {
    return selectedCommand;
  }
  return `${selectedCommand}.cmd`;
}

export function usesWindowsShell(command: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

function findOwnerPid(meta: TaktRunMeta, taskItems: readonly TaktTaskItem[]): number | undefined {
  const match = taskItems.find((item) =>
    item.kind === "running" &&
    item.ownerPid !== undefined &&
    (item.data?.task === meta.task || item.content === meta.task || item.summary === meta.task),
  );
  return match?.ownerPid ?? meta.ownerPid ?? meta.pid;
}

function compareRuns(left: TaktRunSnapshot, right: TaktRunSnapshot): number {
  const leftActive = left.status === "running" || left.status === "starting" || left.status === "stale";
  const rightActive = right.status === "running" || right.status === "starting" || right.status === "stale";
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }
  return (right.startTime ?? "").localeCompare(left.startTime ?? "");
}

function classifyTaskSessionStatus(item: TaktTaskItem): TaktSessionStatus {
  if (item.ownerPid === undefined) {
    return "unknown";
  }
  return isProcessAlive(item.ownerPid) ? "live" : "stale";
}

function normalizeTaskItem(value: unknown): TaktTaskItem | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) {
    return undefined;
  }
  const item: TaktTaskItem = { kind: value.kind };
  for (const key of TASK_TEXT_FIELDS) {
    if (isNonEmptyString(value[key])) {
      item[key] = value[key];
    }
  }
  for (const key of TASK_TIME_FIELDS) {
    if (isNonEmptyString(value[key])) {
      item[key] = value[key];
    }
  }
  const ownerPid = parsePid(value.ownerPid);
  if (ownerPid !== undefined) {
    item.ownerPid = ownerPid;
  }
  if (isRecord(value.failure) && typeof value.failure.error === "string") {
    item.failure = { error: value.failure.error };
  }
  const lastExit = parseLastExit(value.lastExit);
  if (lastExit) {
    item.lastExit = lastExit;
  }
  if (isRecord(value.data) && typeof value.data.task === "string") {
    item.data = { task: value.data.task };
  }
  return item;
}

function findLatestActivityAt(
  runs: readonly TaktRunSnapshot[],
  taskItems: readonly TaktTaskItem[],
): string | undefined {
  const timestamps = [
    ...runs
      .filter((run) => run.status === "running" || run.status === "failed" || run.status === "stale")
      .flatMap((run) => [run.endTime, run.updatedAt, run.startTime]),
    ...taskItems
      .filter((item) =>
        item.kind === "pending" ||
        item.kind === "running" ||
        item.kind === "blocked" ||
        item.kind === "failed" ||
        item.kind === "exceeded",
      )
      .flatMap((item) => [item.completedAt, item.startedAt, item.createdAt]),
  ]
    .filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return timestamps[0];
}

function parseLastExit(value: unknown): TaktLastExit | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: TaktLastExit = {};
  if (isInteger(value.code)) {
    result.code = value.code;
  }
  if (isInteger(value.signal)) {
    result.signal = value.signal;
  }
  return result.code !== undefined || result.signal !== undefined ? result : undefined;
}

function parsePid(value: unknown): number | undefined {
  return isPositiveInteger(value) ? value : undefined;
}

function isPersistedStatus(value: unknown): value is TaktRunMeta["status"] {
  return value === "running" || value === "completed" || value === "aborted" || value === "failed";
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
