import { renderTaktWorkflowProgress } from "./takt-progress.ts";
import { elideMiddle } from "./takt-live-panel.ts";
import { formatTaktLastExit, type TaktRunLogDiagnostics, type TaktRunSnapshot, type TaktSummary } from "./takt-types.ts";

const DEFAULT_WIDTH = 96;
const MAX_LOG_DETAIL_PARTS = 4;

export function renderTaktWidget(summary: TaktSummary, width = DEFAULT_WIDTH): string[] | undefined {
  const hasSomethingToShow = summary.running + summary.pending + summary.blocked + summary.failed + summary.stale > 0;
  if (!hasSomethingToShow) {
    return undefined;
  }

  const marker = summary.stale > 0 || summary.failed > 0 ? "⚠" : "●";
  const lines = [
    `TAKT ${marker} ${summary.running} running · ${summary.pending} pending · ${summary.blocked} blocked`,
  ];

  const activeRuns = summary.runs.filter((run) => run.status === "running" || run.status === "stale").slice(0, 2);
  for (const run of activeRuns) {
    lines.push(renderRunLine(run, width));
  }
  if (summary.failed > 0 && summary.lastError) {
    lines.push(`↳ failed: ${truncate(summary.lastError, Math.max(20, width - 12))}`);
  }
  return lines;
}

export function renderTaktDetails(summary: TaktSummary): string[] {
  const lines = [
    "TAKT status",
    `project: ${summary.cwd}`,
    `running: ${summary.running}`,
    `pending: ${summary.pending}`,
    `blocked: ${summary.blocked}`,
    `failed: ${summary.failed}`,
    `completed: ${summary.completed}`,
  ];

  lines.push(`session: ${summary.status}`);
  const activeRun = summary.runs.find((run) =>
    run.status === "running" || run.status === "stale" ||
    run.sessionStatus === "live" || run.sessionStatus === "stale",
  );
  const progress = renderTaktWorkflowProgress({ run: activeRun });
  if (progress) {
    lines.push(progress);
  }
  if (summary.pid !== undefined) {
    lines.push(`pid: ${summary.pid}`);
  }
  if (summary.stage) {
    lines.push(`stage: ${summary.stage}`);
  }
  if (summary.lastExit) {
    lines.push(`last exit: ${formatTaktLastExit(summary.lastExit)}`);
  }

  const diagnosticRun = summary.runs.find((run) =>
    run.status === "running" || run.status === "stale" || run.status === "failed",
  );
  const logDetails = renderLogDetails(diagnosticRun?.logDiagnostics);
  if (logDetails) {
    lines.push(logDetails);
  }

  if (summary.runs.length === 0) {
    lines.push("runs: none");
  } else {
    lines.push("runs:");
    for (const run of summary.runs.slice(0, 8)) {
      const step = run.currentStep ? ` · step ${run.currentStep}` : "";
      lines.push(`- ${run.sessionStatus}: ${run.task}${step}`);
    }
  }
  if (summary.lastError) {
    lines.push(`last error: ${summary.lastError}`);
  }
  return lines;
}

function renderLogDetails(logDiagnostics: TaktRunLogDiagnostics | undefined): string | undefined {
  if (!logDiagnostics) {
    return undefined;
  }
  if (!logDiagnostics.available) {
    const malformed = logDiagnostics.skippedLines ? ` · ${logDiagnostics.skippedLines} malformed` : "";
    if (logDiagnostics.reason === "no_logs") {
      return `log details: no logs${malformed}`;
    }
    return `log details: unavailable (${logDiagnostics.reason})${malformed}`;
  }

  const parts: string[] = [];
  if (logDiagnostics.step) {
    parts.push(`step ${logDiagnostics.step}`);
  }
  if (logDiagnostics.phase) {
    parts.push(`phase ${logDiagnostics.phase}`);
  }
  if (logDiagnostics.workers) {
    parts.push(`workers ${logDiagnostics.workers.done}/${logDiagnostics.workers.total}`);
  }
  if (logDiagnostics.eventType) {
    parts.push(logDiagnostics.eventType.replaceAll("_", " "));
  }
  if (logDiagnostics.status) {
    parts.push(logDiagnostics.status);
  }
  if (logDiagnostics.message) {
    parts.push(`error: ${logDiagnostics.message}`);
  }
  if (parts.length === 0) {
    return "log details: no recent events";
  }
  return `log details: ${parts.slice(0, MAX_LOG_DETAIL_PARTS).join(" · ")}`;
}

function renderRunLine(run: TaktRunSnapshot, width: number): string {
  const prefix = `↳ ${run.sessionStatus}: `;
  const stepWidth = run.currentStep ? Math.max(0, Math.round(width * 0.25)) : 0;
  const taskWidth = Math.max(0, width - prefix.length - stepWidth);
  const task = elideMiddle(run.task, taskWidth);
  const stepText = run.currentStep ? ` · ${elideMiddle(run.currentStep, stepWidth)}` : "";
  return `${prefix}${task}${stepText}`;
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return "…";
  }
  return `${value.slice(0, maxLength - 1)}…`;
}
