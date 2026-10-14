import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertReleaseTriggerContract } from "../scripts/release-trigger-contract.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("release and publish workflows keep manual-only release and tag-scoped publish", () => {
  const release = readFileSync(join(repoRoot, ".github", "workflows", "auto-release.yml"), "utf8");
  const publish = readFileSync(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");
  assert.doesNotThrow(() => assertReleaseTriggerContract(release, publish));
});
