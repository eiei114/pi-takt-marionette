import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  classifyRunStatus,
  classifySessionStatus,
  deriveSummarySessionStatus,
  parseRunMeta,
  readRunSnapshots,
  readTaktSummary,
  reconcileRunAsAborted,
  resolveCommand,
  snapshotRun,
  usesWindowsShell,
} = await import("../lib/takt-state.ts");
const { hasRecentTaktSummaryActivity } = await import("../lib/takt-types.ts");

const validMeta = {
  task: "Add the bridge",
  workflow: "default",
  runSlug: "add-the-bridge",
  runRoot: ".takt/runs/add-the-bridge",
  reportDirectory: ".takt/runs/add-the-bridge/reports",
  contextDirectory: ".takt/runs/add-the-bridge/context",
  logsDirectory: ".takt/runs/add-the-bridge/logs",
  status: "running",
  startTime: "2026-08-13T00:00:00.000Z",
  currentStep: "implement",
  updatedAt: "2026-08-13T00:01:00.000Z",
};

test("parseRunMeta accepts TAKT metadata and rejects incomplete records", () => {
  const parsed = parseRunMeta(validMeta);
  assert.equal(parsed?.runSlug, "add-the-bridge");
  assert.equal(parsed?.currentStep, "implement");
  assert.equal(parseRunMeta({ ...validMeta, status: "unknown" }), undefined);
  assert.equal(parseRunMeta({ task: "missing required fields" }), undefined);
});

test("classifyRunStatus marks a running record stale only with a dead owner pid", () => {
  assert.equal(classifyRunStatus({ status: "completed" }), "completed");
  assert.equal(classifyRunStatus({ status: "running" }), "running");
  assert.equal(classifyRunStatus({ status: "running" }, 0), "stale");
});

test("classifySessionStatus distinguishes live, stale, completed, and unknown", () => {
  assert.equal(classifySessionStatus({ status: "running", pid: process.pid }), "live");
  assert.equal(classifySessionStatus({ status: "running", pid: 0 }), "stale");
  assert.equal(classifySessionStatus({ status: "running" }), "unknown");
  assert.equal(classifySessionStatus({ status: "completed" }), "completed");
});

test("summary lifecycle status preserves all four observable states", () => {
  assert.equal(deriveSummarySessionStatus([{ sessionStatus: "live" }]), "live");
  assert.equal(deriveSummarySessionStatus([{ sessionStatus: "stale" }]), "stale");
  assert.equal(deriveSummarySessionStatus([{ sessionStatus: "completed" }]), "completed");
  assert.equal(deriveSummarySessionStatus([{ sessionStatus: "unknown" }]), "unknown");
});

test("snapshotRun exposes pid, stage, and last exit alongside lifecycle status", () => {
  const meta = parseRunMeta({
    ...validMeta,
    pid: 0,
    stage: "running",
    lastExit: { code: 17, signal: 2 },
    status: "completed",
  });

  assert.equal(meta?.stage, "running");
  const snapshot = snapshotRun(meta);
  assert.equal(snapshot.sessionStatus, "completed");
  assert.equal(snapshot.stage, "running");
  assert.equal(snapshot.endTime, undefined);
  assert.deepEqual(snapshot.lastExit, { code: 17, signal: 2 });
});

test("observed activity remains visible while fresh and hides after the inactivity TTL", () => {
  const now = Date.parse("2026-08-14T01:00:00.000Z");
  const summary = {
    cwd: "/repo",
    status: "completed",
    running: 0,
    pending: 1,
    blocked: 0,
    failed: 0,
    completed: 0,
    stale: 0,
    activityAt: "2026-08-14T00:45:00.000Z",
    runs: [],
  };

  assert.equal(hasRecentTaktSummaryActivity(summary, now, 30 * 60 * 1_000), true);
  assert.equal(hasRecentTaktSummaryActivity(summary, now + 15 * 60 * 1_000, 30 * 60 * 1_000), false);
});

