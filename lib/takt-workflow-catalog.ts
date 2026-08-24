import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { spawnCommand } from "./process-control.ts";

export type TaktWorkflowLayer = "project" | "user" | "builtin";

export interface WorkflowCategoryNode {
  name: string;
  workflows: string[];
  children: WorkflowCategoryNode[];
}

export interface WorkflowCatalogEntry {
  name: string;
  layer: TaktWorkflowLayer;
  path: string;
  description?: string;
  categories: string[];
}

export interface WorkflowCatalog {
  cwd: string;
  language: "en" | "ja";
  builtinEnabled: boolean;
  disabledBuiltins: string[];
  workflows: WorkflowCatalogEntry[];
  categories: WorkflowCategoryNode[];
  ready: boolean;
  errors: string[];
}

export interface WorkflowCatalogOptions {
  taktCommand?: string;
  /** Test seam; normal callers use TAKT_CONFIG_DIR or ~/.takt. */
  globalConfigDir?: string;
}

interface WorkflowFile {
  name: string;
  path: string;
  category?: string;
}

interface WorkflowConfigValues {
  language: "en" | "ja";
  builtinEnabled: boolean;
  disabledBuiltins: string[];
  categoriesPath: string;
  globalConfigDir: string;
}

interface ParsedCategoryConfig {
  categories: WorkflowCategoryNode[];
  descriptions: Record<string, string>;
  showOthersCategory?: boolean;
  othersCategoryName?: string;
}

const DEFAULT_LANGUAGE = "en" as const;
const DEFAULT_OTHERS_CATEGORY = "Others";
const WORKFLOW_EXTENSIONS = /\.ya?ml$/i;
const BUILTIN_CONFIG_KEYS = {
  language: "language",
  enableBuiltinWorkflows: "enable_builtin_workflows",
  disabledBuiltins: "disabled_builtins",
  workflowCategoriesFile: "workflow_categories_file",
} as const;

let cachedTaktRootPromises = new Map<string, Promise<string | undefined>>();

export function resetTaktRootCache(): void {
  cachedTaktRootPromises = new Map();
}

/**
 * Locate the TAKT install root (the directory holding `builtins/`).
 * Explicit command paths are walked upward; bare commands use the global npm
 * root and then the command shim directory.
 */
export function resolveTaktInstallRoot(command = "takt"): Promise<string | undefined> {
  const cached = cachedTaktRootPromises.get(command);
  if (cached) {
    return cached;
  }
  const next = detectTaktInstallRoot(command).catch(() => undefined);
  cachedTaktRootPromises.set(command, next);
  return next;
}

async function detectTaktInstallRoot(command: string): Promise<string | undefined> {
  if (/[\\/]/.test(command)) {
    return findAncestorWithBuiltins(command);
  }
  const npmGlobalRoot = await runNpmRootG();
  if (npmGlobalRoot !== undefined && existsSync(join(npmGlobalRoot, "takt", "builtins"))) {
    return join(npmGlobalRoot, "takt");
  }
  const shimDir = await findCommandDirectory(command);
  return shimDir === undefined
    ? undefined
    : findAncestorWithBuiltins(join(shimDir, command));
}

function findAncestorWithBuiltins(startPath: string): string | undefined {
  let current = startPath.replace(/[\\/]+$/, "");
  while (current.length > 0) {
    if (existsSync(join(current, "builtins"))) {
      return current;
    }
    const parent = current.slice(0, Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\")));
    if (parent === current || parent.length === 0) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function runNpmRootG(): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const resolved = process.platform === "win32" ? "npm.cmd" : "npm";
    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(resolved, ["root", "-g"], {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolvePromise(undefined);
      return;
    }
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => resolvePromise(undefined));
    child.once("close", (code) => {
      const root = stdout.trim().split(/\r?\n/)[0];
      resolvePromise(code === 0 && root.length > 0 ? root : undefined);
    });
  });
}

