import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadJsonRegistryEntries(filePath: string, key: string): unknown[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed[key])) {
      return [];
    }
    return parsed[key];
  } catch {
    return [];
  }
}

export function saveJsonRegistryEntries(filePath: string, key: string, entries: readonly unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ version: 1, [key]: entries }, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