test("run snapshots carry the workflow source layer from bundle manifests", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-state-source-"));
  const runs = join(cwd, ".takt", "runs");
  mkdirSync(join(runs, "builtin-run"), { recursive: true });
  mkdirSync(join(runs, "project-run"), { recursive: true });
  writeWorkflowBundle(cwd, "builtin-run", ["plan", "review"], `builtin:sha256:${"c".repeat(64)}`);
  writeWorkflowBundle(cwd, "project-run", ["plan"], `project:sha256:${"d".repeat(64)}`);
  writeFileSync(join(runs, "builtin-run", "meta.json"), JSON.stringify({ ...validMeta, runSlug: "builtin-run", workflow: "dual" }));
  writeFileSync(join(runs, "project-run", "meta.json"), JSON.stringify({ ...validMeta, runSlug: "project-run", workflow: "custom-flow" }));

  const snapshots = readRunSnapshots(cwd);
  const bySlug = new Map(snapshots.map((run) => [run.slug, run]));
  assert.equal(bySlug.get("builtin-run")?.workflowSource, "builtin");
  assert.deepEqual(bySlug.get("builtin-run")?.workflowSteps, ["plan", "review"]);
  assert.equal(bySlug.get("project-run")?.workflowSource, "project");
});

// Legacy manifests without an opaque ref (plain name only) must stay unmarked.
test("run snapshots omit the workflow source when the manifest has no opaque ref", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-state-legacy-"));
  const runs = join(cwd, ".takt", "runs");
  mkdirSync(join(runs, "legacy"), { recursive: true });
  writeWorkflowBundle(cwd, "legacy", ["plan"]);
  writeFileSync(join(runs, "legacy", "meta.json"), JSON.stringify({ ...validMeta, runSlug: "legacy" }));

  const snapshots = readRunSnapshots(cwd);
  assert.equal(snapshots[0]?.workflowSource, undefined);
  assert.deepEqual(snapshots[0]?.workflowSteps, ["plan"]);
});

function writeWorkflowBundle(cwd, slug, steps, originalWorkflowRef = "default") {
  const bundleRoot = join(cwd, ".takt", "runs", slug, "workflow-bundle");
  const nodeId = "a".repeat(64);
  const objectHash = "b".repeat(64);
  mkdirSync(join(bundleRoot, "objects"), { recursive: true });
  writeFileSync(join(bundleRoot, "manifest.json"), JSON.stringify({
    version: 1,
    root: { nodeId, workflowName: "default", originalWorkflowRef },
    nodes: { [nodeId]: objectHash },
    resources: {},
  }), "utf8");
  writeFileSync(join(bundleRoot, "objects", `${objectHash}.json`), JSON.stringify({
    version: 1,
    nodeId,
    originalWorkflowRef: "default",
    binding: {},
    config: { name: "default", steps: steps.map((name) => ({ name })) },
    calls: [],
  }), "utf8");
}

test("readRunSnapshots ignores partial metadata and preserves active-first ordering", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-state-"));
  const runs = join(cwd, ".takt", "runs");
  mkdirSync(join(runs, "active"), { recursive: true });
  mkdirSync(join(runs, "done"), { recursive: true });
  mkdirSync(join(runs, "partial"), { recursive: true });
  writeWorkflowBundle(cwd, "active", ["plan", "implement", "review"]);
  writeFileSync(join(runs, "active", "meta.json"), JSON.stringify({ ...validMeta, runSlug: "active" }));
  writeFileSync(
    join(runs, "done", "meta.json"),
    JSON.stringify({ ...validMeta, runSlug: "done", status: "completed", endTime: validMeta.updatedAt }),
  );
  writeFileSync(join(runs, "partial", "meta.json"), "{");

  const snapshots = readRunSnapshots(cwd);
  assert.deepEqual(snapshots.map((run) => run.slug), ["active", "done"]);
  assert.equal(snapshots[0].status, "running");
  assert.deepEqual(snapshots[0].workflowSteps, ["plan", "implement", "review"]);
});

