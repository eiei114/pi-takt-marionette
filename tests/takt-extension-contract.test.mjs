import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import register from "../extensions/index.ts";

function loadTools(shortcuts = []) {
  const tools = new Map();
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on() {},
    registerCommand() {},
    registerShortcut(shortcut) {
      shortcuts.push(shortcut);
    },
  };
  register(pi);
  return tools;
}

test("fresh Pi runtime publishes all TAKT control tools and replace schema", () => {
  const shortcuts = [];
  const tools = loadTools(shortcuts);

  assert.deepEqual([...tools.keys()].sort(), [
    "takt_enqueue_task",
    "takt_exec_prompt",
    "takt_project_setup",
    "takt_read_screen",
    "takt_resume_run",
    "takt_run_pending",
    "takt_run_workflow",
    "takt_send_input",
    "takt_set_mode",
    "takt_stop",
    "takt_submit_go",
    "takt_workflow_catalog",
  ]);
  assert.equal(tools.get("takt_exec_prompt").parameters.properties.replace.type, "boolean");
  assert.equal(tools.get("takt_run_workflow").parameters.properties.workflow.type, "string");
  assert.equal(tools.get("takt_run_workflow").parameters.properties.prNumber.type, "integer");
  assert.equal(tools.get("takt_run_workflow").parameters.properties.extensions.type, "array");
  assert.equal(tools.get("takt_run_workflow").parameters.properties.pipeline.type, "boolean");
  assert.ok(tools.get("takt_exec_prompt").parameters.properties.goMode.anyOf);
  assert.equal(tools.get("takt_stop").parameters.properties.forceObserved.type, "boolean");
  assert.equal(tools.get("takt_resume_run").parameters.properties.model.type, "string");
  assert.equal(tools.get("takt_project_setup").parameters.properties.cwd.type, "string");
  assert.equal(tools.get("takt_project_setup").parameters.properties.copyGlobalPreset.type, "boolean");
  assert.ok(shortcuts.includes("ctrl+alt+t"));
  assert.ok(shortcuts.includes("f6"));
  assert.equal(tools.get("takt_run_pending").parameters.properties.profile.type, "string");
  assert.equal(tools.get("takt_workflow_catalog").parameters.properties.query.type, "string");
});

test("fresh Pi loader exposes the executable tool schema", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-takt-bridge-pi-runtime-"));
  const loaded = await discoverAndLoadExtensions(["./extensions/index.ts"], process.cwd(), agentDir);

  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const tools = loaded.extensions[0].tools;
  assert.deepEqual([...tools.keys()].sort(), [
    "takt_enqueue_task",
    "takt_exec_prompt",
    "takt_project_setup",
    "takt_read_screen",
    "takt_resume_run",
    "takt_run_pending",
    "takt_run_workflow",
    "takt_send_input",
    "takt_set_mode",
    "takt_stop",
    "takt_submit_go",
    "takt_workflow_catalog",
  ]);
  const execTool = tools.get("takt_exec_prompt").definition;
  assert.equal(execTool.parameters.type, "object");
  assert.equal(execTool.parameters.properties.replace.type, "boolean");
  assert.ok(execTool.parameters.properties.goMode.anyOf);
  assert.ok(execTool.parameters.required.includes("prompt"));
  const workflowTool = tools.get("takt_run_workflow").definition;
  assert.equal(workflowTool.parameters.required.includes("task"), false);
  assert.equal(workflowTool.parameters.required.includes("prNumber"), false);
  assert.ok(workflowTool.parameters.required.includes("workflow"));
  const setupTool = tools.get("takt_project_setup").definition;
  assert.equal(setupTool.parameters.properties.cwd.type, "string");
  assert.equal(setupTool.parameters.properties.copyGlobalPreset.type, "boolean");
  const enqueueTool = tools.get("takt_enqueue_task").definition;
  assert.equal(enqueueTool.parameters.type, "object");
  assert.ok(enqueueTool.parameters.required.includes("task"));
  assert.ok(enqueueTool.parameters.required.includes("worktree"));
  assert.ok(enqueueTool.parameters.required.includes("prMode"));
  assert.equal(enqueueTool.parameters.properties.profile.type, "string");
  assert.equal(enqueueTool.parameters.properties.worktree.type, "boolean");
  assert.ok(enqueueTool.parameters.properties.prMode.anyOf);
});

test("a second fresh extension registration publishes the same tool contract", () => {
  const first = loadTools();
  const second = loadTools();

  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
  assert.deepEqual(
    second.get("takt_exec_prompt").parameters.properties.replace,
    first.get("takt_exec_prompt").parameters.properties.replace,
  );
});
