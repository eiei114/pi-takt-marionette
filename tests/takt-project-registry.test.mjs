import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { defaultProjectRegistryPath, dedupeProjectPaths, loadProjectPaths, normalizeProjectPath, saveProjectPaths } = await import("../lib/takt-project-registry.ts");
const { defaultProfileRegistryPath } = await import("../lib/takt-profile-registry.ts");

test("project and profile registries share the platform config root", () => {
  const env = process.platform === "win32" ? { APPDATA: "C:\\config" } : { XDG_CONFIG_HOME: "/config" };
  assert.equal(
    defaultProjectRegistryPath(env).replace(/projects\.json$/, ""),
    defaultProfileRegistryPath(env).replace(/profiles\.json$/, ""),
  );
});

test("project registry normalizes and deduplicates folder paths", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-takt-bridge-projects-"));
  const nested = join(base, "repo");
  const paths = dedupeProjectPaths([nested, `"${nested}"`]);
  assert.deepEqual(paths, [nested]);
  assert.equal(normalizeProjectPath(".", base), base);
});

test("project registry persists only normalized project paths", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-takt-bridge-projects-"));
  const registry = join(base, "config", "projects.json");
  const repo = join(base, "repo");
  mkdirSync(repo);
  saveProjectPaths([repo, repo], registry);
  assert.deepEqual(loadProjectPaths(registry), [repo]);
  assert.match(readFileSync(registry, "utf8"), /"version": 1/);
});

test("project registry ignores folders that were removed after registration", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-takt-bridge-projects-stale-"));
  const registry = join(base, "config", "projects.json");
  const existing = join(base, "existing");
  mkdirSync(existing);
  mkdirSync(join(base, "config"));
  writeFileSync(
    registry,
    JSON.stringify({ version: 1, projects: [existing, join(base, "removed")] }),
    "utf8",
  );

  assert.deepEqual(loadProjectPaths(registry), [existing]);
});