test("readRunSnapshots discovers active runs inside TAKT-managed clones", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-clone-state-"));
  const clone = mkdtempSync(join(tmpdir(), "pi-takt-bridge-managed-clone-"));
  const cloneMeta = join(cwd, ".takt", "clone-meta");
  const runDirectory = join(clone, ".takt", "runs", "clone-run");
  mkdirSync(cloneMeta, { recursive: true });
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(
    join(cloneMeta, "feature.json"),
    JSON.stringify({ branch: "feature/demo", clonePath: clone }),
    "utf8",
  );
  writeFileSync(join(runDirectory, "meta.json"), JSON.stringify({
    ...validMeta,
    runSlug: "clone-run",
    runRoot: runDirectory,
    reportDirectory: join(runDirectory, "reports"),
    contextDirectory: join(runDirectory, "context"),
    logsDirectory: join(runDirectory, "logs"),
    ownerPid: process.pid,
  }), "utf8");

  const snapshots = readRunSnapshots(cwd);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].slug, "clone-run");
  assert.equal(snapshots[0].status, "running");
  assert.equal(snapshots[0].sessionStatus, "live");
  assert.equal(snapshots[0].pid, process.pid);
  assert.equal(snapshots[0].workspace, clone);
});

test("readRunSnapshots prefers an active clone run over a historical root collision", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-clone-collision-"));
  const clone = mkdtempSync(join(tmpdir(), "pi-takt-bridge-collision-clone-"));
  const cloneMeta = join(cwd, ".takt", "clone-meta");
  const rootRun = join(cwd, ".takt", "runs", "shared-run");
  const cloneRun = join(clone, ".takt", "runs", "shared-run");
  mkdirSync(cloneMeta, { recursive: true });
  mkdirSync(rootRun, { recursive: true });
  mkdirSync(cloneRun, { recursive: true });
  writeFileSync(join(cloneMeta, "feature.json"), JSON.stringify({ clonePath: clone }), "utf8");
  writeFileSync(join(rootRun, "meta.json"), JSON.stringify({
    ...validMeta,
    runSlug: "shared-run",
    runRoot: rootRun,
    reportDirectory: join(rootRun, "reports"),
    contextDirectory: join(rootRun, "context"),
    logsDirectory: join(rootRun, "logs"),
    status: "completed",
    endTime: "2026-08-13T00:02:00.000Z",
  }), "utf8");
  writeFileSync(join(cloneRun, "meta.json"), JSON.stringify({
    ...validMeta,
    runSlug: "shared-run",
    runRoot: cloneRun,
    reportDirectory: join(cloneRun, "reports"),
    contextDirectory: join(cloneRun, "context"),
    logsDirectory: join(cloneRun, "logs"),
    ownerPid: process.pid,
  }), "utf8");

  const snapshots = readRunSnapshots(cwd);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].status, "running");
  assert.equal(snapshots[0].workspace, clone);
});

test("reconcileRunAsAborted atomically closes running metadata and preserves checkpoints", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-reconcile-"));
  const runDirectory = join(cwd, ".takt", "runs", "checkpointed");
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(join(runDirectory, "meta.json"), JSON.stringify({
    ...validMeta,
    runSlug: "checkpointed",
    resume_point: { step: "review", iteration: 15 },
  }), "utf8");

  const now = new Date("2026-08-15T10:17:21.000Z");
  assert.deepEqual(reconcileRunAsAborted(cwd, "checkpointed", "operator stop", now), {
    runSlug: "checkpointed",
    reconciled: true,
  });
  const saved = JSON.parse(readFileSync(join(runDirectory, "meta.json"), "utf8"));
  assert.equal(saved.status, "aborted");
  assert.equal(saved.endTime, now.toISOString());
  assert.equal(saved.failure.step, "implement");
  assert.deepEqual(saved.resume_point, { step: "review", iteration: 15 });
  assert.equal(reconcileRunAsAborted(cwd, "checkpointed", "again").reconciled, false);
});

