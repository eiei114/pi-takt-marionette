import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertNoPrivilegedPublicationWorkflows,
  assertProtectedPublishWorkflow,
  assertProtectedReleaseWorkflow,
} from "../scripts/release-trigger-contract.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

function activeWorkflows() {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({ path: name, content: readFileSync(join(workflowsDir, name), "utf8") }));
}

test("the active workflow set satisfies the protected release contract", () => {
  assert.doesNotThrow(() => assertNoPrivilegedPublicationWorkflows(activeWorkflows()));
});

test("only the protected release and publish workflows may carry privileged capabilities", () => {
  const names = activeWorkflows().map((entry) => entry.path).sort();
  assert.deepEqual(names, ["auto-release.yml", "ci.yml", "publish.yml"]);

  const ci = readFileSync(join(workflowsDir, "ci.yml"), "utf8");
  assert.doesNotMatch(ci, /\bnpm\s+publish\b/i, "ci.yml must not publish");
  assert.doesNotMatch(ci, /\bgh\s+release\s+create\b/i, "ci.yml must not create releases");
  assert.doesNotMatch(ci, /\bid-token:\s*write/i, "ci.yml must not request an OIDC token");
});

// ---------------------------------------------------------------------------
// Negative cases: every barrier must fail closed on its own.
// ---------------------------------------------------------------------------

const PROTECTED_RELEASE = `name: Release (protected)
on:
  workflow_dispatch:
    inputs:
      release_authorized:
        description: "Confirm."
        required: true
        type: boolean
        default: false
permissions:
  actions: write
  contents: write
jobs:
  release:
    if: github.ref == 'refs/heads/main' && inputs.release_authorized == true
    runs-on: ubuntu-latest
    environment:
      name: release
    steps:
      - run: gh release create "$TAG"
`;

test("the protected release shape is accepted", () => {
  assert.doesNotThrow(() => assertProtectedReleaseWorkflow("auto-release.yml", PROTECTED_RELEASE));
});

test("a release without the protected environment fails closed", () => {
  const unprotected = PROTECTED_RELEASE.replace("    environment:\n      name: release\n", "");
  assert.throws(
    () => assertProtectedReleaseWorkflow("auto-release.yml", unprotected),
    /protected release environment/,
  );
});

test("a release on a push trigger fails closed", () => {
  const pushTriggered = PROTECTED_RELEASE.replace(
    "on:\n  workflow_dispatch:",
    "on:\n  push:\n    branches: [main]\n  workflow_dispatch:",
  );
  assert.throws(() => assertProtectedReleaseWorkflow("auto-release.yml", pushTriggered), /dispatch-only/);
});

test("a release without the authorization input fails closed", () => {
  const noInput = PROTECTED_RELEASE.replace(
    `    inputs:
      release_authorized:
        description: "Confirm."
        required: true
        type: boolean
        default: false
`,
    "",
  ).replace(" && inputs.release_authorized == true", "");
  assert.throws(() => assertProtectedReleaseWorkflow("auto-release.yml", noInput), /release_authorized/);
});

test("an authorization input that defaults to true fails closed", () => {
  const permissive = PROTECTED_RELEASE.replace("        default: false", "        default: true");
  assert.throws(() => assertProtectedReleaseWorkflow("auto-release.yml", permissive), /default to false/);
});

test("a different environment name fails closed", () => {
  const wrongEnv = PROTECTED_RELEASE.replace("      name: release\n", "      name: staging\n");
  assert.throws(() => assertProtectedReleaseWorkflow("auto-release.yml", wrongEnv), /release environment/);
});

test("publishing on a branch push fails the publish contract", () => {
  const branchPush = `name: Publish
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    steps:
      - run: npm publish --access public
`;
  assert.throws(() => assertProtectedPublishWorkflow("publish.yml", branchPush), /branch push/);
});

test("publishing without OIDC fails the publish contract", () => {
  const noOidc = `name: Publish
on:
  release:
    types: [published]
permissions:
  contents: read
jobs:
  publish:
    steps:
      - run: npm publish --access public
`;
  assert.throws(() => assertProtectedPublishWorkflow("publish.yml", noOidc), /id-token/);
});

test("an unrelated workflow must not gain publication capabilities", () => {
  const sneaky = `name: Sneaky
on:
  push:
    branches: [main]
permissions:
  contents: write
jobs:
  go:
    steps:
      - run: npm publish --access public
`;
  assert.throws(
    () => assertNoPrivilegedPublicationWorkflows([{ path: "sneaky.yml", content: sneaky }]),
    /npm publication/,
  );
});

test("an unrelated workflow must not tag or dispatch", () => {
  assert.throws(
    () =>
      assertNoPrivilegedPublicationWorkflows([
        { path: "docs.yml", content: "jobs:\n  go:\n    steps:\n      - run: git tag v1.0.0\n" },
      ]),
    /tag creation/,
  );
  assert.throws(
    () =>
      assertNoPrivilegedPublicationWorkflows([
        { path: "docs.yml", content: "jobs:\n  go:\n    steps:\n      - run: gh workflow run publish.yml\n" },
      ]),
    /workflow dispatch/,
  );
});

test("a release-publishing action fails closed", () => {
  assert.throws(
    () =>
      assertNoPrivilegedPublicationWorkflows([
        {
          path: "docs.yml",
          content: "jobs: { go: { steps: [{ uses: softprops/action-gh-release@v3 }] } }",
        },
      ]),
    /release-publishing action/,
  );
});

test("the docs describe the protected release path", () => {
  const docs = readFileSync(join(repoRoot, "docs", "release.md"), "utf8");
  assert.match(docs, /release_authorized/);
  assert.match(docs, /environment/i);
});
