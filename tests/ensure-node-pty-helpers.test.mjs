import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, accessSync, constants, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ensureNodePtyHelpers, findNodePtyPrebuilds } from "../lib/node-pty-helpers.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "ensure-node-pty-helpers.mjs");

test("ensure-node-pty-helpers makes spawn-helper executable", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-pty-helper-"));
  const helperDir = join(root, "node_modules", "node-pty", "prebuilds", "darwin-arm64");
  mkdirSync(helperDir, { recursive: true });
  const helperPath = join(helperDir, "spawn-helper");
  writeFileSync(helperPath, "#!/bin/sh\necho ok\n", "utf8");
  chmodSync(helperPath, 0o644);

  const result = ensureNodePtyHelpers({ cwd: root, packageRoot: root });
  assert.equal(result.fixed, 1);
  assert.equal(result.helperPaths.length, 1);
  assert.doesNotThrow(() => accessSync(helperPath, constants.X_OK));
});

test("ensure-node-pty-helpers no-ops when node-pty is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-pty-helper-missing-"));
  const result = ensureNodePtyHelpers({ cwd: root, packageRoot: root });
  assert.equal(result.fixed, 0);
  assert.deepEqual(result.helperPaths, []);
});

test("ensure-node-pty-helpers CLI repairs a fixture helper from the default cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-pty-helper-cli-"));
  const baselineRoot = join(root, "baseline");
  const fixtureRoot = join(root, "fixture");
  const helperDir = join(fixtureRoot, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`);
  mkdirSync(baselineRoot, { recursive: true });
  mkdirSync(helperDir, { recursive: true });
  const helperPath = join(helperDir, "spawn-helper");
  writeFileSync(helperPath, "#!/bin/sh\necho ok\n", "utf8");
  chmodSync(helperPath, 0o644);

  try {
    const runFrom = (cwd) => spawnSync(process.execPath, [scriptPath], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    const fixedCount = (stdout) => {
      const output = stdout.match(/^ensure-node-pty-helpers: chmod \+x on (\d+) spawn-helper file\(s\)\r?\n?$/);
      assert.ok(output, `unexpected CLI output: ${stdout}`);
      return Number(output[1]);
    };

    const baseline = runFrom(baselineRoot);
    assert.ifError(baseline.error);
    assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
    assert.equal(baseline.stderr, "");
    const baselineFixed = baseline.stdout === "" ? 0 : fixedCount(baseline.stdout);

    const result = runFrom(fixtureRoot);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(fixedCount(result.stdout), baselineFixed + 1);
    if (process.platform !== "win32") {
      assert.equal(statSync(helperPath).mode & 0o111, 0o111);
    }
    assert.doesNotThrow(() => accessSync(helperPath, constants.X_OK));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("helper discovery follows a hoisted node-pty when the vault is the cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-pty-helper-hoisted-"));
  const packageRoot = join(root, "extension");
  const packageJsonPath = join(packageRoot, "package.json");
  const nodePtyRoot = join(root, "node_modules", "node-pty");
  const helperDir = join(nodePtyRoot, "prebuilds", "darwin-arm64");
  const helperPath = join(helperDir, "spawn-helper");
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(join(nodePtyRoot, "lib"), { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(packageJsonPath, "{}\n", "utf8");
  writeFileSync(join(nodePtyRoot, "package.json"), JSON.stringify({ main: "lib/index.js" }), "utf8");
  writeFileSync(join(nodePtyRoot, "lib", "index.js"), "module.exports = {};\n", "utf8");
  writeFileSync(helperPath, "#!/bin/sh\necho ok\n", "utf8");
  chmodSync(helperPath, 0o644);

  const vaultRoot = join(root, "vault");
  mkdirSync(vaultRoot);
  const roots = findNodePtyPrebuilds({ cwd: vaultRoot, packageRoot });
  const expectedPrebuilds = realpathSync(join(nodePtyRoot, "prebuilds"));
  assert.ok(roots.some((candidate) => realpathSync(candidate) === expectedPrebuilds));

  const result = ensureNodePtyHelpers({ cwd: vaultRoot, packageRoot });
  assert.equal(result.fixed, 1);
  assert.equal(result.helperPaths.length, 1);
  assert.doesNotThrow(() => accessSync(helperPath, constants.X_OK));
});

test("repo node-pty spawn-helper is executable after ensure script", () => {
  const helperPath = join(
    repoRoot,
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  if (!existsSync(helperPath)) {
    return;
  }
  chmodSync(helperPath, 0o644);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotThrow(() => accessSync(helperPath, constants.X_OK));
});