function createTaskListCommand(directory, output, exitCode = 0) {
  if (process.platform === "win32") {
    const command = join(directory, `task-list-${exitCode}.cmd`);
    writeFileSync(command, `@echo off\r\n@echo ${output}\r\n@exit /b ${exitCode}\r\n`, "utf8");
    return command;
  }
  const command = join(directory, `task-list-${exitCode}.sh`);
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`, "utf8");
  chmodSync(command, 0o755);
  return command;
}

test("readTaktSummary uses TAKT_COMMAND and preserves live task metadata", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-command-"));
  const command = createTaskListCommand(cwd, JSON.stringify({
    tasks: [{ kind: "running", ownerPid: process.pid, stage: "external-stage" }],
  }));
  const previousCommand = process.env.TAKT_COMMAND;
  process.env.TAKT_COMMAND = command;
  try {
    const summary = await readTaktSummary(cwd, { includeTaskList: true });
    assert.equal(summary.status, "live");
    assert.equal(summary.pid, process.pid);
    assert.equal(summary.stage, "external-stage");
  } finally {
    if (previousCommand === undefined) {
      delete process.env.TAKT_COMMAND;
    } else {
      process.env.TAKT_COMMAND = previousCommand;
    }
  }
});

test("readTaktSummary records pending task creation as observed activity", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-pending-age-"));
  const command = createTaskListCommand(cwd, JSON.stringify({
    tasks: [{
      kind: "pending",
      name: "old-task",
      createdAt: "2026-08-14T00:30:00.000Z",
    }],
  }));

  const summary = await readTaktSummary(cwd, { command, includeTaskList: true });
  assert.equal(summary.pending, 1);
  assert.equal(summary.activityAt, "2026-08-14T00:30:00.000Z");
});

test("readTaktSummary surfaces task-list command failures", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-command-error-"));
  const command = createTaskListCommand(cwd, "unavailable", 7);
  await assert.rejects(
    () => readTaktSummary(cwd, { command, includeTaskList: true }),
    /TAKT task list failed \(exit 7\)/,
  );

  const runOnlySummary = await readTaktSummary(cwd, { command, includeTaskList: false });
  assert.equal(runOnlySummary.status, "unknown");
  assert.equal(runOnlySummary.pending, 0);
});

test("readTaktSummary can omit the task list for background run-state polling", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-run-only-"));
  const command = createTaskListCommand(cwd, "unavailable", 7);
  const summary = await readTaktSummary(cwd, { command, includeTaskList: false });

  assert.equal(summary.status, "unknown");
  assert.equal(summary.running, 0);
  assert.equal(summary.pending, 0);
  assert.equal(summary.failed, 0);
});

test("resolveCommand uses npm shims on Windows without changing explicit paths", () => {
  const resolved = resolveCommand("takt");
  if (process.platform === "win32") {
    assert.equal(resolved, "takt.cmd");
  } else {
    assert.equal(resolved, "takt");
  }
  assert.match(resolveCommand("C:/tools/takt"), /C:\/tools\/takt$/);
  assert.equal(usesWindowsShell("takt.cmd"), process.platform === "win32");
});

test("readRunPhaseProgress counts live phases and workers from the log tail", async () => {
  const { readRunPhaseProgress } = await import("../lib/takt-state.ts");
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-phase-log-"));
  const slug = "20260822-run";
  const logsDirectory = join(cwd, ".takt", "runs", slug, "logs");
  mkdirSync(logsDirectory, { recursive: true });
  const events = [
    { type: "workflow_start" },
    { type: "step_start", step: "plan" },
    { type: "phase_start", phaseExecutionId: "old-1", phaseName: "execute" },
    { type: "step_start", step: "implement" },
    { type: "phase_start", phaseExecutionId: "w1:a", phaseName: "worker-1" },
    { type: "phase_start", phaseExecutionId: "w2:a", phaseName: "worker-2" },
    { type: "phase_complete", phaseExecutionId: "w1:a", phaseName: "worker-1" },
    { type: "phase_judge_stage", phaseExecutionId: "w2:a", phaseName: "worker-2" },
  ];
  writeFileSync(join(logsDirectory, "run.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"), "utf8");

  const progress = readRunPhaseProgress(cwd, slug);
  assert.equal(progress?.started, 2);
  assert.equal(progress?.completed, 1);
  assert.deepEqual(progress?.workers, { done: 1, total: 2 });

  // A run without any log file yields nothing.
  assert.equal(readRunPhaseProgress(cwd, "missing-slug"), undefined);
});

test("readRunLogDiagnostics summarizes step, phase, workers, and sanitized errors", async () => {
  const { readRunLogDiagnostics, sanitizeLogExcerpt } = await import("../lib/takt-state.ts");
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-log-diag-"));
  const slug = "20260831-run";
  const logsDirectory = join(cwd, ".takt", "runs", slug, "logs");
  mkdirSync(logsDirectory, { recursive: true });
  const events = [
    { type: "workflow_start", timestamp: "2026-08-31T01:00:00.000Z" },
    { type: "step_start", step: "implement" },
    { type: "phase_start", phaseExecutionId: "w1:a", phaseName: "worker-1" },
    { type: "phase_start", phaseExecutionId: "w2:a", phaseName: "worker-2" },
    { type: "phase_complete", phaseExecutionId: "w1:a", phaseName: "worker-1" },
    { type: "step_failed", step: "implement", error: "provider\r\nunavailable" },
  ];
  writeFileSync(join(logsDirectory, "run.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"), "utf8");

  const diagnostics = readRunLogDiagnostics(cwd, slug);
  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.step, "implement");
  assert.equal(diagnostics.eventType, "step_failed");
  assert.deepEqual(diagnostics.workers, { done: 1, total: 2 });
  assert.equal(diagnostics.message, "provider unavailable");

  assert.equal(
    sanitizeLogExcerpt("\u001b[31mfail\u001b[0m\nline", 40),
    "fail line",
  );
});

test("readRunLogDiagnostics returns unavailable reasons without throwing", async () => {
  const { readRunLogDiagnostics } = await import("../lib/takt-state.ts");
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-log-diag-missing-"));

  assert.deepEqual(readRunLogDiagnostics(cwd, "missing-slug"), {
    available: false,
    reason: "no_logs",
  });

  const slug = "partial-log";
  const logsDirectory = join(cwd, ".takt", "runs", slug, "logs");
  mkdirSync(logsDirectory, { recursive: true });
  writeFileSync(
    join(logsDirectory, "run.jsonl"),
    ["partial line without brace", '{"type":"workflow_start"}', "{not json"].join("\n"),
    "utf8",
  );
  const diagnostics = readRunLogDiagnostics(cwd, slug);
  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.eventType, "workflow_start");
  assert.equal(diagnostics.skippedLines, 2);
});

test("readRunLogDiagnostics ignores non-object JSONL records and partial tail lines", async () => {
  const { readRunLogDiagnostics } = await import("../lib/takt-state.ts");
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-log-diag-tail-"));
  const slug = "tail-run";
  const logsDirectory = join(cwd, ".takt", "runs", slug, "logs");
  mkdirSync(logsDirectory, { recursive: true });
  const body = [
    '{"type":"step_start","step":"plan"}',
    '{"type":"phase_start","phaseExecutionId":"p1","phaseName":"execute"}',
  ].join("\n");
  const padded = `${"x".repeat(70 * 1024)}\n${body}`;
  writeFileSync(join(logsDirectory, "run.jsonl"), padded, "utf8");

  const diagnostics = readRunLogDiagnostics(cwd, slug);
  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.step, "plan");
  assert.equal(diagnostics.phase, "execute");
});

test("readRunSnapshots attaches logDiagnostics for running and failed runs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-log-diag-snap-"));
  const slug = "active-run";
  const runDirectory = join(cwd, ".takt", "runs", slug);
  const logsDirectory = join(runDirectory, "logs");
  mkdirSync(logsDirectory, { recursive: true });
  writeFileSync(
    join(runDirectory, "meta.json"),
    JSON.stringify({
      task: "Ship diagnostics",
      workflow: "default",
      runSlug: slug,
      runRoot: runDirectory,
      reportDirectory: join(runDirectory, "reports"),
      contextDirectory: join(runDirectory, "context"),
      logsDirectory,
      status: "running",
      startTime: "2026-08-31T01:00:00.000Z",
      currentStep: "implement",
    }),
    "utf8",
  );
  writeFileSync(
    join(logsDirectory, "run.jsonl"),
    [
      '{"type":"step_start","step":"implement"}',
      '{"type":"phase_start","phaseExecutionId":"p1","phaseName":"execute"}',
    ].join("\n"),
    "utf8",
  );

  const snapshots = readRunSnapshots(cwd);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].logDiagnostics?.available, true);
  assert.equal(snapshots[0].logDiagnostics?.step, "implement");
});
