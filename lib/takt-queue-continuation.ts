/**
 * Decide when a finished `takt run` should be followed by another `takt run`.
 *
 * `takt run` claims the pending tasks once, at startup. Tasks enqueued while a
 * run is active are therefore invisible to that run and would sit in
 * `.takt/tasks.yaml` until someone starts `takt run` again. This module owns the
 * rule for chaining that follow-up run automatically.
 */

/** Fallback cap for consecutive automatic follow-up runs. */
export const DEFAULT_MAX_QUEUE_CONTINUATIONS = 20;

/**
 * Resolve the continuation cap. `TAKT_QUEUE_AUTO_CONTINUE_MAX=0` disables
 * automatic continuation; a malformed value falls back to the default so a typo
 * cannot silently disable the queue.
 */
export function resolveMaxQueueContinuations(
  raw: string | undefined = process.env.TAKT_QUEUE_AUTO_CONTINUE_MAX,
): number {
  const normalized = raw?.trim();
  if (normalized === undefined || normalized === "") {
    return DEFAULT_MAX_QUEUE_CONTINUATIONS;
  }
  // Digits only: `Number.parseInt` would read "7tasks" as 7 and "1e2" as 1, so
  // a typo in the environment would silently change the cap instead of falling
  // back to the documented default.
  if (!/^\d+$/.test(normalized)) {
    return DEFAULT_MAX_QUEUE_CONTINUATIONS;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : DEFAULT_MAX_QUEUE_CONTINUATIONS;
}

export interface QueueContinuationInput {
  /** The finished run was started as a queue run (`takt run`), not an exec session. */
  queueRunActive: boolean;
  /** A continuation start is already in flight for this project. */
  continuationInFlight: boolean;
  /** The bridge-owned PTY is still alive. */
  runnerRunning: boolean;
  /** Exit code of the finished run, when it is known. */
  exitCode?: number;
  /** Bridge stage after the completion was reconciled. */
  stage: string;
  /** Pending tasks still queued in `.takt/tasks.yaml`. */
  pending: number;
  /** Automatic follow-up runs already started for this queue session. */
  continuationCount: number;
  /** Cap for consecutive automatic follow-up runs. */
  maxContinuations: number;
}

export type QueueContinuationReason =
  | "not-a-queue-run"
  | "continuation-in-flight"
  | "runner-still-running"
  | "previous-run-did-not-succeed"
  | "stage-not-completed"
  | "no-pending-tasks"
  | "continuation-limit-reached"
  | "pending-tasks-remain";

export interface QueueContinuationDecision {
  continue: boolean;
  reason: QueueContinuationReason;
}

/**
 * Automatic continuation is deliberately conservative: it only follows a queue
 * run that exited successfully. A stopped, aborted, or failed run leaves the
 * queue for the operator, because repeating a failing task unattended is worse
 * than stopping.
 */
export function decideQueueContinuation(input: QueueContinuationInput): QueueContinuationDecision {
  if (!input.queueRunActive) {
    return { continue: false, reason: "not-a-queue-run" };
  }
  if (input.continuationInFlight) {
    return { continue: false, reason: "continuation-in-flight" };
  }
  if (input.runnerRunning) {
    return { continue: false, reason: "runner-still-running" };
  }
  if (input.exitCode !== 0) {
    return { continue: false, reason: "previous-run-did-not-succeed" };
  }
  if (input.stage !== "completed") {
    return { continue: false, reason: "stage-not-completed" };
  }
  if (input.pending <= 0) {
    return { continue: false, reason: "no-pending-tasks" };
  }
  if (input.maxContinuations <= 0) {
    return { continue: false, reason: "continuation-limit-reached" };
  }
  if (input.continuationCount >= input.maxContinuations) {
    return { continue: false, reason: "continuation-limit-reached" };
  }
  return { continue: true, reason: "pending-tasks-remain" };
}
