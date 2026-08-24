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
