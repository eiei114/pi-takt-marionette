import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  resolveWorkflowCatalog,
  resolveWorkflowFilePath,
  type TaktWorkflowLayer,
} from "./takt-workflow-catalog.ts";

/** Workflow layers TAKT resolves in project → user → builtin order. */
export type { TaktWorkflowLayer } from "./takt-workflow-catalog.ts";
export { resetTaktRootCache, resolveTaktInstallRoot } from "./takt-workflow-catalog.ts";

export interface ResolvedWorkflowFile {
  name: string;
  layer: TaktWorkflowLayer;
  path: string;
}

export interface WorkflowStepRef {
  /** Runtime target key written into runtime.yaml targets.steps. */
  targetKey: string;
  stepName: string;
  /** Engine-local workflow the step belongs to after expansion. */
  workflowName: string;
  kind: string;
  /** Step already pins provider/model inline in workflow YAML. */
  pinnedInline: boolean;
  /** True when the step came from expanding a workflow_call one level down. */
  nested: boolean;
  /** Set for unexpandable workflow_call steps; model selection is unavailable. */
  unresolvedCall?: string;
}

/** Resolve a workflow name against project, user-global, then builtin layers. */
export async function resolveWorkflowFile(
  cwd: string,
  name: string,
  taktCommand = "takt",
): Promise<ResolvedWorkflowFile | undefined> {
  return resolveWorkflowFilePath(cwd, name, { taktCommand });
}

/** List workflow names visible to TAKT: project + user layers, then builtin en/ja. */
export async function listWorkflowNames(
  cwd: string,
  taktCommand = "takt",
): Promise<Array<{ name: string; layer: TaktWorkflowLayer }>> {
  const catalog = await resolveWorkflowCatalog(cwd, { taktCommand });
  return catalog.workflows
    .map(({ name, layer }) => ({ name, layer }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Collect selectable steps for a workflow. Top-level workflow_call steps
 * expand exactly one level so nested steps stay individually addressable via
 * `<workflow>/<step>` runtime targets; deeper or unresolvable calls surface
 * as explicit `unresolvedCall` markers without blocking the rest.
 */
export async function collectSelectableSteps(
  cwd: string,
  workflowName: string,
  taktCommand = "takt",
): Promise<{ root: ResolvedWorkflowFile; steps: WorkflowStepRef[] }> {
  const root = await resolveWorkflowFile(cwd, workflowName, taktCommand);
  if (root === undefined) {
    throw new Error(
      `Workflow "${workflowName}" was not found in .takt/workflows, ~/.takt/workflows, or TAKT builtins`,
    );
  }

  const steps: WorkflowStepRef[] = [];
  const expandedCalls = new Set<string>();

  const processParsed = async (
    parsed: ParsedWorkflowFile,
    nested: boolean,
  ): Promise<void> => {
    for (const raw of parsed.steps) {
      if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
        continue;
      }
      const stepName = raw.name.trim();
      const kind = typeof raw.kind === "string" ? raw.kind : "agent";
      if (kind === "system") {
        continue;
      }
      const pinnedInline = raw.provider !== undefined || raw.model !== undefined;

      if (kind === "workflow_call") {
        const callTarget = typeof raw.call === "string" ? raw.call.trim() : "";
        if (!nested && callTarget.length > 0 && !expandedCalls.has(callTarget)) {
          expandedCalls.add(callTarget);
          const called = await resolveWorkflowFile(cwd, callTarget, taktCommand);
          if (called !== undefined) {
            await processParsed(parseWorkflowFile(called.path), true);
            continue;
          }
        }
        steps.push({
          targetKey: `${parsed.name}/${stepName}`,
          stepName,
          workflowName: parsed.name,
          kind,
          pinnedInline,
          nested,
          ...(callTarget.length > 0 ? { unresolvedCall: callTarget } : {}),
        });
        continue;
      }

      steps.push({
        targetKey: `${parsed.name}/${stepName}`,
        stepName,
        workflowName: parsed.name,
        kind,
        pinnedInline,
        nested,
      });
    }
  };

  await processParsed(parseWorkflowFile(root.path), false);

  // Nested expansion can duplicate step names when the same sub-workflow is
  // called twice; keep the first occurrence per runtime target key.
  const unique = new Map(steps.map((step) => [step.targetKey, step]));
  return { root, steps: [...unique.values()] };
}

interface ParsedWorkflowFile {
  name: string;
  steps: Array<Record<string, unknown>>;
}

function parseWorkflowFile(filePath: string): ParsedWorkflowFile {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Workflow YAML could not be parsed (${filePath}): ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Workflow file is not a mapping: ${filePath}`);
  }
  return {
    name: typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : filePath,
    steps: Array.isArray(parsed.steps) ? parsed.steps.filter(isRecord) : [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
