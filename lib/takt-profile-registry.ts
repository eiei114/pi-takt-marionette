import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configRoot } from "./takt-config-path.ts";
import { normalizeProjectPath } from "./takt-project-registry.ts";

const PROFILE_FILE = "profiles.json";

export interface TaktProjectProfile {
  name: string;
  cwd: string;
  preset?: string;
}

export function normalizeProfileName(value: string): string {
  const name = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error("TAKT profile name must contain only letters, numbers, hyphens, or underscores");
  }
  return name;
}

export function defaultProfileRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  // Stable data directory: intentionally still "pi-takt-bridge" after the
  // pi-takt-marionette rename so saved profiles/projects keep resolving.
  return join(configRoot(env), "pi-takt-bridge", PROFILE_FILE);
}

export function loadTaktProfiles(filePath = defaultProfileRegistryPath()): TaktProjectProfile[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.profiles)) {
      return [];
    }

    const profiles: TaktProjectProfile[] = [];
    const seen = new Set<string>();
    for (const value of parsed.profiles) {
      if (!isRecord(value) || typeof value.name !== "string" || typeof value.cwd !== "string") {
        continue;
      }
      try {
        const name = normalizeProfileName(value.name);
        if (seen.has(name)) {
          continue;
        }
        const cwd = normalizeProjectPath(value.cwd);
        const preset = typeof value.preset === "string" && value.preset.trim()
          ? value.preset.trim()
          : undefined;
        profiles.push({ name, cwd, ...(preset ? { preset } : {}) });
        seen.add(name);
      } catch {
        // Ignore malformed entries without preventing Pi from starting.
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

export function saveTaktProfiles(
  profiles: readonly TaktProjectProfile[],
  filePath = defaultProfileRegistryPath(),
): void {
  const normalized: TaktProjectProfile[] = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    const name = normalizeProfileName(profile.name);
    if (seen.has(name)) {
      continue;
    }
    const cwd = normalizeProjectPath(profile.cwd);
    const preset = profile.preset?.trim();
    normalized.push({ name, cwd, ...(preset ? { preset } : {}) });
    seen.add(name);
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ version: 1, profiles: normalized }, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
