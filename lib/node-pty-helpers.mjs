import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function addUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

function prebuildsPath(nodePtyRoot) {
  const candidate = join(nodePtyRoot, "prebuilds");
  return existsSync(candidate) ? candidate : undefined;
}

function packageRootFromEntry(entry) {
  let current = dirname(entry);
  while (current !== dirname(current)) {
    if (existsSync(join(current, "prebuilds"))) return current;
    current = dirname(current);
  }
  return undefined;
}

function resolveNodePtyRoot(packageRoot) {
  try {
    const requireFromPackage = createRequire(join(packageRoot, "package.json"));
    const entry = requireFromPackage.resolve("node-pty");
    return packageRootFromEntry(entry);
  } catch {
    return undefined;
  }
}

/**
 * Find node-pty prebuilds in both package-local and hoisted npm layouts.
 *
 * Pi installs extensions below a shared npm directory, so process.cwd() can
 * be the vault while node-pty lives beside the extension package. The old
 * cwd-only lookup missed that layout on macOS.
 */
export function findNodePtyPrebuilds(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const roots = [];

  addUnique(roots, prebuildsPath(join(cwd, "node_modules", "node-pty")));
  addUnique(roots, prebuildsPath(join(packageRoot, "node_modules", "node-pty")));

  const resolvedRoot = resolveNodePtyRoot(packageRoot);
  addUnique(roots, resolvedRoot && prebuildsPath(resolvedRoot));
  return roots;
}

/**
 * Make every discovered node-pty spawn-helper executable.
 *
 * Returns bounded diagnostics so the PTY broker can repair installs at runtime
 * and include useful platform information if spawning still fails.
 */
export function ensureNodePtyHelpers(options = {}) {
  const roots = findNodePtyPrebuilds(options);
  const helperPaths = [];
  let fixed = 0;

  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      const helperPath = join(root, entry, "spawn-helper");
      if (!existsSync(helperPath) || !statSync(helperPath).isFile()) continue;
      helperPaths.push(helperPath);
      const mode = statSync(helperPath).mode & 0o777;
      if ((mode & 0o111) === 0o111) continue;
      chmodSync(helperPath, mode | 0o111);
      fixed += 1;
    }
  }

  return {
    platform: process.platform,
    arch: process.arch,
    roots,
    helperPaths,
    fixed,
  };
}
