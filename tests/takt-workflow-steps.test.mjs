import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  collectSelectableSteps,
  listWorkflowNames,
  resolveWorkflowFile,
  resetTaktRootCache,
} = await import("../lib/takt-workflow-steps.ts");
const {
  assertWorkflowCatalogReady,
  resolveWorkflowCatalog,
} = await import("../lib/takt-workflow-catalog.ts");

function makeProject() {
  return mkdtempSync(join(tmpdir(), "pi-takt-bridge-steps-"));
}

const SIMPLE_WORKFLOW = [
  "name: simple",
  "description: test workflow",
  "max_steps: 10",
  "initial_step: develop",
  "steps:",
  "  - name: develop",
  "    kind: agent",
  "    instruction: build it",
  "  - name: review",
  "    kind: agent",
  "    provider: anthropic",
  "    model: claude-opus-4-8",
  "    instruction: review it",
  "  - name: gate",
  "    kind: system",
  "",
].join("\n");

test("collectSelectableSteps extracts agent steps and marks pinned models", async () => {
  const project = makeProject();
  const workflows = join(project, ".takt", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "simple.yaml"), SIMPLE_WORKFLOW);

  const { root, steps } = await collectSelectableSteps(project, "simple");
  assert.equal(root.layer, "project");
  assert.deepEqual(steps.map((step) => step.stepName), ["develop", "review"]);
  assert.ok(steps.every((step) => step.targetKey === `simple/${step.stepName}`));
  assert.equal(steps[0].pinnedInline, false);
  assert.equal(steps[1].pinnedInline, true);
});

test("collectSelectableSteps expands one level of workflow_call and flags unresolved calls", async () => {
  const project = makeProject();
  const workflows = join(project, ".takt", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "root.yaml"), [
    "name: root",
    "steps:",
    "  - name: develop",
    "    kind: workflow_call",
    "    call: sub-core",
    "  - name: missing-call",
    "    kind: workflow_call",
    "    call: not-anywhere",
  ].join("\n"));
  writeFileSync(join(workflows, "sub-core.yaml"), [
    "name: sub-core",
    "steps:",
    "  - name: plan",
    "    kind: agent",
    "  - name: inner-system",
    "    kind: system",
  ].join("\n"));

  const { steps } = await collectSelectableSteps(project, "root");
  // The resolvable call expands into the called workflow's own agent steps.
  assert.deepEqual(
    steps.filter((step) => step.unresolvedCall === undefined).map((step) => step.targetKey),
    ["sub-core/plan"],
  );
  assert.equal(steps[0].nested, true);
  // The unresolvable call stays visible as an explicit marker.
  const unresolved = steps.find((step) => step.unresolvedCall !== undefined);
  assert.equal(unresolved?.unresolvedCall, "not-anywhere");
});

test("resolveWorkflowFile prefers project over user and builtin layers", async () => {
  const project = makeProject();
  const fakeTaktRoot = join(project, "takt-root");
  const builtinDir = join(fakeTaktRoot, "builtins", "en", "workflows");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(join(project, ".takt", "workflows"), { recursive: true });
  writeFileSync(join(builtinDir, "dual.yaml"), "name: dual\nsteps: []\n");
  writeFileSync(join(project, ".takt", "workflows", "dual.yml"), "name: dual\nsteps: []\n");
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;
  process.env.TAKT_CONFIG_DIR = join(project, "empty-takt-config");
  resetTaktRootCache();
  try {
    const resolved = await resolveWorkflowFile(project, "dual", join(fakeTaktRoot, "bin", "takt"));
    assert.equal(resolved?.layer, "project");
    assert.ok(resolved?.path.endsWith("dual.yml"));

    const builtin = await resolveWorkflowFile(project, "missing-project-flow", join(fakeTaktRoot, "bin", "takt"));
    assert.equal(builtin?.layer, undefined);
    writeFileSync(join(builtinDir, "flow-builtin.yaml"), "name: flow-builtin\nsteps: []\n");
    const builtinHit = await resolveWorkflowFile(project, "flow-builtin", join(fakeTaktRoot, "bin", "takt"));
    assert.equal(builtinHit?.layer, "builtin");
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    resetTaktRootCache();
    rmSync(project, { recursive: true, force: true });
  }
});

