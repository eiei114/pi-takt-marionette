import assert from "node:assert/strict";
import test from "node:test";

const {
  buildEnqueuePrompt,
  extractEnqueuedWorkflow,
  extractWorkflowDirective,
  normalizeAcpUpdate,
  verifyEnqueueWorkflow,
} = await import("../lib/takt-acp-client.ts");

test("enqueue uses TAKT's ACP /go task instruction", () => {
  assert.equal(buildEnqueuePrompt("  Add a status widget  "), "/go Add a status widget");
});

test("ACP message updates are normalized without parsing stdout", () => {
  const message = normalizeAcpUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Task queued" },
    },
  });
  assert.deepEqual(message, {
    sessionId: "session-1",
    kind: "agent_message_chunk",
    text: "Task queued",
  });

  const tool = normalizeAcpUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    },
  });
  assert.equal(tool.status, "completed");
});

test("ACP workflow verification compares the planner directive with TAKT's persisted result", () => {
  const task = [
    "## Goal",
    "Implement the catalog",
    "## Constraints",
    "- workflow: development-core",
  ].join("\n");
  const result = {
    sessionId: "session-1",
    stopReason: "end_turn",
    messages: ["Task added to the TAKT queue.", "status: pending", "workflow: development-core"],
  };

  assert.equal(extractWorkflowDirective(task), "development-core");
  assert.equal(extractEnqueuedWorkflow(result.messages), "development-core");
  assert.deepEqual(verifyEnqueueWorkflow(task, result), {
    ...result,
    workflow: "development-core",
    expectedWorkflow: "development-core",
    workflowVerified: true,
  });
});

test("ACP workflow verification fails closed while preserving the pending task", () => {
  const task = "## Constraints\n- workflow: review";
  const base = {
    sessionId: "session-1",
    stopReason: "end_turn",
    messages: ["Task added to the TAKT queue.", "status: pending", "workflow: default"],
  };
  assert.throws(
    () => verifyEnqueueWorkflow(task, base),
    /workflow mismatch.*requested review, persisted default.*pending task was preserved/i,
  );
  assert.throws(
    () => verifyEnqueueWorkflow("no workflow directive", { ...base, messages: [] }),
    /must include an exact.*workflow/i,
  );
  assert.throws(
    () => verifyEnqueueWorkflow(task, { ...base, messages: ["Task added to the TAKT queue."] }),
    /did not report a workflow.*remains unverified/i,
  );
});
