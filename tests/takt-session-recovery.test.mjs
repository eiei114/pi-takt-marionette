import assert from "node:assert/strict";
import test from "node:test";

const {
  describeExternalSessionBlock,
  findObservedActiveRun,
  isUnaccountedRunningMetadata,
  resolveProjectSessionSnapshot,
  resolveStopProjectId,
} = await import("../lib/takt-session-recovery.ts");

const NOW = Date.parse("2026-09-12T05:00:00.000Z");
const FRESH = "2026-09-12T04:59:00.000Z";
const STALE_ACTIVITY = "2026-09-12T03:00:00.000Z";

function summary(overrides = {}) {
  return {
    cwd: "C:/project",
    status: "completed",
    running: 0,
    pending: 0,
    blocked: 0,
    failed: 0,
    completed: 0,
    stale: 0,
    runs: [],
    ...overrides,
  };
}

function runningRun(overrides = {}) {
  return {
    slug: "killed-run",
    task: "implement",
    workflow: "takt-default",
    status: "running",
    sessionStatus: "unknown",
    ...overrides,
  };
}

test("unaccounted running metadata needs fresh activity and no live owner", () => {
  const fresh = summary({ status: "unknown", running: 1, activityAt: FRESH, runs: [runningRun()] });
  assert.equal(isUnaccountedRunningMetadata(fresh, NOW), true);

  const quiet = summary({ status: "unknown", running: 1, activityAt: STALE_ACTIVITY, runs: [runningRun()] });
  assert.equal(isUnaccountedRunningMetadata(quiet, NOW), false);

  const live = summary({ status: "live", running: 1, activityAt: FRESH, runs: [runningRun({ sessionStatus: "live", pid: process.pid })] });
  assert.equal(isUnaccountedRunningMetadata(live, NOW), false);

  assert.equal(isUnaccountedRunningMetadata(undefined, NOW), false);
});

test("finished bridge stage no longer hides fresh unaccounted running metadata", () => {
  const observed = summary({ status: "unknown", running: 1, activityAt: FRESH, runs: [runningRun()] });
  const snapshot = resolveProjectSessionSnapshot({
    stage: "completed",
    stageIsTerminal: true,
    runnerRunning: false,
    runnerStatus: "completed",
    runnerPid: 46204,
    runnerLastExit: { code: 0, signal: 0 },
    observed,
    now: NOW,
  });

  assert.equal(snapshot.status, "unknown");
  assert.equal(snapshot.ownership, "observed");
  assert.equal(snapshot.observedRun?.slug, "killed-run");
});

test("terminal bridge stage stays completed without unaccounted metadata", () => {
  const snapshot = resolveProjectSessionSnapshot({
    stage: "completed",
    stageIsTerminal: true,
    runnerRunning: false,
    runnerStatus: "completed",
    runnerPid: 46204,
    runnerLastExit: { code: 0, signal: 0 },
    observed: summary({ status: "completed", running: 0, runs: [] }),
    now: NOW,
  });

  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.ownership, "bridge");
});

test("quiet orphaned metadata does not pin the project to unknown", () => {
  const snapshot = resolveProjectSessionSnapshot({
    stage: "completed",
    stageIsTerminal: true,
    runnerRunning: false,
    runnerStatus: "completed",
    runnerPid: 46204,
    runnerLastExit: { code: 0, signal: 0 },
    observed: summary({ status: "unknown", running: 1, activityAt: STALE_ACTIVITY, runs: [runningRun()] }),
    now: NOW,
  });

  assert.equal(snapshot.status, "completed");
});

test("a completed run does not refresh orphaned running metadata", () => {
  const summaryWithRecentCompletion = summary({
    status: "unknown",
    running: 1,
    activityAt: STALE_ACTIVITY,
    runs: [
      { slug: "done", task: "t", workflow: "w", status: "completed", sessionStatus: "completed", updatedAt: FRESH },
      runningRun(),
    ],
  });
  assert.equal(isUnaccountedRunningMetadata(summaryWithRecentCompletion, NOW), false);

  const summaryWithRecentActiveRun = summary({
    status: "unknown",
    running: 1,
    activityAt: STALE_ACTIVITY,
    runs: [runningRun({ updatedAt: FRESH })],
  });
  assert.equal(isUnaccountedRunningMetadata(summaryWithRecentActiveRun, NOW), true);
});

