import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  assertValidTaktTaskExecutionPolicy,
  toTaktTaskFileOptions,
  type TaktTaskExecutionPolicy,
  type TaktTaskFileOptions,
} from "./takt-task-policy.ts";

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface TaktTaskQueueOptions {
  cwd: string;
}

export interface VerifiedTaktDirectEnqueueResult {
  taskName: string;
  tasksFile: string;
  workflow: string;
  expectedWorkflow: string;
  workflowVerified: true;
  status: "pending";
  executionOptions: TaktTaskFileOptions;
  expectedExecutionOptions: TaktTaskFileOptions;
  executionOptionsVerified: true;
  branch?: string;
  taskDir: string;
}

export class TaktDirectQueueVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaktDirectQueueVerificationError";
  }
}

interface PendingTaskRecord extends Record<string, unknown> {
  worktree: boolean;
  auto_pr: boolean;
  draft_pr: boolean;
  name: string;
  status: "pending";
  slug: string;
  summary: string;
  task_dir: string;
  created_at: string;
  started_at: null;
  completed_at: null;
  owner_pid: null;
  workflow: string;
  branch?: string;
}

export function extractWorkflowDirective(text: string): string | undefined {
  const matches = [...text.matchAll(/^\s*(?:[-*]\s+)?workflow\s*:\s*([^\s`#]+)\s*$/gim)];
  return matches.at(-1)?.[1]?.trim() || undefined;
}

export function extractBranchDirective(text: string): string | undefined {
  const matches = [...text.matchAll(/^\s*(?:[-*]\s+)?branch\s*:\s*([^\s`#]+)\s*$/gim)];
  return matches.at(-1)?.[1]?.trim() || undefined;
}

export class TaktTaskQueue {
  private readonly cwd: string;

  constructor(options: TaktTaskQueueOptions) {
    this.cwd = options.cwd;
  }

  async enqueue(task: string, policy: TaktTaskExecutionPolicy): Promise<VerifiedTaktDirectEnqueueResult> {
    assertValidTaktTaskExecutionPolicy(policy);
    const executionOptions = toTaktTaskFileOptions(policy);
    if (!task.trim()) {
      throw new Error("TAKT task must not be empty");
    }
    const workflow = extractWorkflowDirective(task);
    if (!workflow) {
      throw new Error("TAKT task must include an exact `workflow: <id>` directive before enqueueing");
    }
    const branch = extractBranchDirective(task);
    if (branch && !isValidGitBranchName(branch)) {
      throw new Error(`Invalid TAKT task branch: ${branch}`);
    }
    const summary = summarizeTask(task);
    const slug = slugify(summary);
    const taktDir = join(this.cwd, ".takt");
    const tasksRoot = join(taktDir, "tasks");
    const tasksFile = join(taktDir, "tasks.yaml");
    mkdirSync(tasksRoot, { recursive: true });
    const reserved = reserveTaskDirectory(tasksRoot, slug);
    let persisted = false;
    try {
      writeFileSync(join(reserved.absolute, "order.md"), task, { encoding: "utf8", flag: "wx" });
      const created = withTasksFileLock(tasksFile, () => {
        const state = readTaskState(tasksFile);
        assertNoActiveBranchConflict(state.tasks, branch);
        const name = uniqueName(slug, state.tasks);
        const record: PendingTaskRecord = {
          worktree: executionOptions.worktree,
          auto_pr: executionOptions.autoPr,
          draft_pr: executionOptions.draftPr,
          name,
          status: "pending",
          slug,
          summary,
          task_dir: reserved.relative,
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          owner_pid: null,
          workflow,
          ...(branch ? { branch } : {}),
        };
        writeTaskState(tasksFile, { tasks: [...state.tasks, record] });
        persisted = true;
        const saved = readTaskState(tasksFile).tasks.at(-1);
        if (!isRecord(saved)
          || saved.name !== name
            || saved.status !== "pending"
            || saved.workflow !== workflow
            || saved.task_dir !== reserved.relative
            || saved.worktree !== executionOptions.worktree
            || saved.auto_pr !== executionOptions.autoPr
            || saved.draft_pr !== executionOptions.draftPr
            || (branch !== undefined && saved.branch !== branch)) {
          throw new TaktDirectQueueVerificationError(
            "Direct TAKT queue verification failed after writing tasks.yaml; the pending task was preserved and execution is blocked",
          );
        }
        return record;
      });
      return {
        taskName: created.name,
        tasksFile,
        workflow,
        expectedWorkflow: workflow,
        workflowVerified: true,
        status: "pending",
        executionOptions,
        expectedExecutionOptions: executionOptions,
        executionOptionsVerified: true,
        ...(branch ? { branch } : {}),
        taskDir: reserved.relative,
      };
    } catch (error) {
      if (!persisted) {
        rmSync(reserved.absolute, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    // Direct queue writes do not keep a child process or session open.
  }
}

function readTaskState(tasksFile: string): { tasks: Record<string, unknown>[] } {
  if (!existsSync(tasksFile)) {
    return { tasks: [] };
  }
  let value: unknown;
  try {
    value = parseYaml(readFileSync(tasksFile, "utf8"));
  } catch (error) {
    throw new Error(`Invalid tasks.yaml: ${tasksFile}. ${errorMessage(error)}`);
  }
  if (!isRecord(value) || !Array.isArray(value.tasks) || !value.tasks.every(isRecord)) {
    throw new Error(`Invalid tasks.yaml: ${tasksFile}. Expected a top-level tasks array.`);
  }
  return { tasks: value.tasks };
}

function writeTaskState(tasksFile: string, state: { tasks: Record<string, unknown>[] }): void {
  const temporary = `${tasksFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, stringifyYaml(state), "utf8");
    renameSync(temporary, tasksFile);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function reserveTaskDirectory(tasksRoot: string, slug: string): { absolute: string; relative: string } {
  const timestamp = compactTimestamp(new Date());
  for (let sequence = 1; ; sequence += 1) {
    const suffix = sequence === 1 ? "" : `-${sequence}`;
    const directoryName = `${timestamp}-${slug}${suffix}`;
    const absolute = join(tasksRoot, directoryName);
    try {
      mkdirSync(absolute);
      return { absolute, relative: `.takt/tasks/${directoryName}` };
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) {
        throw error;
      }
    }
  }
}

function withTasksFileLock<T>(tasksFile: string, action: () => T): T {
  const lockFile = `${tasksFile}.lock`;
  mkdirSync(dirname(tasksFile), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const descriptor = openSync(lockFile, "wx", 0o600);
      writeSync(descriptor, `${process.pid}\n`);
      closeSync(descriptor);
      break;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) {
        throw error;
      }
      removeStaleLock(lockFile);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for TAKT task lock: ${lockFile}`);
      }
      Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_DELAY_MS);
    }
  }
  try {
    return action();
  } finally {
    try {
      unlinkSync(lockFile);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

function removeStaleLock(lockFile: string): void {
  let stale = false;
  try {
    const pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        stale = isFileSystemError(error, "ESRCH");
      }
    }
    if (!stale) {
      stale = Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS;
    }
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return;
    }
  }
  if (stale) {
    try {
      unlinkSync(lockFile);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

function assertNoActiveBranchConflict(tasks: Record<string, unknown>[], branch: string | undefined): void {
  if (!branch) {
    return;
  }
  const conflict = tasks.find((task) =>
    task.branch === branch && (task.status === "pending" || task.status === "running"));
  if (conflict) {
    throw new Error(
      `Active task target already exists: branch=${branch} (${String(conflict.name ?? "unknown")}, ${String(conflict.status)})`,
    );
  }
}

function uniqueName(slug: string, tasks: Record<string, unknown>[]): string {
  const names = new Set(tasks.map((task) => task.name).filter((name): name is string => typeof name === "string"));
  if (!names.has(slug)) {
    return slug;
  }
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `${slug}-${sequence}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
}

function summarizeTask(task: string): string {
  const lines = task.trim().split(/\r?\n/);
  const selected = lines.find((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !/^(?:[-*]\s+)?(?:workflow|branch)\s*:/i.test(trimmed);
  }) ?? "task";
  return selected.replace(/^#+\s*/, "").trim().slice(0, 80) || "task";
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "task";
}

function isValidGitBranchName(value: string): boolean {
  return value.length > 0
    && !value.startsWith("-")
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.endsWith(".lock")
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !/(?:^|\/)\./.test(value)
    && !/[\u0000-\u0020\u007f~^:?*[\\]/.test(value);
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
