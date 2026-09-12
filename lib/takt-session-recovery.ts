import {
  DEFAULT_OBSERVED_INACTIVITY_TTL_MS,
  type TaktLastExit,
  type TaktRunSnapshot,
  type TaktSessionStatus,
  type TaktSummary,
} from "./takt-types.ts";

/** Who owns the session state that a snapshot reports. */
export type TaktSessionOwnership = "bridge" | "observed" | "none";

export interface ObservedRunRef {
  slug: string;
  status: TaktRunSnapshot["status"];
  sessionStatus: TaktRunSnapshot["sessionStatus"];
  pid?: number;
}

export interface ProjectSessionSnapshot {
  status: TaktSessionStatus;
  pid?: number;
  stage?: string;
  lastExit?: TaktLastExit;
  ownership: TaktSessionOwnership;
  observedRun?: ObservedRunRef;
}

export interface ProjectSessionSnapshotInput {
  /** Bridge project stage label. */
  stage: string;
  /** True when the bridge already reached a terminal stage for its own PTY. */
  stageIsTerminal: boolean;
  /** Bridge PTY process is alive. */
  runnerRunning: boolean;
  /** Bridge PTY lifecycle status: idle, running, stale, completed, unknown. */
  runnerStatus: string;
  runnerPid?: number;
  runnerLastExit?: TaktLastExit;
  /** Observed TAKT state read from the project's `.takt` metadata. */
  observed?: TaktSummary;
  /** Clock override for tests. */
  now?: number;
}

/**
 * The run that observed TAKT metadata reports as active, whether or not the
 * bridge ever owned its PTY.
 */
/** A run record that may still own live work: running/stale status or session. */
function isActiveRunRecord(run: TaktRunSnapshot): boolean {
  return (
    run.status === "running"
      || run.status === "stale"
      || run.sessionStatus === "live"
      || run.sessionStatus === "stale"
  );
}

export function findObservedActiveRun(summary: TaktSummary | undefined): TaktRunSnapshot | undefined {
  return summary?.runs.find(isActiveRunRecord);
}

function toObservedRunRef(run: TaktRunSnapshot | undefined): ObservedRunRef | undefined {
  if (!run) {
    return undefined;
  }
  return {
    slug: run.slug,
    status: run.status,
    sessionStatus: run.sessionStatus,
    ...(run.pid !== undefined ? { pid: run.pid } : {}),
  };
}

/**
 * Observed `running` metadata with no recorded owner pid. A completed bridge PTY
 * must not hide it: that combination is exactly the case where a killed or
 * external `takt run` leaves unaccounted work behind, and reporting `completed`
 * makes the operator believe nothing is running.
 *
 * Freshness is required so old orphaned metadata (a crashed run TAKT has not
 * reconciled yet) does not pin the project to `unknown` forever. Metadata with
 * no usable timestamp fails open and keeps blocking, because an undatable
 * `running` record is not evidence that nothing is running.
 */
export function isUnaccountedRunningMetadata(
  summary: TaktSummary | undefined,
  now = Date.now(),
  ttlMs = DEFAULT_OBSERVED_INACTIVITY_TTL_MS,
): boolean {
  if (!summary || summary.status !== "unknown" || summary.running <= 0) {
    return false;
  }
  const stamp = latestObservedActivityAt(summary);
  if (stamp === undefined) {
    return true;
  }
  const activityAt = Date.parse(stamp);
  if (!Number.isFinite(activityAt)) {
    return true;
  }
  return now - activityAt < ttlMs;
}

function latestObservedActivityAt(summary: TaktSummary): string | undefined {
  const stamps = [
    ...(summary.activityAt ? [summary.activityAt] : []),
    // Only active runs date the unresolved work. A recently completed run says
    // nothing about an orphaned `running` record, and using its stamp would
    // keep that record fresh (and blocking) far past the inactivity TTL.
    ...summary.runs
      .filter(isActiveRunRecord)
      .flatMap((run) => [run.updatedAt, run.startTime].filter((value): value is string => Boolean(value))),
  ];
  let latest: { raw: string; at: number } | undefined;
  for (const raw of stamps) {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) {
      continue;
    }
    if (!latest || at > latest.at) {
      latest = { raw, at };
    }
  }
  return latest?.raw;
}

/**
 * Resolve the session snapshot without letting a finished bridge PTY mask
 * observed work. Pure function so both the widget row and `takt_read_screen`
 * report the same thing.
 */
