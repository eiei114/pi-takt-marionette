import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const {
  TaktTaskQueue,
  extractBranchDirective,
  extractWorkflowDirective,
} = await import("../lib/takt-task-queue.ts");

const noPrPolicy = { worktree: true, prMode: "none" };

function temporaryProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-direct-queue-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("direct queue writes tasks.yaml and order.md without a protocol subprocess", async () => {
  const project = temporaryProject();
  try {
    const task = [
      "workflow: review-fix",
      "branch: takt/fix-review",
      "",
      "# Fix review feedback",
      "",
      "Preserve this body exactly.",
    ].join("\n");
    const result = await new TaktTaskQueue({ cwd: project.cwd }).enqueue(task, noPrPolicy);
    const state = parseYaml(readFileSync(result.tasksFile, "utf8"));
    const saved = state.tasks.at(-1);

    assert.equal(extractWorkflowDirective(task), "review-fix");
    assert.equal(extractBranchDirective(task), "takt/fix-review");
    assert.equal(result.workflowVerified, true);
    assert.equal(result.status, "pending");
    assert.equal(saved.workflow, "review-fix");
    assert.equal(saved.branch, "takt/fix-review");
    assert.equal(saved.worktree, true);
    assert.equal(saved.auto_pr, false);
    assert.equal(saved.draft_pr, false);
    assert.deepEqual(result.executionOptions, {
      worktree: true,
      autoPr: false,
      draftPr: false,
    });
    assert.equal(result.executionOptionsVerified, true);
    assert.equal(saved.status, "pending");
    assert.equal(saved.task_dir, result.taskDir);
    assert.equal(readFileSync(join(project.cwd, result.taskDir, "order.md"), "utf8"), task);
    assert.equal(existsSync(`${result.tasksFile}.lock`), false);
  } finally {
    project.cleanup();
  }
});

test("direct queue appends without changing existing task records", async () => {
  const project = temporaryProject();
  try {
    const taktDir = join(project.cwd, ".takt");
    const tasksFile = join(taktDir, "tasks.yaml");
    mkdirSync(taktDir, { recursive: true });
    const first = await new TaktTaskQueue({ cwd: project.cwd }).enqueue("workflow: simple\n\n# First task", noPrPolicy);
    const before = parseYaml(readFileSync(tasksFile, "utf8")).tasks[0];
    await new TaktTaskQueue({ cwd: project.cwd }).enqueue("workflow: review\n\n# Second task", noPrPolicy);
    const after = parseYaml(readFileSync(tasksFile, "utf8"));

    assert.deepEqual(after.tasks[0], before);
    assert.equal(after.tasks.length, 2);
    assert.equal(first.status, "pending");
  } finally {
    project.cleanup();
  }
});

test("direct queue rejects missing workflow and broken YAML without overwriting it", async () => {
  const project = temporaryProject();
  try {
    await assert.rejects(
      () => new TaktTaskQueue({ cwd: project.cwd }).enqueue("# Missing workflow", noPrPolicy),
      /must include an exact.*workflow/i,
    );
    const taktDir = join(project.cwd, ".takt");
    const tasksFile = join(taktDir, "tasks.yaml");
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(tasksFile, "tasks: [broken", "utf8");
    await assert.rejects(
      () => new TaktTaskQueue({ cwd: project.cwd }).enqueue("workflow: review\n\n# Safe failure", noPrPolicy),
      /invalid tasks.yaml/i,
    );
    assert.equal(readFileSync(tasksFile, "utf8"), "tasks: [broken");
  } finally {
    project.cleanup();
  }
});

test("direct queue rejects a duplicate active branch", async () => {
  const project = temporaryProject();
  try {
    const queue = new TaktTaskQueue({ cwd: project.cwd });
    await queue.enqueue("workflow: simple\nbranch: takt/shared\n\n# First task", noPrPolicy);
    await assert.rejects(
      () => queue.enqueue("workflow: review\nbranch: takt/shared\n\n# Second task", noPrPolicy),
      /active task target already exists.*branch=takt\/shared/i,
    );
  } finally {
    project.cleanup();
  }
});

test("direct queue rejects an invalid Git branch before writing", async () => {
  const project = temporaryProject();
  try {
    await assert.rejects(
      () => new TaktTaskQueue({ cwd: project.cwd }).enqueue(
        "workflow: review\nbranch: takt/bad..branch\n\n# Invalid branch",
        noPrPolicy,
      ),
      /invalid TAKT task branch/i,
    );
    assert.equal(existsSync(join(project.cwd, ".takt", "tasks.yaml")), false);
  } finally {
    project.cleanup();
  }
});

test("direct queue persists regular and draft PR selections exactly", async () => {
  const project = temporaryProject();
  try {
    const regular = await new TaktTaskQueue({ cwd: project.cwd }).enqueue(
      "workflow: review\n\n# Regular PR",
      { worktree: true, prMode: "regular" },
    );
    const draft = await new TaktTaskQueue({ cwd: project.cwd }).enqueue(
      "workflow: review\n\n# Draft PR",
      { worktree: true, prMode: "draft" },
    );
    const state = parseYaml(readFileSync(regular.tasksFile, "utf8"));
    assert.deepEqual(
      state.tasks.slice(-2).map((task) => ({
        worktree: task.worktree,
        auto_pr: task.auto_pr,
        draft_pr: task.draft_pr,
      })),
      [
        { worktree: true, auto_pr: true, draft_pr: false },
        { worktree: true, auto_pr: true, draft_pr: true },
      ],
    );
    assert.equal(regular.executionOptionsVerified, true);
    assert.equal(draft.executionOptionsVerified, true);
  } finally {
    project.cleanup();
  }
});

test("direct queue rejects missing or incompatible policy before writing", async () => {
  const project = temporaryProject();
  try {
    await assert.rejects(
      () => new TaktTaskQueue({ cwd: project.cwd }).enqueue("workflow: review\n\n# Missing policy"),
      /selected explicitly/i,
    );
    await assert.rejects(
      () => new TaktTaskQueue({ cwd: project.cwd }).enqueue(
        "workflow: review\n\n# Invalid policy",
        { worktree: false, prMode: "draft" },
      ),
      /PR requires worktree: true/i,
    );
    assert.equal(existsSync(join(project.cwd, ".takt", "tasks.yaml")), false);
  } finally {
    project.cleanup();
  }
});
