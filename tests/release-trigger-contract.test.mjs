import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertNoPrivilegedPublicationWorkflows } from "../scripts/release-trigger-contract.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

test("publication stays disabled until a trusted external authorization boundary exists", () => {
  const workflows = readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({
      path: name,
      content: readFileSync(join(workflowsDir, name), "utf8"),
    }));
  assert.doesNotThrow(() => assertNoPrivilegedPublicationWorkflows(workflows));
});

test("publication contract rejects manual dispatch and privileged publisher signatures", () => {
  assert.throws(() => assertNoPrivilegedPublicationWorkflows([
    { path: "manual.yml", content: "on:\n  workflow_dispatch:\n" },
  ]), /manual workflow dispatch/);
  assert.throws(() => assertNoPrivilegedPublicationWorkflows([
    { path: "publish.yml", content: "permissions:\n  id-token: write\n" },
  ]), /write-capable workflow token/);
  assert.throws(() => assertNoPrivilegedPublicationWorkflows([
    { path: "publish.yml", content: "run: npm publish --access public\n" },
  ]), /npm publication/);
});

test("publication contract rejects compact workflow dispatch, permissions, and release actions", () => {
  const compactWorkflow = `on: workflow_dispatch
permissions: { contents: write }
jobs: { publish: { steps: [{ uses: softprops/action-gh-release@v3 }] } }`;
  assert.throws(() => assertNoPrivilegedPublicationWorkflows([
    { path: "compact-publish.yml", content: compactWorkflow },
  ]), /manual workflow dispatch/);
  assert.throws(() => assertNoPrivilegedPublicationWorkflows([
    { path: "compact-permissions.yml", content: "permissions: { contents: write }" },
  ]), /write-capable workflow token/);
  assert.throws(() => assertNoPrivilegedPublicationWorkflows([
    { path: "compact-action.yml", content: "jobs: { publish: { steps: [{ uses: softprops/action-gh-release@v3 }] } }" },
  ]), /GitHub release-publishing action/);
  assert.throws(() => assertNoPrivilegedPublicationWorkflows([
    { path: "compact-job-permissions.yml", content: "jobs: { publish: { permissions: { contents: write } } }" },
  ]), /write-capable workflow token/);
  assert.throws(() => assertNoPrivilegedPublicationWorkflows([
    { path: "write-all.yml", content: "permissions: write-all" },
  ]), /write-capable workflow token/);
});
