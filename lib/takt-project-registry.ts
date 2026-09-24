import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configRoot } from "./takt-config-path.ts";

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
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
      return [];
    }
    return dedupeProjectPaths(parsed.projects.filter((value): value is string => typeof value === "string"))
      .filter((projectPath) => existsSync(projectPath));
  } catch {
    return [];
  }
}

export function saveProjectPaths(paths: readonly string[], filePath = defaultProjectRegistryPath()): void {
  const normalized = dedupeProjectPaths(paths);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ version: 1, projects: normalized }, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