export function resolveProjectSessionSnapshot(input: ProjectSessionSnapshotInput): ProjectSessionSnapshot {
  const observed = input.observed;
  const observedRun = findObservedActiveRun(observed);
  const observedRef = toObservedRunRef(observedRun);
  const bridgeCompleted = input.runnerLastExit !== undefined || input.runnerStatus === "completed";
  const unaccounted = isUnaccountedRunningMetadata(observed, input.now);

  const observedSnapshot = (summary: TaktSummary): ProjectSessionSnapshot => ({
    status: summary.status,
    stage: summary.stage ?? input.stage,
    ownership: "observed",
    ...(summary.pid !== undefined ? { pid: summary.pid } : {}),
    ...(observedRef ? { observedRun: observedRef } : {}),
  });

  if (input.stageIsTerminal) {
    // A terminal bridge stage normally means "this bridge session is done", but
    // fresh `running` metadata with no recorded owner pid must still surface:
    // that is a killed or external run, not a finished one.
    // An observed live run wins for the same reason: the bridge finishing its
    // own PTY does not mean the run TAKT is reporting has stopped.
    if (observed && (observed.status === "live" || unaccounted)) {
      return observedSnapshot(observed);
    }
    return {
      status: "completed",
      stage: input.stage,
      ownership: bridgeCompleted || input.runnerPid !== undefined ? "bridge" : "none",
      ...(input.runnerPid !== undefined ? { pid: input.runnerPid } : {}),
      ...(input.runnerLastExit ? { lastExit: input.runnerLastExit } : {}),
    };
  }

  if (input.runnerStatus === "stale") {
    return {
      status: "stale",
      stage: input.stage,
      ownership: "bridge",
      ...(input.runnerPid !== undefined ? { pid: input.runnerPid } : {}),
    };
  }

  if (input.runnerRunning) {
    return {
      status: "live",
      stage: input.stage,
      ownership: "bridge",
      ...(input.runnerPid !== undefined ? { pid: input.runnerPid } : {}),
      ...(observed ? { observedRun: observedRef } : {}),
    };
  }

  if (
    observed &&
    (observed.status === "live" ||
      (!bridgeCompleted &&
        (observed.status === "stale" || unaccounted)))
  ) {
    return observedSnapshot(observed);
  }

  if (bridgeCompleted) {
    return {
      status: "completed",
      stage: input.stage,
      ownership: "bridge",
      ...(input.runnerPid !== undefined ? { pid: input.runnerPid } : {}),
      ...(input.runnerLastExit ? { lastExit: input.runnerLastExit } : {}),
    };
  }

  if (observed) {
    return observedSnapshot(observed);
  }

  return { status: "unknown", stage: input.stage, ownership: "none" };
}

export interface StopProjectResolutionInput {
  /** Explicit project or profile target requested by the caller. */
  requestedId?: string;
  /** Bridge-owned running project id. */
  activeRunningId?: string;
  /** Project with observed TAKT activity, stale/unknown metadata included. */
  observedId?: string;
  /** Operator asked to reconcile observed stale/unknown metadata. */
  forceObserved: boolean;
}

/**
 * Pick the project a stop/reconcile request applies to. Without an explicit
 * target the bridge-owned running project wins; when nothing is bridge-owned a
 * `forceObserved` reconcile must still reach the project that owns the stale
 * metadata, otherwise the operator is told "not running" while TAKT state still
 * blocks every later start.
 */
export function resolveStopProjectId(input: StopProjectResolutionInput): string | undefined {
  if (input.requestedId) {
    return input.requestedId;
  }
  if (input.activeRunningId) {
    return input.activeRunningId;
  }
  return input.forceObserved ? input.observedId : undefined;
}

/**
 * Recovery arguments for the orphaned-metadata case. `forceObserved` is the
 * point of the instruction, so it is always present; the profile is added when
 * the caller knows it.
 */
function formatReconcileArgument(profileName: string | undefined): string {
  const entries = [
    ...(profileName ? [`profile: "${profileName}"`] : []),
    "forceObserved: true",
  ];
  return `{ ${entries.join(", ")} }`;
}

function describeActiveRun(summary: TaktSummary | undefined): string {
  const run = findObservedActiveRun(summary);
  if (!run) {
    return "";
  }
  const pid = run.pid !== undefined ? `, pid ${run.pid}` : "";
  return ` (run ${run.slug}, ${run.status}/${run.sessionStatus}${pid})`;
}

export interface ExternalSessionBlockInput {
  label: string;
  profileName?: string;
  summary?: TaktSummary;
}

/**
 * Actionable message for the "do not start a duplicate" guard. A live external
 * run and dead-but-unreconciled metadata need opposite operator reactions, so
 * they must not share one sentence.
 */
export function describeExternalSessionBlock(input: ExternalSessionBlockInput): string {
  const summary = input.summary;
  const status = summary?.status;
  if (!status) {
    return `TAKT summary is unavailable for ${input.label}`;
  }
  const detail = describeActiveRun(summary);
  if (status === "live") {
    // The bridge only stops PTYs it owns; a live external pid must be stopped
    // where it was started, so `takt_stop` is the wrong instruction here.
    return `TAKT is already running in ${input.label}${detail}; the bridge does not own that process, so stop it in the terminal or process that started it before starting another run.`;
  }
  return `TAKT has unreconciled ${status} running metadata in ${input.label}${detail} and no live owner process is recorded; nothing is running. Reconcile it with takt_stop ${formatReconcileArgument(input.profileName)}, then retry.`;
}
