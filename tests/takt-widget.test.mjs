import assert from "node:assert/strict";
import test from "node:test";

const { renderTaktDetails, renderTaktWidget } = await import("../lib/takt-widget.ts");

const summary = {
  cwd: "C:/workspace",
  status: "live",
  running: 2,
  pending: 3,
  blocked: 1,
  failed: 0,
  completed: 2,
  stale: 0,
  runs: [
    { slug: "one", task: "Implement ACP bridge", workflow: "default", status: "running", sessionStatus: "live", currentStep: "tests" },
    { slug: "two", task: "Update docs", workflow: "default", status: "running", sessionStatus: "live" },
  ],
};

test("widget renders a compact multi-run summary", () => {
  assert.deepEqual(renderTaktWidget(summary), [
    "TAKT ● 2 running · 3 pending · 1 blocked",
    "↳ live: Implement ACP bridge · tests",
    "↳ live: Update docs",
  ]);
});

test("status details include workflow progress when metadata exposes a current step", () => {
  const lines = renderTaktDetails({
    ...summary,
    runs: [{
      ...summary.runs[0],
      workflowSteps: ["plan", "tests", "review"],
      phase: 2,
      currentIteration: 1,
    }],
  });

  assert.ok(lines.some((line) => /\[[#]*>/.test(line)));
  assert.ok(lines.some((line) => line.includes("2/3 step: tests")));
});

test("workflow rows show their resolved source layer", () => {
  const builtin = renderTaktDetails({
    ...summary,
    runs: [{ ...summary.runs[0], workflow: "dual", workflowSource: "builtin" }],
  });
  assert.ok(builtin.some((line) => line.includes("flow dual · builtin")));

  const project = renderTaktDetails({
    ...summary,
    runs: [{ ...summary.runs[0], workflow: "dual", workflowSource: "project" }],
  });
  assert.ok(project.some((line) => line.includes("flow dual ")));
  assert.ok(project.some((line) => line.includes("flow dual · project")));
});

test("idle widget is cleared and details remain available", () => {
  const idle = { ...summary, running: 0, pending: 0, blocked: 0, failed: 0, stale: 0, runs: [] };
  assert.equal(renderTaktWidget(idle), undefined);
  assert.deepEqual(renderTaktDetails(idle).slice(0, 7), [
    "TAKT status",
    "project: C:/workspace",
    "running: 0",
    "pending: 0",
    "blocked: 0",
    "failed: 0",
    "completed: 2",
  ]);
});

test("widget reports failures without embedding controls", () => {
  const failed = {
    ...summary,
    running: 0,
    pending: 0,
    blocked: 0,
    failed: 1,
    stale: 1,
    status: "stale",
    lastError: "provider unavailable",
    runs: [{ slug: "bad", task: "Retry me", workflow: "default", status: "stale", sessionStatus: "stale" }],
  };
  const lines = renderTaktWidget(failed);
  assert.equal(lines[0], "TAKT ⚠ 0 running · 0 pending · 0 blocked");
  assert.match(lines.at(-1), /provider unavailable/);
  assert.ok(lines.every((line) => !line.includes("Enter") && !line.includes("retry")));
});

test("status details render bounded log diagnostics for active runs", () => {
  const lines = renderTaktDetails({
    ...summary,
    runs: [{
      ...summary.runs[0],
      status: "running",
      logDiagnostics: {
        available: true,
        step: "implement",
        phase: "execute",
        workers: { done: 1, total: 2 },
        eventType: "phase_start",
      },
    }],
  });

  assert.ok(lines.some((line) => line.startsWith("log details: step implement")));
  assert.ok(lines.some((line) => line.includes("workers 1/2")));
});

test("status details show sanitized error excerpts and unavailable log reasons", () => {
  const failed = renderTaktDetails({
    ...summary,
    runs: [{
      ...summary.runs[0],
      status: "failed",
      logDiagnostics: {
        available: true,
        eventType: "step_failed",
        message: "provider unavailable",
      },
    }],
  });
  assert.ok(failed.some((line) => line.includes("log details:") && line.includes("error: provider unavailable")));

  const missing = renderTaktDetails({
    ...summary,
    runs: [{
      ...summary.runs[0],
      status: "stale",
      logDiagnostics: { available: false, reason: "no_logs" },
    }],
  });
  assert.ok(missing.some((line) => line.includes("log details: no logs")));
});

test("widget stays summary-only and does not render log details", () => {
  const withDiagnostics = {
    ...summary,
    runs: [{
      ...summary.runs[0],
      logDiagnostics: {
        available: true,
        step: "implement",
        message: "secret should not appear in widget",
      },
    }],
  };
  const lines = renderTaktWidget(withDiagnostics);
  assert.ok(lines.every((line) => !line.includes("log details")));
  assert.ok(lines.every((line) => !line.includes("secret should not appear")));
});
