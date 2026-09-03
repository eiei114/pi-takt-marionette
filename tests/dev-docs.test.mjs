import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("README recommends package-root local dev load", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /pi -e \./, "local dev should load the package root");
  assert.doesNotMatch(
    readme,
    /pi -e[^\n]*extensions\/index\.ts/,
    "loading extensions/index.ts directly skips bundled skills",
  );
});

test("CONTRIBUTING and PR template agree on local Pi testing", () => {
  const contributing = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");
  const prTemplate = readFileSync(join(repoRoot, ".github", "pull_request_template.md"), "utf8");
  assert.match(contributing, /pi -e \./);
  assert.match(prTemplate, /pi -e \./);
});

test("Pi model preflight documents the executor/model boundary", () => {
  const skill = readFileSync(
    join(repoRoot, "skills", "takt-pi-model-preflight", "SKILL.md"),
    "utf8",
  );
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const usage = readFileSync(join(repoRoot, "docs", "usage.md"), "utf8");

  assert.match(skill, /TAKT `provider` selects the workflow executor/);
  assert.match(skill, /TAKT `model` selects a model in Pi/);
  assert.match(skill, /"provider": "pi"[\s\S]*"model": "opencode-go\/muse-spark-1\.3-contributor:xhigh"/);
  assert.match(skill, /models-store\.json/);
  assert.match(skill, /target's[\s\S]*meta\.json/);
  assert.match(skill, /does not select workflows, enqueue\s+tasks/);
  assert.match(readme, /opencode-go\/muse-spark-1\.3-contributor:xhigh/);
  assert.match(usage, /Pi provider\/model preflight/);
  assert.match(usage, /candidate evidence|only supplies candidates/);
});
