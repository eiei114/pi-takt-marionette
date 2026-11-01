import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { configRoot } from "./takt-config-path.ts";
import { loadJsonRegistryEntries, saveJsonRegistryEntries } from "./takt-json-registry.ts";

const REGISTRY_FILE = "projects.json";

export function normalizeProjectPath(value: string, baseCwd = process.cwd()): string {
  const trimmed = value.trim().replace(/^"(.*)"$/, "$1");
  if (!trimmed) {
    throw new Error("TAKT project path must not be empty");
  }
  return resolve(baseCwd, trimmed);
}

export function projectPathKey(cwd: string): string {
  const normalized = resolve(cwd).replace(/[\\/]$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function dedupeProjectPaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeProjectPath(path);
    const key = projectPathKey(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

export function defaultProjectRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  // Stable data directory: see takt-profile-registry.ts — stays
  // "pi-takt-bridge" across the pi-takt-marionette rename so registered
  // projects survive upgrades.
  return join(configRoot(env), "pi-takt-bridge", REGISTRY_FILE);
}

export function loadProjectPaths(filePath = defaultProjectRegistryPath()): string[] {
  try {
    return dedupeProjectPaths(loadJsonRegistryEntries(filePath, "projects")
      .filter((value): value is string => typeof value === "string"))
      .filter((projectPath) => existsSync(projectPath));
  } catch {
    return [];
  }
}

export function saveProjectPaths(paths: readonly string[], filePath = defaultProjectRegistryPath()): void {
  const normalized = dedupeProjectPaths(paths);
  saveJsonRegistryEntries(filePath, "projects", normalized);
}