function findCommandDirectory(command: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const lookup = process.platform === "win32" ? "where.exe" : "which";
    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(lookup, [command], {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolvePromise(undefined);
      return;
    }
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => resolvePromise(undefined));
    child.once("close", () => {
      const firstLine = stdout.trim().split(/\r?\n/)[0] ?? "";
      const separator = Math.max(firstLine.lastIndexOf("/"), firstLine.lastIndexOf("\\"));
      resolvePromise(separator > 0 ? firstLine.slice(0, separator) : undefined);
    });
  });
}

/** Resolve a workflow ID using TAKT's project → user → builtin precedence. */
export async function resolveWorkflowFilePath(
  cwd: string,
  name: string,
  options: WorkflowCatalogOptions = {},
): Promise<{ name: string; layer: TaktWorkflowLayer; path: string } | undefined> {
  const safeName = sanitizeWorkflowName(name);
  if (!safeName) {
    return undefined;
  }
  const config = readWorkflowConfigValues(cwd, options);
  const projectPath = findWorkflowFileInDir(join(cwd, ".takt", "workflows"), safeName);
  if (projectPath) {
    return { name: safeName, layer: "project", path: projectPath };
  }
  const userPath = findWorkflowFileInDir(join(config.globalConfigDir, "workflows"), safeName);
  if (userPath) {
    return { name: safeName, layer: "user", path: userPath };
  }
  if (!config.builtinEnabled) {
    return undefined;
  }
  const taktRoot = await resolveTaktInstallRoot(options.taktCommand ?? "takt");
  if (!taktRoot) {
    return undefined;
  }
  const builtinPath = findWorkflowFileInDir(
    join(taktRoot, "builtins", config.language, "workflows"),
    safeName,
  );
  return builtinPath && !config.disabledBuiltins.includes(safeName)
    ? { name: safeName, layer: "builtin", path: builtinPath }
    : undefined;
}

/**
 * Build the effective selectable workflow catalog. Entries are validated at
 * the lightweight YAML boundary and callable/internal workflows are omitted.
 */