test("terminal bridge stage does not mask an observed live run", () => {
  const snapshot = resolveProjectSessionSnapshot({
    stage: "completed",
    stageIsTerminal: true,
    runnerRunning: false,
    runnerStatus: "completed",
    runnerPid: 46204,
    runnerLastExit: { code: 0, signal: 0 },
    observed: summary({
      status: "live",
      running: 1,
      stage: "external-stage",
      pid: 4242,
      activityAt: FRESH,
      runs: [runningRun({ sessionStatus: "live", pid: 4242 })],
    }),
    now: NOW,
  });

  assert.equal(snapshot.status, "live");
  assert.equal(snapshot.ownership, "observed");
  assert.equal(snapshot.stage, "external-stage");
  assert.equal(snapshot.pid, 4242);
  assert.equal(snapshot.observedRun?.slug, "killed-run");
});

test("observed live run keeps its own stage and reports observed ownership", () => {
  const snapshot = resolveProjectSessionSnapshot({
    stage: "idle",
    stageIsTerminal: false,
    runnerRunning: false,
    runnerStatus: "idle",
    observed: summary({
      status: "live",
      running: 1,
      stage: "external-stage",
      pid: 4242,
      activityAt: FRESH,
      runs: [runningRun({ sessionStatus: "live", pid: 4242 })],
    }),
    now: NOW,
  });

  assert.equal(snapshot.status, "live");
  assert.equal(snapshot.ownership, "observed");
  assert.equal(snapshot.stage, "external-stage");
  assert.equal(snapshot.pid, 4242);
});

test("bridge-owned runner wins and stays bridge-owned", () => {
  const snapshot = resolveProjectSessionSnapshot({
    stage: "running",
    stageIsTerminal: false,
    runnerRunning: true,
    runnerStatus: "running",
    runnerPid: 111,
    observed: summary({ status: "unknown", running: 1, activityAt: FRESH, runs: [runningRun()] }),
    now: NOW,
  });

  assert.equal(snapshot.status, "live");
  assert.equal(snapshot.ownership, "bridge");
  assert.equal(snapshot.pid, 111);
  assert.equal(snapshot.observedRun?.slug, "killed-run");
});

test("stop resolution prefers explicit target, then bridge-owned, then observed", () => {
  assert.equal(resolveStopProjectId({
    requestedId: "explicit",
    activeRunningId: "bridge",
    observedId: "observed",
    forceObserved: true,
  }), "explicit");

  assert.equal(resolveStopProjectId({
    activeRunningId: "bridge",
    observedId: "observed",
    forceObserved: true,
  }), "bridge");

  assert.equal(resolveStopProjectId({
    observedId: "observed",
    forceObserved: true,
  }), "observed");

  assert.equal(resolveStopProjectId({
    observedId: "observed",
    forceObserved: false,
  }), undefined);
});

test("block messages separate a live external run from orphaned metadata", () => {
  const live = describeExternalSessionBlock({
    label: "takt",
    profileName: "takt",
    summary: summary({
      status: "live",
      running: 1,
      activityAt: FRESH,
      runs: [runningRun({ sessionStatus: "live", pid: 4242 })],
    }),
  });
  assert.match(live, /already running in takt/);
  assert.match(live, /pid 4242/);
  assert.match(live, /stop it in the terminal or process that started it/);
  assert.doesNotMatch(live, /takt_stop/);
  assert.doesNotMatch(live, /forceObserved/);

  const orphaned = describeExternalSessionBlock({
    label: "takt",
    profileName: "takt",
    summary: summary({ status: "unknown", running: 1, activityAt: FRESH, runs: [runningRun()] }),
  });
  assert.match(orphaned, /unreconciled unknown running metadata/);
  assert.match(orphaned, /nothing is running/);
  assert.match(orphaned, /forceObserved: true/);

  assert.equal(
    describeExternalSessionBlock({ label: "takt" }),
    "TAKT summary is unavailable for takt",
  );
});

test("findObservedActiveRun returns the first active or stale run", () => {
  const found = findObservedActiveRun(summary({
    status: "unknown",
    running: 1,
    activityAt: FRESH,
    runs: [
      { slug: "done", task: "t", workflow: "w", status: "completed", sessionStatus: "completed" },
      runningRun(),
    ],
  }));
  assert.equal(found?.slug, "killed-run");
  assert.equal(findObservedActiveRun(summary({ runs: [] })), undefined);
});
