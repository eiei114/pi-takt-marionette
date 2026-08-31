export const RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "aborted",
  "blocked",
  "stale",
] as const;

export type TaktStatus = (typeof RUN_STATUSES)[number];
export type PersistedRunStatus = "running" | "completed" | "aborted" | "failed";

export const TAKT_SESSION_STATUSES = ["live", "stale", "completed", "unknown"] as const;
export type TaktSessionStatus = (typeof TAKT_SESSION_STATUSES)[number];

/** Hide observed, non-running activity after it has been quiet for this long. */
export const DEFAULT_OBSERVED_INACTIVITY_TTL_MS = 30 * 60 * 1_000;

export interface TaktLastExit {
  code?: number;
  signal?: number;
}

export function formatTaktLastExit(lastExit: TaktLastExit): string {
  const code = lastExit.code !== undefined ? `code=${lastExit.code}` : "code=unknown";
  const signal = lastExit.signal !== undefined ? ` signal=${lastExit.signal}` : "";
  return `${code}${signal}`;
}

export interface TaktRunMeta {
  task: string;
  workflow: string;
  runSlug: string;
  runRoot: string;
  reportDirectory: string;
  contextDirectory: string;
  logsDirectory: string;
  status: PersistedRunStatus;
  startTime: string;
  ownerPid?: number;
  pid?: number;
  stage?: string;
  lastExit?: TaktLastExit;
  reason?: string;
  failure?: {
    step: string;
    error: string;
  };
  endTime?: string;
  iterations?: number;
  currentStep?: string;
  currentIteration?: number;
  phase?: 1 | 2 | 3;
  updatedAt?: string;
}

export interface TaktRunSnapshot {
  slug: string;
  /** Workspace that owns this run's persistent metadata. */
  workspace?: string;
  task: string;
  workflow: string;
  /** Top-level workflow step names from the run's immutable workflow bundle. */
  workflowSteps?: string[];
  /** Workflow source layer from the run bundle manifest: builtin, user, project, or repertoire. */
  workflowSource?: string;
  /** Live phase execution counts for the active step, parsed from the run's JSONL log tail. */
  stepPhases?: { started: number; completed: number };
  /** Parallel worker completion inside the active step, when workers are detected. */
  workers?: { done: number; total: number };
  status: TaktStatus;
  sessionStatus: TaktSessionStatus;
  pid?: number;
  stage?: string;
  lastExit?: TaktLastExit;
  startTime?: string;
  endTime?: string;
  updatedAt?: string;
  currentStep?: string;
  currentIteration?: number;
  phase?: 1 | 2 | 3;
  reason?: string;
  failure?: string;
  /** Bounded NDJSON log tail summary for diagnostic overlays. */
  logDiagnostics?: TaktRunLogDiagnostics;
}

/** Bounded, sanitized facts parsed from a run's latest JSONL log tail. */
export type TaktRunLogDiagnostics =
  | {
      available: true;
      eventType?: string;
      step?: string;
      phase?: string;
      status?: string;
      workers?: { done: number; total: number };
      timestamp?: string;
      message?: string;
      skippedLines?: number;
    }
  | {
      available: false;
      reason: "no_logs" | "unreadable" | "no_events";
      skippedLines?: number;
    };

export interface TaktTaskItem {
  kind: string;
  name?: string;
  content?: string;
  summary?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  ownerPid?: number;
  stage?: string;
  lastExit?: TaktLastExit;
  failure?: {
    error?: string;
  };
  data?: {
    task?: string;
  };
}

export interface TaktSummary {
  cwd: string;
  runs: TaktRunSnapshot[];
  status: TaktSessionStatus;
  pid?: number;
  stage?: string;
  lastExit?: TaktLastExit;
  running: number;
  pending: number;
  blocked: number;
  failed: number;
  completed: number;
  stale: number;
  /** Latest timestamp belonging to queue/run activity kept in the status card. */
  activityAt?: string;
  lastError?: string;
}

export function hasTaktSummaryActivity(summary: TaktSummary | undefined): boolean {
  return summary !== undefined && (
    summary.running > 0 ||
    summary.pending > 0 ||
    summary.blocked > 0 ||
    summary.failed > 0 ||
    summary.stale > 0
  );
}

/**
 * Running work stays visible indefinitely. Observed non-running work is kept
 * visible only while it has recent activity; missing timestamps stay visible
 * rather than hiding work that an older TAKT version cannot date.
 */
export function hasRecentTaktSummaryActivity(
  summary: TaktSummary | undefined,
  now = Date.now(),
  ttlMs = DEFAULT_OBSERVED_INACTIVITY_TTL_MS,
): boolean {
  if (!summary || !hasTaktSummaryActivity(summary)) {
    return false;
  }
  if (summary.running > 0) {
    return true;
  }
  if (!summary.activityAt) {
    return true;
  }
  const activityAt = Date.parse(summary.activityAt);
  if (!Number.isFinite(activityAt)) {
    return true;
  }
  return now - activityAt < ttlMs;
}
