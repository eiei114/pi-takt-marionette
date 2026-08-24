import type { TaktExecStage } from "./takt-exec-stage.ts";
import type { TaktRunSnapshot } from "./takt-types.ts";

const DEFAULT_PROGRESS_WIDTH = 80;
const MIN_BAR_WIDTH = 8;
const MAX_BAR_WIDTH = 20;
const WORKFLOW_PHASE_NAMES = ["execute", "report", "judge"] as const;
const BRIDGE_PROGRESS_STAGES = [
  "clearing",
  "starting",
  "waiting_prompt",
  "pasting",
  "sending_go",
  "running",
] as const satisfies readonly TaktExecStage[];

export interface TaktWorkflowProgressOptions {
  run?: TaktRunSnapshot;
  bridgeStage?: TaktExecStage;
  width?: number;
}

/**
 * Render one compact, ASCII-art-like progress line for the live widget.
 * Workflow metadata wins over bridge lifecycle stages when both are present.
 */
export function renderTaktWorkflowProgress({
  run,
  bridgeStage,
  width = DEFAULT_PROGRESS_WIDTH,
}: TaktWorkflowProgressOptions): string | undefined {
  if (run && isActiveRun(run)) {
    return renderRunProgress(run, width);
  }
  if (bridgeStage) {
    return renderBridgeProgress(bridgeStage, width);
  }
  return undefined;
}

function renderRunProgress(run: TaktRunSnapshot, width: number): string | undefined {
  const workflow = workflowLabel(run);
  const steps = run.workflowSteps?.filter((step) => step.length > 0) ?? [];
  const currentStep = run.currentStep?.trim();
  const currentIndex = currentStep ? steps.indexOf(currentStep) : -1;
  const phase = run.phase;
  const phaseSuffix = phase
    ? ` · p${phase}/3 ${WORKFLOW_PHASE_NAMES[phase - 1]}`
    : "";
  const iterationSuffix = run.currentIteration !== undefined
    ? ` · i${run.currentIteration}`
    : "";

  if (currentIndex >= 0) {
    const position = currentIndex + 1;
    return buildProgressLine(
      `flow ${workflow}`,
      position,
      steps.length,
      `step: ${currentStep}${phaseSuffix}${iterationSuffix}`,
      width,
    );
  }

  if (phase) {
    return buildProgressLine(
      `flow ${workflow}`,
      phase,
      WORKFLOW_PHASE_NAMES.length,
      `${WORKFLOW_PHASE_NAMES[phase - 1]}${currentStep ? ` · step: ${currentStep}` : ""}${iterationSuffix}`,
      width,
    );
  }

  if (currentStep) {
    return `flow ${workflow} [>----------------] ${currentStep}${iterationSuffix}`;
  }

  return undefined;
}

function renderBridgeProgress(stage: TaktExecStage, width: number): string | undefined {
  const index = BRIDGE_PROGRESS_STAGES.indexOf(stage as (typeof BRIDGE_PROGRESS_STAGES)[number]);
  if (index < 0) {
    return undefined;
  }
  const position = index + 1;
  const label = stage.replaceAll("_", " ");
  return buildProgressLine(
    "bridge",
    position,
    BRIDGE_PROGRESS_STAGES.length,
    `stage ${label}`,
    width,
  );
}

function buildProgressLine(
  prefix: string,
  position: number,
  total: number,
  detail: string,
  width: number,
): string {
  const safeWidth = Number.isFinite(width) ? Math.max(24, Math.floor(width)) : DEFAULT_PROGRESS_WIDTH;
  const suffix = `${position}/${total} ${detail}`;
  const barWidth = Math.max(
    MIN_BAR_WIDTH,
    Math.min(MAX_BAR_WIDTH, safeWidth - prefix.length - suffix.length - 4),
  );
  return `${prefix} ${asciiProgressBar(position, total, barWidth)} ${suffix}`;
}

function asciiProgressBar(position: number, total: number, width: number): string {
  const safeTotal = Math.max(1, total);
  const safePosition = Math.max(1, Math.min(safeTotal, position));
  const markerOffset = safeTotal === 1
    ? 0
    : Math.round(((safePosition - 1) / (safeTotal - 1)) * (width - 1));
  return `[${"#".repeat(markerOffset)}>${"-".repeat(Math.max(0, width - markerOffset - 1))}]`;
}

function isActiveRun(run: TaktRunSnapshot): boolean {
  return run.status === "running" || run.status === "stale" ||
    run.sessionStatus === "live" || run.sessionStatus === "stale";
}

/** Keep the resolved workflow source visible so duplicate names stay distinguishable. */
export function workflowLabel(run: Pick<TaktRunSnapshot, "workflow" | "workflowSource">): string {
  const normalized = run.workflow.trim().replaceAll(/\s+/g, " ");
  if (normalized.length === 0) {
    return "workflow";
  }
  return run.workflowSource ? `${normalized} · ${run.workflowSource}` : normalized;
}