test("listWorkflowNames merges layers with project precedence", async () => {
  const project = makeProject();
  try {
    const workflows = join(project, ".takt", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, "mine.yaml"), "name: mine\nsteps: []\n");
    const names = await listWorkflowNames(project);
    const mine = names.find((entry) => entry.name === "mine");
    assert.equal(mine?.layer, "project");
    // Builtin names appear only when a real TAKT install is discoverable; the
    // assertion here just guards the shape of the returned entries.
    assert.ok(names.every((entry) => entry.name.length > 0));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("workflow catalog follows TAKT precedence, categories, and standalone filtering", async () => {
  const root = makeProject();
  const project = join(root, "project");
  const globalDir = join(root, "global");
  const taktRoot = join(root, "takt");
  const builtinDir = join(taktRoot, "builtins", "en", "workflows");
  mkdirSync(join(project, ".takt", "workflows"), { recursive: true });
  mkdirSync(join(globalDir, "workflows"), { recursive: true });
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(join(globalDir, "preferences"), { recursive: true });

  writeFileSync(join(project, ".takt", "workflows", "same.yaml"), "name: same\ndescription: project\nsteps: []\n");
  writeFileSync(join(globalDir, "workflows", "same.yaml"), "name: same\ndescription: user\nsteps: []\n");
  writeFileSync(join(builtinDir, "same.yaml"), "name: same\ndescription: builtin\nsteps: []\n");
  writeFileSync(join(globalDir, "workflows", "user-only.yaml"), "name: user-only\nsteps: []\n");
  writeFileSync(join(builtinDir, "builtin-only.yaml"), "name: builtin-only\nsteps: []\n");
  writeFileSync(join(builtinDir, "internal.yaml"), [
    "name: internal",
    "subworkflow:",
    "  callable: true",
    "  visibility: internal",
    "steps: []",
  ].join("\n"));
  writeFileSync(join(taktRoot, "builtins", "en", "workflow-categories.yaml"), [
    "workflow_categories:",
    "  Development:",
    "    workflows:",
    "      - builtin-only: Builtin lane",
    "      - same: Builtin duplicate",
  ].join("\n"));
  writeFileSync(join(globalDir, "preferences", "workflow-categories.yaml"), [
    "workflow_categories:",
    "  Custom:",
    "    workflows:",
    "      - user-only: User lane",
    "show_others_category: true",
    "others_category_name: Other",
  ].join("\n"));
  writeFileSync(join(globalDir, "config.yaml"), "language: en\n");

  resetTaktRootCache();
  try {
    const catalog = await resolveWorkflowCatalog(project, {
      taktCommand: join(taktRoot, "bin", "takt"),
      globalConfigDir: globalDir,
    });
    assert.equal(catalog.ready, true);
    assert.equal(catalog.errors.length, 0);
    assert.deepEqual(catalog.workflows.map((entry) => entry.name), ["builtin-only", "same", "user-only"]);
    assert.equal(catalog.workflows.find((entry) => entry.name === "same")?.layer, "project");
    assert.equal(catalog.workflows.find((entry) => entry.name === "same")?.description, "project");
    assert.equal(catalog.workflows.find((entry) => entry.name === "user-only")?.categories[0], "Custom");
    assert.equal(catalog.workflows.find((entry) => entry.name === "builtin-only")?.categories[0], "builtin / Development");
    assert.equal(assertWorkflowCatalogReady(catalog), catalog);
  } finally {
    resetTaktRootCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow catalog honors builtin disablement without falling back to a hidden default", async () => {
  const root = makeProject();
  const project = join(root, "project");
  const globalDir = join(root, "global");
  const taktRoot = join(root, "takt");
  mkdirSync(join(project, ".takt", "workflows"), { recursive: true });
  mkdirSync(join(globalDir, "workflows"), { recursive: true });
  mkdirSync(join(taktRoot, "builtins", "en", "workflows"), { recursive: true });
  writeFileSync(join(project, ".takt", "workflows", "local.yaml"), "name: local\nsteps: []\n");
  writeFileSync(join(taktRoot, "builtins", "en", "workflows", "builtin.yaml"), "name: builtin\nsteps: []\n");
  writeFileSync(join(globalDir, "config.yaml"), "enable_builtin_workflows: false\n");

  resetTaktRootCache();
  try {
    const catalog = await resolveWorkflowCatalog(project, {
      taktCommand: join(taktRoot, "bin", "takt"),
      globalConfigDir: globalDir,
    });
    assert.equal(catalog.ready, true);
    assert.deepEqual(catalog.workflows.map((entry) => entry.name), ["local"]);
    assert.equal(catalog.builtinEnabled, false);
  } finally {
    resetTaktRootCache();
    rmSync(root, { recursive: true, force: true });
  }
});