export async function resolveWorkflowCatalog(
  cwd: string,
  options: WorkflowCatalogOptions = {},
): Promise<WorkflowCatalog> {
  const config = readWorkflowConfigValues(cwd, options);
  const errors: string[] = [];
  const layerFiles = new Map<string, { layer: TaktWorkflowLayer; file: WorkflowFile }>();

  collectEffectiveLayer(layerFiles, listWorkflowFiles(join(cwd, ".takt", "workflows")), "project");
  collectEffectiveLayer(
    layerFiles,
    listWorkflowFiles(join(config.globalConfigDir, "workflows")),
    "user",
  );

  if (config.builtinEnabled) {
    const taktRoot = await resolveTaktInstallRoot(options.taktCommand ?? "takt");
    if (!taktRoot) {
      errors.push("TAKT builtin workflow root could not be located");
    } else {
      const builtinDir = join(taktRoot, "builtins", config.language, "workflows");
      const builtinFiles = listWorkflowFiles(builtinDir).filter((file) =>
        !config.disabledBuiltins.includes(file.name));
      collectEffectiveLayer(layerFiles, builtinFiles, "builtin");
    }
  }

  const parsedEntries: WorkflowCatalogEntry[] = [];
  const descriptions: Record<string, string> = {};
  for (const { layer, file } of layerFiles.values()) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(file.path, "utf8"));
    } catch (error) {
      errors.push(`Workflow ${file.name} could not be parsed: ${errorMessage(error)}`);
      continue;
    }
    if (!isRecord(raw)) {
      errors.push(`Workflow ${file.name} is not a YAML mapping`);
      continue;
    }
    if (isCallableOrInternal(raw.subworkflow)) {
      continue;
    }
    const description = typeof raw.description === "string" && raw.description.trim().length > 0
      ? raw.description.trim()
      : undefined;
    parsedEntries.push({
      name: file.name,
      layer,
      path: file.path,
      ...(description ? { description } : {}),
      categories: [],
    });
  }

  const categoryConfig = await loadCategoryConfig(config, options, errors);
  Object.assign(descriptions, categoryConfig.descriptions);
  const categoryTree = filterCategoryTree(
    categoryConfig.categories,
    new Set(parsedEntries.map((entry) => entry.name)),
  );
  const categorized = collectCategorizedWorkflowNames(categoryTree);
  const categoryByWorkflow = collectWorkflowCategoryPaths(categoryTree);
  const showOthers = categoryConfig.showOthersCategory ?? true;
  const othersName = categoryConfig.othersCategoryName ?? DEFAULT_OTHERS_CATEGORY;
  const uncategorized = parsedEntries
    .map((entry) => entry.name)
    .filter((name) => !categorized.has(name));
  const categories = showOthers && uncategorized.length > 0
    ? [...categoryTree, { name: othersName, workflows: uncategorized, children: [] }]
    : categoryTree;

  const workflows = parsedEntries
    .map((entry) => {
      const categoryPaths = categoryByWorkflow.get(entry.name)
        ?? (uncategorized.includes(entry.name) ? [othersName] : []);
      const categoryDescription = descriptions[entry.name];
      return {
        ...entry,
        ...(entry.description ?? categoryDescription
          ? { description: entry.description ?? categoryDescription }
          : {}),
        categories: categoryPaths,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    cwd: resolve(cwd),
    language: config.language,
    builtinEnabled: config.builtinEnabled,
    disabledBuiltins: [...config.disabledBuiltins],
    workflows,
    categories,
    ready: errors.length === 0 && workflows.length > 0,
    errors,
  };
}

export function assertWorkflowCatalogReady(catalog: WorkflowCatalog): WorkflowCatalog {
  if (catalog.ready) {
    return catalog;
  }
  const detail = catalog.errors.length > 0
    ? catalog.errors.join("; ")
    : "no standalone workflows are available";
  throw new Error(`TAKT workflow catalog unavailable for ${catalog.cwd}: ${detail}`);
}

function readWorkflowConfigValues(cwd: string, options: WorkflowCatalogOptions): WorkflowConfigValues {
  const globalConfigDir = options.globalConfigDir
    ?? process.env.TAKT_CONFIG_DIR
    ?? join(homedir(), ".takt");
  const global = readOptionalMapping(join(globalConfigDir, "config.yaml"), "TAKT global config");
  const project = readOptionalMapping(join(cwd, ".takt", "config.yaml"), "TAKT project config");
  const languageValue = process.env.TAKT_LANGUAGE
    ?? pickString(project.language)
    ?? pickString(global[BUILTIN_CONFIG_KEYS.language])
    ?? DEFAULT_LANGUAGE;
  if (languageValue !== "en" && languageValue !== "ja") {
    throw new Error(`Unsupported TAKT language: ${languageValue}`);
  }

  const builtinEnabled = process.env.TAKT_ENABLE_BUILTIN_WORKFLOWS !== undefined
    ? parseBooleanEnv("TAKT_ENABLE_BUILTIN_WORKFLOWS")
    : global[BUILTIN_CONFIG_KEYS.enableBuiltinWorkflows] !== false;
  const disabledBuiltins = process.env.TAKT_DISABLED_BUILTINS !== undefined
    ? parseListEnv("TAKT_DISABLED_BUILTINS")
    : pickStringArray(global[BUILTIN_CONFIG_KEYS.disabledBuiltins]);
  const configuredCategoriesPath = process.env.TAKT_WORKFLOW_CATEGORIES_FILE
    ?? pickString(global[BUILTIN_CONFIG_KEYS.workflowCategoriesFile]);
  const categoriesPath = configuredCategoriesPath
    ? expandHomePath(configuredCategoriesPath, globalConfigDir)
    : join(globalConfigDir, "preferences", "workflow-categories.yaml");

  return {
    language: languageValue,
    builtinEnabled,
    disabledBuiltins,
    categoriesPath,
    globalConfigDir,
  };
}

function readOptionalMapping(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be parsed: ${errorMessage(error)}`);
  }
  if (raw === null || raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new Error(`${label} must be a YAML mapping`);
  }
  return raw;
}

async function loadCategoryConfig(
  config: WorkflowConfigValues,
  options: WorkflowCatalogOptions,
  errors: string[],
): Promise<ParsedCategoryConfig> {
  const userConfig = loadCategoryOverlayIfPresent(config.categoriesPath, errors);
  if (!config.builtinEnabled) {
    return Promise.resolve(userConfig);
  }

  const taktRoot = await resolveTaktInstallRoot(options.taktCommand ?? "takt");
  const builtinConfig = taktRoot
    ? loadCategoryOverlayIfPresent(
      join(taktRoot, "builtins", config.language, "workflow-categories.yaml"),
      errors,
    )
    : { categories: [], descriptions: {} };
  const categories = userConfig.categories.length > 0
    ? [
      ...userConfig.categories,
      { name: "builtin", workflows: [], children: builtinConfig.categories },
    ]
    : builtinConfig.categories;
  return Promise.resolve({
    categories,
    descriptions: { ...builtinConfig.descriptions, ...userConfig.descriptions },
    showOthersCategory: userConfig.showOthersCategory ?? builtinConfig.showOthersCategory,
    othersCategoryName: userConfig.othersCategoryName ?? builtinConfig.othersCategoryName,
  });
}

function loadCategoryOverlayIfPresent(path: string, errors: string[]): ParsedCategoryConfig {
  if (!existsSync(path)) {
    return { categories: [], descriptions: {} };
  }
  try {
    return parseCategoryConfig(readOptionalMapping(path, `TAKT workflow categories (${path})`), path);
  } catch (error) {
    errors.push(errorMessage(error));
    return { categories: [], descriptions: {} };
  }
}

function parseCategoryConfig(raw: Record<string, unknown>, source: string): ParsedCategoryConfig {
  const categoriesRaw = raw.workflow_categories;
  if (categoriesRaw !== undefined && !isRecord(categoriesRaw)) {
    throw new Error(`workflow_categories must be a mapping in ${source}`);
  }
  const categories = categoriesRaw === undefined
    ? []
    : parseCategoryNodes(categoriesRaw, source, []);
  const descriptions: Record<string, string> = {};
  collectCategoryDescriptions(raw, descriptions);
  return {
    categories,
    descriptions,
    ...(typeof raw.show_others_category === "boolean"
      ? { showOthersCategory: raw.show_others_category }
      : {}),
    ...(typeof raw.others_category_name === "string" && raw.others_category_name.trim()
      ? { othersCategoryName: raw.others_category_name.trim() }
      : {}),
  };
}

function parseCategoryNodes(
  raw: Record<string, unknown>,
  source: string,
  parentPath: string[],
): WorkflowCategoryNode[] {
  return Object.entries(raw).map(([name, value]) => {
    if (!isRecord(value)) {
      throw new Error(`workflow category ${[...parentPath, name].join(" / ")} must be a mapping in ${source}`);
    }
    const workflows = parseCategoryWorkflowNames(value.workflows, source, [...parentPath, name]);
    const childRaw = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "workflows"));
    return {
      name,
      workflows,
      children: parseCategoryNodes(childRaw, source, [...parentPath, name]),
    };
  });
}

function parseCategoryWorkflowNames(raw: unknown, source: string, path: string[]): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`workflows must be an array in ${source} at ${path.join(" / ")}`);
  }
  return raw.map((item) => {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
    if (isRecord(item)) {
      const pairs = Object.entries(item);
      if (pairs.length === 1 && typeof pairs[0]?.[0] === "string") {
        const name = pairs[0][0].trim();
        if (name) {
          return name;
        }
      }
    }
    throw new Error(`workflow category entry must name one workflow in ${source} at ${path.join(" / ")}`);
  });
}

function collectCategoryDescriptions(
  raw: Record<string, unknown>,
  descriptions: Record<string, string>,
): void {
  const visitRaw = (nodes: Record<string, unknown>): void => {
    for (const value of Object.values(nodes)) {
      if (!isRecord(value)) {
        continue;
      }
      if (Array.isArray(value.workflows)) {
        for (const item of value.workflows) {
          if (!isRecord(item)) {
            continue;
          }
          const pairs = Object.entries(item);
          const [name, description] = pairs[0] ?? [];
          if (pairs.length === 1 && typeof name === "string" && typeof description === "string") {
            descriptions[name] = description;
          }
        }
      }
      visitRaw(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "workflows")));
    }
  };
  const categoriesRaw = raw.workflow_categories;
  if (isRecord(categoriesRaw)) {
    visitRaw(categoriesRaw);
  }
}

function filterCategoryTree(categories: WorkflowCategoryNode[], available: Set<string>): WorkflowCategoryNode[] {
  return categories.flatMap((category) => {
    const workflows = category.workflows.filter((name) => available.has(name));
    const children = filterCategoryTree(category.children, available);
    return workflows.length > 0 || children.length > 0
      ? [{ name: category.name, workflows, children }]
      : [];
  });
}

function collectCategorizedWorkflowNames(categories: WorkflowCategoryNode[]): Set<string> {
  const names = new Set<string>();
  for (const category of categories) {
    for (const name of category.workflows) {
      names.add(name);
    }
    for (const name of collectCategorizedWorkflowNames(category.children)) {
      names.add(name);
    }
  }
  return names;
}

function collectWorkflowCategoryPaths(categories: WorkflowCategoryNode[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const visit = (nodes: WorkflowCategoryNode[], parent: string[]): void => {
    for (const node of nodes) {
      const path = [...parent, node.name].join(" / ");
      for (const workflow of node.workflows) {
        result.set(workflow, [path]);
      }
      visit(node.children, [...parent, node.name]);
    }
  };
  visit(categories, []);
  return result;
}

function collectEffectiveLayer(
  target: Map<string, { layer: TaktWorkflowLayer; file: WorkflowFile }>,
  files: WorkflowFile[],
  layer: TaktWorkflowLayer,
): void {
  for (const file of files) {
    if (!target.has(file.name)) {
      target.set(file.name, { layer, file });
    }
  }
}

function listWorkflowFiles(dir: string): WorkflowFile[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: WorkflowFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && WORKFLOW_EXTENSIONS.test(entry.name)) {
      files.push({ name: entry.name.replace(WORKFLOW_EXTENSIONS, ""), path: join(dir, entry.name) });
      continue;
    }
    if (!entry.isDirectory() || entry.name === "provider-options") {
      continue;
    }
    const categoryDir = join(dir, entry.name);
    for (const nested of readdirSync(categoryDir, { withFileTypes: true })) {
      if (nested.isFile() && WORKFLOW_EXTENSIONS.test(nested.name)) {
        files.push({
          name: `${entry.name}/${nested.name.replace(WORKFLOW_EXTENSIONS, "")}`,
          path: join(categoryDir, nested.name),
          category: entry.name,
        });
      }
    }
  }
  return files;
}

function findWorkflowFileInDir(dir: string, name: string): string | undefined {
  for (const extension of [".yaml", ".yml"]) {
    const candidate = join(dir, `${name}${extension}`);
    if (isPathInside(dir, candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function sanitizeWorkflowName(name: string): string {
  const normalized = name.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    return "";
  }
  return normalized;
}

function isPathInside(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rel = relative(rootResolved, candidateResolved);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${normalize("/")}`) && !isAbsolute(rel));
}

function isCallableOrInternal(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return value.callable === true || value.visibility === "internal";
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pickStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function parseBooleanEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new Error(`${name} must be a boolean`);
}

function parseListEnv(name: string): string[] {
  const raw = process.env[name]?.trim() ?? "";
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return pickStringArray(parsed);
    }
  } catch {
    // TAKT documents JSON env values; comma-separated input is a harmless
    // compatibility convenience for shells that make JSON quoting awkward.
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function expandHomePath(value: string, globalConfigDir: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? value : resolve(globalConfigDir, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
