import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey, Key, Text } from "@earendil-works/pi-tui";
import { TaktAcpClient, type TaktEnqueueResult } from "../lib/takt-acp-client.ts";
import {
  cycleTaktInputMode,
  describeTaktInputMode,
  formatTaktInputModeLine,
  isDestructiveTaktAutoInput,
  parseTaktInputMode,
  type TaktInputMode,
} from "../lib/takt-input-mode.ts";
import {
  createTaktProjectStackWidget,
  renderTaktTerminal,
  visibleWidgetLines,
  type TaktProjectStackSource,
  type TaktProjectWidgetEntry,
} from "../lib/takt-live-panel.ts";
import {
  loadProjectPaths,
  normalizeProjectPath,
  projectPathKey,
  saveProjectPaths,
} from "../lib/takt-project-registry.ts";
import {
  loadTaktProfiles,
  normalizeProfileName,
  saveTaktProfiles,
  type TaktProjectProfile,
} from "../lib/takt-profile-registry.ts";
import {
  formatTaktExecStage,
  shouldOverlayPromptPreview,
  summarizeTaktPrompt,
  type TaktExecStage,
} from "../lib/takt-exec-stage.ts";
import {
  formatTaktPastedInput,
  TaktRunController,
  terminalContainsText,
  terminalEndsWithText,
} from "../lib/takt-run-controller.ts";
import {
  setupProjectLocalTakt,
  type TaktProjectSetupResult,
} from "../lib/takt-project-setup.ts";
import {
  readTaktSummary,
  reconcileRunAsAborted,
  type TaktStateOptions,
  readTaskItems,
} from "../lib/takt-state.ts";
import {
  formatTaktLastExit,
  hasRecentTaktSummaryActivity,
  type TaktLastExit,
  type TaktSessionStatus,
  type TaktSummary,
} from "../lib/takt-types.ts";
import { renderTaktDetails } from "../lib/takt-widget.ts";
import {
  describeActiveRun,
  formatElapsed,
  heartbeat,
  sessionRow,
  taktSpinnerFrame,
} from "../lib/takt-live-panel.ts";
import { workflowLabel } from "../lib/takt-progress.ts";
import { removeTaktTask, resetTaktTaskToPending, readTaktTaskFile } from "../lib/takt-task-edit.ts";
import { type TaktTaskFileEntry } from "../lib/takt-task-edit.ts";
import { parseSessionMention, resolveSessionByMention } from "../lib/takt-session-mention.ts";
import {
  collectSelectableSteps,
  listWorkflowNames,
  type WorkflowStepRef,
} from "../lib/takt-workflow-steps.ts";
import {
  applyStepModelSelections,
  type StepModelSelection,
} from "../lib/takt-runtime-yaml.ts";
import { formatPiModelRef, listPiModels } from "../lib/takt-pi-models.ts";
import {
  orderTaktFocusSessions,
  TaktFullscreenFocusView,
  type TaktFocusExitResult,
  type TaktFocusSession,
} from "../lib/takt-focus-view.ts";
import { SearchableListController } from "../lib/takt-search-select.ts";
import { createTaktInputQueue, type TaktInputQueue } from "../lib/takt-input-queue.ts";
import { setTaktLang, taktLang, toggleTaktLang, type TaktLang } from "../lib/takt-i18n.ts";

const WIDGET_KEY = "pi-takt-marionette-projects";
const STATUS_KEY = "pi-takt-marionette-input-mode";
const REFRESH_ERROR_STATUS_KEY = "pi-takt-marionette-refresh-error";
const REFRESH_INTERVAL_MS = 2_000;
const TAKT_INPUT_PROMPT_TIMEOUT_MS = 15_000;
const TAKT_ASSISTANT_REPLY_TIMEOUT_MS = 120_000;
const TAKT_GO_ACCEPT_TIMEOUT_MS = 15_000;
const TAKT_GO_OUTPUT_DRAIN_GRACE_MS = 250;
const TAKT_RESUME_MENU_TIMEOUT_MS = 15_000;
const TAKT_LIFECYCLE_TIMEOUT_MS = 10_000;
const TAKT_AUTO_SCREEN_ROWS = 24;

function defaultProfileName(cwd: string): string {
  const folder = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "project";
  const slug = folder
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";
  return normalizeProfileName(slug);
}

const TAKT_EXEC_PROMPT_PARAMETERS = Type.Object({
  profile: Type.Optional(Type.String({ description: "Named TAKT profile; defaults to pi-docs" })),
  prompt: Type.String({ description: "Exact task or issue body to paste into TAKT" }),
  clear: Type.Optional(Type.Boolean({
    description: "Run takt clear first; defaults to true; replace:true always clears",
  })),
  preset: Type.Optional(Type.String({ description: "Override the profile's exec preset" })),
  goMode: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("manual"),
  ], { description: "auto submits /go; manual waits at Assistant> without submitting; defaults to auto" })),
  sendGo: Type.Optional(Type.Boolean({
    description: "Legacy compatibility: false selects manual goMode; defaults to true",
  })),
  replace: Type.Optional(Type.Boolean({
    description: "Stop a running bridge-owned session before starting; defaults to true",
  })),
});

const TAKT_SUBMIT_GO_PARAMETERS = Type.Object({
  profile: Type.Optional(Type.String({
    description: "Named TAKT profile or project path; defaults to the active bridge-owned project",
  })),
});

const TAKT_STOP_PARAMETERS = Type.Object({
  profile: Type.Optional(Type.String({
    description: "Named TAKT profile or project path; defaults to the active running project",
  })),
  forceObserved: Type.Optional(Type.Boolean({
    description: "Mark observed stale/unknown running metadata aborted; never kills an external live PID",
  })),
});

const TAKT_RESUME_PARAMETERS = Type.Object({
  profile: Type.Optional(Type.String({
    description: "Named TAKT profile; defaults to pi-docs",
  })),
  provider: Type.Optional(Type.String({ description: "TAKT provider; defaults to pi" })),
  model: Type.Optional(Type.String({ description: "Provider model override, for example cursor/composer-2.5-fast" })),
  replace: Type.Optional(Type.Boolean({
    description: "Stop a running bridge-owned PTY before resume; defaults to true",
  })),
});

const TAKT_ENQUEUE_TASK_PARAMETERS = Type.Object({
  profile: Type.Optional(Type.String({
    description: "Named TAKT profile or exact project path; defaults to pi-docs",
  })),
  task: Type.String({ description: "Exact ready-to-run task body to queue; this does not start execution" }),
});

const TAKT_PROJECT_SETUP_PARAMETERS = Type.Object({
  profile: Type.Optional(Type.String({
    description: "Named profile; defaults to a safe slug from the target folder name",
  })),
  cwd: Type.Optional(Type.String({
    description: "Project folder; defaults to the current Pi project",
  })),
  preset: Type.Optional(Type.String({
    description: "Exec preset to make project-local; defaults to the existing profile preset or pi-docs",
  })),
  copyGlobalPreset: Type.Optional(Type.Boolean({
    description: "Copy only the selected preset from ~/.takt when the project does not have it",
  })),
  overwrite: Type.Optional(Type.Boolean({
    description: "Replace an existing profile only when its cwd differs",
  })),
});

const TAKT_SET_MODE_PARAMETERS = Type.Object({
  mode: Type.String({ description: "pi, takt, pi-auto, or cycle" }),
});

const TAKT_SEND_INPUT_PARAMETERS = Type.Object({
  text: Type.String({ description: "Exact text to paste into the active bridge-owned TAKT PTY" }),
  submit: Type.Optional(Type.Boolean({
    description: "Submit with bracketed paste + Enter; defaults to true",
  })),
});

const TAKT_READ_SCREEN_PARAMETERS = Type.Object({
  rows: Type.Optional(Type.Number({
    description: "Max trailing screen rows to return; defaults to 24",
  })),
});

type TaktBridgeStatus = Pick<TaktSummary, "status"> & Partial<Pick<TaktSummary, "pid" | "stage" | "lastExit">>;
type TaktBridgeEnqueueResult = TaktEnqueueResult & { project: string; cwd: string };

async function showStatus(
  ctx: ExtensionContext,
  cwd = ctx.cwd,
  bridgeStatus?: TaktBridgeStatus,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const summary = {
    ...await readTaktSummary(cwd, { includeTaskList: true }),
    ...bridgeStatus,
  };
  const lines = renderTaktDetails(summary);
  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      const text = new Text(
        lines.map((line) => theme.fg("text", line)).join("\n") +
          "\n\n" +
          theme.fg("dim", "Press Enter or Esc to close"),
        0,
        0,
      );

      return {
        render: (width: number) => text.render(width),
        invalidate: () => text.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
            done();
          }
        },
      };
    },
    { overlay: true },
  );
}

interface ManagedProject {
  id: string;
  cwd: string;
  label: string;
  acp: TaktAcpClient;
  runner: TaktRunController;
  summary?: TaktSummary;
  stage: TaktExecStage;
  promptPreview?: string;
  execTracking?: TaktExecTracking;
  queuedInputs?: TaktInputQueue;
}

interface TaktExecTracking {
  startedAt: number;
  baselineRunSlugs: Set<string>;
  runSlug?: string;
}

class TaktBridgeRuntime implements TaktProjectStackSource {
  private readonly projects = new Map<string, ManagedProject>();
  private readonly profiles = new Map<string, TaktProjectProfile>();
  private readonly listeners = new Set<() => void>();
  private context: ExtensionContext | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshInFlight = false;
  private statusRefreshErrorMessage: string | undefined;
  private statusRefreshErrorCount = 0;
  private liveWidgetVisible = false;
  private inputMode: TaktInputMode = "pi";
  /** Active fullscreen focus view; owns human input while takt mode runs. */
  private focusView: TaktFullscreenFocusView | undefined;
  private focusGeneration = 0;
  private focusViewOpenPromise: Promise<void> | undefined;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;

  constructor(cwd: string) {
    this.ensureProject(cwd);
  }

  getProjects(): readonly TaktProjectWidgetEntry[] {
    const currentProjectId = this.context ? projectPathKey(this.context.cwd) : undefined;
    return [...this.projects.values()].map((project) => ({
      id: project.id,
      label: project.label,
      cwd: project.cwd,
      isCurrent: project.id === currentProjectId,
      runner: project.runner,
      summary: project.summary,
      stage: project.stage,
      promptPreview: project.promptPreview,
      queueDepth: project.queuedInputs?.depth() ?? 0,
    }));
  }

  getInputMode(): TaktInputMode {
    return this.inputMode;
  }

  getProjectStatus(cwd: string): TaktBridgeStatus | undefined {
    const project = this.projects.get(projectPathKey(cwd));
    if (!project) {
      return undefined;
    }
    const snapshot = projectSessionSnapshot(project);
    return {
      status: snapshot.status,
      ...(snapshot.pid !== undefined ? { pid: snapshot.pid } : {}),
      ...(snapshot.stage ? { stage: snapshot.stage } : {}),
      ...(snapshot.lastExit ? { lastExit: snapshot.lastExit } : {}),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(context: ExtensionContext): void {
    this.context = context;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.initializeOnce();
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = undefined;
    }
  }

  private async initializeOnce(): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }

    for (const cwd of loadProjectPaths()) {
      try {
        this.ensureProject(cwd);
      } catch {
        // Keep a bad saved path from preventing Pi from starting.
      }
    }
    for (const profile of loadTaktProfiles()) {
      this.profiles.set(profile.name, profile);
      try {
        this.ensureProject(profile.cwd);
      } catch {
        // Keep a bad saved profile from preventing Pi from starting.
      }
    }
    try {
      await this.refreshProjects();
    } catch (error) {
      // A transient or malformed external TAKT state must not reject
      // session_start and make Pi report the extension as broken.
      this.recordStatusRefreshError(error);
    }
    this.refreshTimer = setInterval(() => {
      void this.refreshProjects()
        .then(() => this.clearStatusRefreshError())
        .catch((error) => this.recordStatusRefreshError(error));
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
    this.registerSessionMentionAutocomplete();
    this.initialized = true;
  }

  /** Stack TAKT session suggestions onto the built-in @ mention (file/path) completion. */
  private registerSessionMentionAutocomplete(): void {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    const runtimeRef = this;
    if (typeof context.ui.addAutocompleteProvider !== "function") {
      return;
    }
    context.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["@"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const match = /(?:^|[ 	])@([^\s@]*)$/.exec(beforeCursor);
        const builtIn = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        if (match === null) {
          return builtIn;
        }
        const query = (match[1] ?? "").toLocaleLowerCase();
        const sessionItems = runtimeRef.sessionCompletionEntries()
          .filter((entry) =>
            query.length === 0 ||
            entry.label.toLocaleLowerCase().includes(query) ||
            entry.cwd.toLocaleLowerCase().includes(query))
          .slice(0, 8)
          .map((entry) => ({
            value: `@${entry.label}`,
            label: `@${entry.label}`,
            description: `TAKT session · ${entry.cwd}`,
          }));
        if (sessionItems.length === 0) {
          return builtIn;
        }
        // TAKT sessions lead the list; file/path mentions stay underneath.
        const fileItems = (builtIn?.items ?? []).filter(
          (item) => !(item.value ?? "").startsWith("@"),
        );
        return {
          prefix: builtIn?.prefix ?? match[1] ?? "",
          items: [...sessionItems, ...fileItems],
        };
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
    }));
  }

  /** Labels + cwd for @ mention completion over known sessions. */
  private sessionCompletionEntries(): Array<{ label: string; cwd: string }> {
    return [...this.projects.values()]
      .filter((project) => project.runner.hasSession || project.runner.isRunning || project.summary !== undefined)
      .map((project) => ({ label: project.label, cwd: project.cwd }));
  }

  async enqueueTask(
    task: string,
    args = "",
    options: { throwOnError?: boolean } = {},
  ): Promise<TaktBridgeEnqueueResult | undefined> {
    const context = this.context;
    if (!context?.hasUI) {
      return undefined;
    }

    const project = args.trim()
      ? await this.selectProject(args, "Enqueue TAKT task in", () => true)
      : this.currentProject();
    if (!project) {
      return undefined;
    }
    return this.enqueueTaskInProject(project, task, options);
  }

  async enqueueProfileTask(
    profileName: string,
    task: string,
  ): Promise<TaktBridgeEnqueueResult> {
    const context = this.context;
    if (!context?.hasUI) {
      throw new Error("TAKT bridge requires an interactive Pi UI");
    }
    const profile = this.profiles.get(normalizeProfileName(profileName));
    if (!profile) {
      throw new Error(`TAKT profile not found: ${profileName}. Use takt_project_setup first.`);
    }
    const project = this.ensureProject(profile.cwd);
    await this.refreshProject(project, { includeTaskList: false });
    const result = await this.enqueueTaskInProject(project, task, { throwOnError: true });
    if (!result) {
      throw new Error(`TAKT task could not be queued in ${project.label}`);
    }
    return result;
  }

  private async enqueueTaskInProject(
    project: ManagedProject,
    task: string,
    options: { throwOnError?: boolean } = {},
  ): Promise<TaktBridgeEnqueueResult | undefined> {
    const context = this.context;
    if (!context?.hasUI) {
      return undefined;
    }
    try {
      if (!task.trim()) {
        throw new Error("TAKT task must not be empty");
      }
      const result = await project.acp.enqueue(task);
      context.ui.notify(`TAKT task queued for ${project.label} (worktree run).`, "info");
      await this.refreshProject(project, { includeTaskList: false });
      return { project: project.label, cwd: project.cwd, ...result };
    } catch (error) {
      context.ui.notify(`TAKT enqueue failed: ${errorMessage(error)}`, "error");
      if (options.throwOnError) {
        throw error;
      }
      return undefined;
    }
  }

  async runOrAttach(): Promise<void> {
    const project = this.currentProject();
    if (project.runner.hasSession) {
      await this.showLive();
      return;
    }
    await this.startPending("", project);
  }

  async startPending(args = "", selectedProject?: ManagedProject): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }

    const project = selectedProject ?? await this.selectProject(args, "Start TAKT in", () => true);
    if (!project) {
      return;
    }
    if (project.runner.isRunning) {
      await this.showLive();
      return;
    }
    if (!await this.refreshControlState(project)) {
      return;
    }
    if (blocksNewExecution(project.summary)) {
      await this.showLive();
      context.ui.notify(externalSessionError(project).message, "warning");
      return;
    }

    const confirmed = await context.ui.confirm(
      "Start TAKT",
      `Run all pending tasks in ${project.label}?\n${project.cwd}\nTAKT keeps its worktree setting.`,
    );
    if (!confirmed) {
      return;
    }

    try {
      project.runner.reconcile();
      if (project.runner.hasSession) {
        await project.runner.dispose();
      }
      await project.runner.start();
      await this.showLive();
    } catch (error) {
      context.ui.notify(`TAKT start failed for ${project.label}: ${errorMessage(error)}`, "error");
    }
  }

  async startExec(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }

    const profile = this.profileForArgument(args);
    const project = await this.selectProject(args, "Start TAKT exec in", (candidate) => !candidate.runner.isRunning);
    if (!project) {
      return;
    }
    if (!await this.refreshControlState(project)) {
      return;
    }
    if (blocksNewExecution(project.summary)) {
      await this.showLive();
      context.ui.notify(externalSessionError(project).message, "warning");
      return;
    }
    const preset = profile?.preset ?? await context.ui.input("TAKT exec preset", "Optional preset, e.g. pi-docs");
    if (preset === undefined) {
      return;
    }
    const confirmed = await context.ui.confirm(
      "Start fresh TAKT exec",
      `Start a new exec process in ${project.label}? --continue is not used.\n${project.cwd}`,
    );
    if (!confirmed) {
      return;
    }

    try {
      project.runner.reconcile();
      if (project.runner.hasSession) {
        await stopWaitDispose(project.runner, undefined, TAKT_LIFECYCLE_TIMEOUT_MS);
      }
      await project.runner.start(preset.trim() ? ["exec", preset.trim()] : ["exec"]);
      await this.showLive();
      context.ui.notify(`TAKT exec started for ${project.label}. Use /takt:send to paste input.`, "info");
    } catch (error) {
      context.ui.notify(`TAKT exec failed to start for ${project.label}: ${errorMessage(error)}`, "error");
    }
  }

  async clearSessions(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }

    const project = await this.selectProject(args, "Clear TAKT session in", () => true);
    if (!project) {
      return;
    }
    project.runner.reconcile();
    if (project.runner.isRunning) {
      context.ui.notify(`TAKT is running in ${project.label}; stop it before clearing.`, "warning");
      return;
    }
    if (!await this.refreshControlState(project)) {
      return;
    }
    if (blocksNewExecution(project.summary)) {
      context.ui.notify(`TAKT is running in ${project.label}; stop it before clearing.`, "warning");
      return;
    }
    const confirmed = await context.ui.confirm(
      "Clear TAKT session",
      `Run takt clear in ${project.label}? This removes the previous exec session state.\n${project.cwd}`,
    );
    if (!confirmed) {
      return;
    }

    try {
      if (project.runner.hasSession) {
        await stopWaitDispose(project.runner, undefined, TAKT_LIFECYCLE_TIMEOUT_MS);
      }
      await runTaktClear(project.runner, project.label, TAKT_LIFECYCLE_TIMEOUT_MS);
      await project.runner.dispose();
      context.ui.notify(`TAKT clear finished for ${project.label}.`, "info");
    } catch (error) {
      try {
        await stopWaitDispose(project.runner, undefined, TAKT_LIFECYCLE_TIMEOUT_MS);
      } catch (cleanupError) {
        context.ui.notify(
          `TAKT clear failed for ${project.label}: ${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`,
          "error",
        );
        return;
      }
      context.ui.notify(`TAKT clear failed for ${project.label}: ${errorMessage(error)}`, "error");
    }
  }

  async sendInput(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }

    const project = await this.selectProject(
      args,
      "Send input to TAKT",
      (candidate) => candidate.runner.isRunning,
    );
    if (!project?.runner.isRunning) {
      return;
    }
    const text = await context.ui.editor(`Input for ${project.label}`, "");
    if (text === undefined || !text.trim()) {
      return;
    }
    if (project.stage === "running") {
      const depth = project.queuedInputs?.enqueue(text) ?? 0;
      context.ui.notify(
        `⏳ TAKT ${project.label} is executing; input queued (⏳q${depth}). It flushes when the session is ready, or via /taktn:flush.`.replace("/taktn:", "/takt:"),
        "info",
      );
      return;
    }
    if (containsTaktGoCommand(text)) {
      this.beginExecTracking(project);
      this.setProjectStage(project, "running");
    }
    project.runner.write(formatTaktPastedInput(text));
    context.ui.notify(`Input sent to TAKT ${project.label}.`, "info");
  }

  /** Switch the pinned fullscreen-focus target via the command fallback.
  * Uses the exact same deterministic ordering and transition behavior as the
  * Ctrl+Alt+Up/Down shortcuts. */
  async switchTaktFocusSession(args = ""): Promise<void> {
    const direction = args.trim().toLowerCase();
    const delta = direction === "previous" || direction === "prev"
      ? -1
      : direction === "next"
      ? 1
      : 0;
    if (delta === 0) {
      this.context?.ui.notify("Usage: /takt:session previous|next", "warning");
      return;
    }
    if (this.inputMode !== "takt" || this.focusView === undefined) {
      this.context?.ui.notify(
        "TAKT session navigation requires fullscreen focus (takt mode).",
        "warning",
      );
      return;
    }
    this.focusView.switchTarget(delta);
  }

  async cycleOrSetInputMode(args = ""): Promise<TaktInputMode> {
    const parsed = parseTaktInputMode(args);
    if (!parsed) {
      this.context?.ui.notify(
        "Unknown TAKT input mode. Use pi, takt, pi-auto, or cycle.",
        "warning",
      );
      return this.inputMode;
    }
    if (parsed === "cycle") {
      return this.cycleInputMode();
    }
    return this.setInputMode(parsed);
  }

  async cycleInputMode(): Promise<TaktInputMode> {
    let next = cycleTaktInputMode(this.inputMode);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (next === "pi" || this.activeRunningProject()) {
        return this.setInputMode(next);
      }
      next = cycleTaktInputMode(next);
    }
    this.context?.ui.notify("No running bridge-owned TAKT session; staying in pi mode.", "warning");
    return this.setInputMode("pi");
  }

  async setInputMode(mode: TaktInputMode, options: { quiet?: boolean } = {}): Promise<TaktInputMode> {
    const context = this.context;
    if ((mode === "takt" || mode === "pi-auto") && !this.activeRunningProject()) {
      if (!options.quiet) {
        context?.ui.notify(`Cannot enter ${mode} mode without a running bridge-owned TAKT session.`, "warning");
      }
      mode = "pi";
    }

    this.inputMode = mode;

    if (mode === "takt") {
      // The fullscreen focused view becomes the single owner of human input;
      // no global terminal-input forwarding may run in parallel.
      void this.openTaktFullscreenFocus();
    } else {
      this.closeTaktFocusView("external-close");
    }

    this.syncInputModeStatus();
    this.notifyProjects();
    await this.showLive(false);
    if (!options.quiet && context?.hasUI) {
      context.ui.notify(`TAKT input mode: ${mode} — ${describeTaktInputMode(mode)}`, "info");
    }
    return this.inputMode;
  }

  async readActiveScreen(rows = TAKT_AUTO_SCREEN_ROWS): Promise<{
    mode: TaktInputMode;
    project?: string;
    cwd?: string;
    status: TaktSessionStatus;
    pid?: number;
    running: boolean;
    ptyRunning: boolean;
    stage: string;
    lastExit?: TaktLastExit;
    lines: string[];
  }> {
    const observedProject = this.activeRunningProject() ?? this.activeSessionProject() ?? this.activeObservedProject();
    if (observedProject && !observedProject.runner.isRunning) {
      // Reading an external/final screen is an explicit run-state diagnostic;
      // keep it independent from the task-store lock. Queue reconciliation is
      // reserved for the explicit status/control paths below.
      try {
        await this.refreshProject(observedProject, { includeTaskList: true });
      } catch (error) {
        if (!isTaktTaskListError(error)) {
          throw error;
        }
        await this.refreshProject(observedProject, { includeTaskList: false });
      }
    }
    const project = this.activeRunningProject() ?? this.activeSessionProject() ?? this.activeObservedProject();
    if (!project) {
      return {
        mode: this.inputMode,
        status: "unknown",
        running: false,
        ptyRunning: false,
        stage: "idle",
        lines: [],
      };
    }
    const maxRows = Math.max(1, Math.min(80, Math.floor(rows || TAKT_AUTO_SCREEN_ROWS)));
    const snapshot = projectSessionSnapshot(project);
    const lines = shouldUsePromptOverlay(project)
      ? [
          `stage: ${formatTaktExecStage(project.stage)}`,
          "prompt preview:",
          ...(project.promptPreview ?? "(prompt body omitted)").split("\n"),
        ]
      : project.runner.terminal
        ? visibleWidgetLines(renderTaktTerminal(project.runner.terminal), maxRows)
        : project.summary
          ? renderSummaryScreen(project.summary)
          : [];
    return {
      mode: this.inputMode,
      project: project.label,
      cwd: project.cwd,
      status: snapshot.status,
      ...(snapshot.pid !== undefined ? { pid: snapshot.pid } : {}),
      running: project.runner.isRunning && !isTerminalProjectStage(project.stage),
      ptyRunning: project.runner.isRunning,
      stage: snapshot.stage ?? "idle",
      ...(snapshot.lastExit ? { lastExit: snapshot.lastExit } : {}),
      lines,
    };
  }

  async sendAutoInput(
    text: string,
    options: { submit?: boolean } = {},
  ): Promise<{ project: string; cwd: string; submitted: boolean }> {
    const context = this.context;
    if (!context?.hasUI) {
      throw new Error("TAKT bridge requires an interactive Pi UI");
    }
    if (this.inputMode !== "pi-auto") {
      throw new Error("takt_send_input requires pi-auto mode. Use /takt:mode pi-auto or Ctrl+Alt+T.");
    }
    if (!text.trim()) {
      throw new Error("TAKT auto input must not be empty");
    }

    const project = this.activeRunningProject();
    if (!project) {
      await this.setInputMode("pi", { quiet: true });
      throw new Error("No running bridge-owned TAKT session for pi-auto input");
    }

    if (isDestructiveTaktAutoInput(text)) {
      const confirmed = await context.ui.confirm(
        "Confirm TAKT auto input",
        `Send potentially destructive input to ${project.label}?\n\n${text}`,
      );
      if (!confirmed) {
        throw new Error("Destructive TAKT auto input cancelled");
      }
    }

    const shouldSubmit = options.submit !== false;
    project.runner.write(shouldSubmit ? formatTaktPastedInput(text) : text);
    context.ui.notify(`Pi-auto sent input to TAKT ${project.label}.`, "info");
    this.notifyProjects();
    return { project: project.label, cwd: project.cwd, submitted: shouldSubmit };
  }

  async executePrompt(
    profileName = "pi-docs",
    prompt: string,
    options: {
      clear?: boolean;
      preset?: string;
      goMode?: "auto" | "manual";
      sendGo?: boolean;
      replace?: boolean;
    } = {},
    signal?: AbortSignal,
    onUpdate?: (message: string) => void,
  ): Promise<{
    profile: string;
    cwd: string;
    preset: string;
    goMode: "auto" | "manual";
    sentGo: boolean;
    awaitingGo: boolean;
    replaced: boolean;
  }> {
    const context = this.context;
    if (!context?.hasUI) {
      throw new Error("TAKT bridge requires an interactive Pi UI");
    }
    if (!prompt.trim()) {
      throw new Error("TAKT prompt must not be empty");
    }
    throwIfAborted(signal);

    const profile = this.profiles.get(normalizeProfileName(profileName));
    if (!profile) {
      throw new Error(`TAKT profile not found: ${profileName}. Use /takt:profile:add ${profileName}.`);
    }
    const preset = options.preset?.trim() || profile.preset?.trim();
    if (!preset) {
      throw new Error(`TAKT profile has no exec preset: ${profile.name}. Pass preset or update the profile.`);
    }

    const project = this.ensureProject(profile.cwd);
    await this.refreshProject(project, { includeTaskList: true });
    const replace = options.replace !== false;
    const shouldClear = replace || options.clear !== false;
    const goMode = options.goMode ?? (options.sendGo === false ? "manual" : "auto");
    let replaced = false;
    let preserveExistingSession = false;

    try {
      project.runner.reconcile();
      if (!project.runner.isRunning && blocksNewExecution(project.summary)) {
        throw externalSessionError(project);
      }
      if (project.runner.isRunning && !replace) {
        preserveExistingSession = true;
        throw new Error(`TAKT is already running in ${project.label}; stop it before starting another exec.`);
      }

      if (replace || project.runner.hasSession) {
        const wasRunning = project.runner.isRunning;
        if (wasRunning) {
          this.setProjectStage(project, "stopping", onUpdate, `Stopping running TAKT in ${project.label} for replace…`);
        }
        await stopWaitDispose(project.runner, signal, TAKT_LIFECYCLE_TIMEOUT_MS);
        replaced = wasRunning;
        if (wasRunning) {
          this.setProjectStage(project, "stopped", onUpdate, `Stopped TAKT in ${project.label}.`);
        }
      }

      await this.refreshProject(project, { includeTaskList: true });
      if (blocksNewExecution(project.summary)) {
        throw externalSessionError(project);
      }

      if (shouldClear) {
        this.setProjectStage(project, "clearing", onUpdate, `Clearing previous TAKT session in ${project.label}…`);
        await runTaktClear(project.runner, project.label, TAKT_LIFECYCLE_TIMEOUT_MS);
        await project.runner.dispose();
        throwIfAborted(signal);
      }

      this.beginExecTracking(project);
      this.setProjectStage(project, "starting", onUpdate, `Starting takt exec ${preset} in ${project.label}…`);
      await project.runner.start(["exec", preset]);
      await this.showLive(false);

      this.setProjectStage(project, "waiting_prompt", onUpdate, `Waiting for Assistant> in ${project.label}…`);
      await waitForTaktInputPrompt(project.runner, signal, TAKT_INPUT_PROMPT_TIMEOUT_MS);
      throwIfAborted(signal);

      project.promptPreview = summarizeTaktPrompt(prompt);
      this.setProjectStage(project, "pasting", onUpdate, `Pasting prompt into ${project.label}…`);
      const promptOutputVersion = project.runner.screenVersion;
      project.runner.write(formatTaktPastedInput(prompt));

      const promptIncludesGo = prompt.trim().endsWith("/go");
      const shouldWaitForGoPrompt = !promptIncludesGo;
      let awaitingGo = false;
      let sentGo = false;
      if (shouldWaitForGoPrompt) {
        this.setProjectStage(
          project,
          "waiting_go",
          onUpdate,
          `Waiting for TAKT to finish task clarification in ${project.label}…`,
        );
        await waitForFreshTaktInputPrompt(
          project.runner,
          promptOutputVersion,
          signal,
          TAKT_ASSISTANT_REPLY_TIMEOUT_MS,
        );
        throwIfAborted(signal);

        if (goMode === "manual") {
          awaitingGo = true;
          this.setProjectStage(
            project,
            "awaiting_go",
            onUpdate,
            `TAKT ready in ${project.label}; waiting for an explicit takt_submit_go call.`,
          );
          await this.setInputMode("pi-auto", { quiet: true });
          context.ui.notify(
            `TAKT task clarified for ${project.label}. Manual GO mode: /go was not sent.`,
            "info",
          );
          this.notifyProjects();
          return {
            profile: profile.name,
            cwd: project.cwd,
            preset,
            goMode,
            sentGo,
            awaitingGo,
            replaced,
          };
        }

        this.setProjectStage(project, "sending_go", onUpdate, `Sending /go to ${project.label}…`);
        if (!project.runner.isRunning) {
          const result = await project.runner.waitForExit();
          throw new Error(`takt exec exited before /go (exit ${result?.code ?? "unknown"})`);
        }
        const goOutputVersion = project.runner.screenVersion;
        // `/go` is a terminal command, not multiline editor content. Send raw
        // text + Enter so bracketed-paste markers cannot become task input.
        project.runner.write("/go\r");
        await waitForTaktInputAccepted(
          project.runner,
          goOutputVersion,
          signal,
          TAKT_GO_ACCEPT_TIMEOUT_MS,
        );
        sentGo = true;
      }

      this.setProjectStage(project, "running", onUpdate, `TAKT running in ${project.label}.`);
      await this.setInputMode("pi-auto", { quiet: true });
      context.ui.notify(
        `TAKT prompt submitted to ${project.label}${sentGo ? " with /go" : ""}. Input mode: pi-auto. Raw output remains in the Pi widget.`,
        "info",
      );
      this.notifyProjects();
      return { profile: profile.name, cwd: project.cwd, preset, goMode, sentGo, awaitingGo, replaced };
    } catch (error) {
      if (preserveExistingSession) {
        throw error;
      }

      const aborted = Boolean(signal?.aborted);
      const needsCleanup = project.runner.isRunning || project.runner.hasSession;
      try {
        if (project.runner.isRunning) {
          this.setProjectStage(
            project,
            "stopping",
            onUpdate,
            `Stopping TAKT in ${project.label} after ${aborted ? "cancel" : "prompt submission failure"}…`,
          );
        }
        await stopWaitDispose(project.runner, undefined, TAKT_LIFECYCLE_TIMEOUT_MS);
      } catch (cleanupError) {
        this.setProjectStage(project, "failed");
        throw new Error(`${errorMessage(error)}; TAKT cleanup failed: ${errorMessage(cleanupError)}`);
      }
      if (needsCleanup) {
        this.setProjectStage(project, aborted ? "stopped" : "failed");
      }
      throw error;
    }
  }

  async submitGo(
    args = "",
    signal?: AbortSignal,
    onUpdate?: (message: string) => void,
  ): Promise<{ project: string; cwd: string; sentGo: true }> {
    const context = this.context;
    if (!context?.hasUI) {
      throw new Error("TAKT bridge requires an interactive Pi UI");
    }
    const project = args.trim()
      ? this.ensureProject(this.resolveTargetPath(args, context.cwd))
      : this.activeRunningProject();
    if (!project?.runner.isRunning) {
      throw new Error("No running bridge-owned TAKT session is waiting for /go");
    }
    if (project.stage !== "awaiting_go") {
      throw new Error(`TAKT is not in manual GO mode for ${project.label} (stage: ${project.stage})`);
    }
    await waitForTaktInputPrompt(project.runner, signal, TAKT_INPUT_PROMPT_TIMEOUT_MS);
    this.setProjectStage(project, "sending_go", onUpdate, `Sending explicit /go to ${project.label}…`);
    const goOutputVersion = project.runner.screenVersion;
    project.runner.write("/go\r");
    await waitForTaktInputAccepted(project.runner, goOutputVersion, signal, TAKT_GO_ACCEPT_TIMEOUT_MS);
    this.setProjectStage(project, "running", onUpdate, `TAKT running in ${project.label}.`);
    await this.setInputMode("pi-auto", { quiet: true });
    context.ui.notify(`TAKT /go submitted to ${project.label}.`, "info");
    return { project: project.label, cwd: project.cwd, sentGo: true };
  }

  async resumeRun(
    profileName = "pi-docs",
    options: { provider?: string; model?: string; replace?: boolean } = {},
    signal?: AbortSignal,
    onUpdate?: (message: string) => void,
  ): Promise<{ profile: string; cwd: string; provider: string; model?: string; replaced: boolean }> {
    const context = this.context;
    if (!context?.hasUI) {
      throw new Error("TAKT bridge requires an interactive Pi UI");
    }
    const profile = this.profiles.get(normalizeProfileName(profileName));
    if (!profile) {
      throw new Error(`TAKT profile not found: ${profileName}. Run takt_project_setup first.`);
    }
    const project = this.ensureProject(profile.cwd);
    await this.refreshProject(project, { includeTaskList: true });
    const replace = options.replace !== false;
    let replaced = false;

    project.runner.reconcile();
    if (!project.runner.isRunning && blocksNewExecution(project.summary)) {
      throw externalSessionError(project);
    }
    if (project.runner.isRunning && !replace) {
      throw new Error(`TAKT is already running in ${project.label}; stop it before resuming.`);
    }
    if (replace || project.runner.hasSession) {
      replaced = project.runner.isRunning;
      await stopWaitDispose(project.runner, signal, TAKT_LIFECYCLE_TIMEOUT_MS);
    }

    const provider = options.provider?.trim() || "pi";
    const model = options.model?.trim() || undefined;
    const resumeArgs = ["--provider", provider, ...(model ? ["--model", model] : []), "resume"];
    const resumableRun = project.summary?.runs.find((run) =>
      run.status === "aborted" || run.status === "failed" || run.status === "stale"
    );
    project.execTracking = {
      startedAt: Date.now(),
      baselineRunSlugs: new Set(project.summary?.runs.map((run) => run.slug) ?? []),
      ...(resumableRun ? { runSlug: resumableRun.slug } : {}),
    };

    try {
      this.setProjectStage(project, "starting", onUpdate, `Opening TAKT resume in ${project.label}…`);
      await project.runner.start(resumeArgs);
      await this.showLive(false);
      await waitForTaktResumeMenu(project.runner, signal, TAKT_RESUME_MENU_TIMEOUT_MS);
      throwIfAborted(signal);
      const menuVersion = project.runner.screenVersion;
      // Requeue is TAKT's default resume action. Send a literal Enter so no
      // bracketed-paste control bytes can leak into the selection UI.
      project.runner.write("\r");
      await waitForFreshTerminalOutput(project.runner, menuVersion, signal, TAKT_RESUME_MENU_TIMEOUT_MS, "resume");
      this.setProjectStage(project, "running", onUpdate, `TAKT resumed in ${project.label}.`);
      await this.setInputMode("pi-auto", { quiet: true });
      context.ui.notify(`TAKT resumed for ${project.label}. Input mode: pi-auto.`, "info");
      return { profile: profile.name, cwd: project.cwd, provider, ...(model ? { model } : {}), replaced };
    } catch (error) {
      await stopWaitDispose(project.runner, undefined, TAKT_LIFECYCLE_TIMEOUT_MS);
      this.setProjectStage(project, signal?.aborted ? "stopped" : "failed");
      throw error;
    }
  }

  async stopActive(
    args = "",
    options: { confirm?: boolean; forceObserved?: boolean } = {},
  ): Promise<{ project?: string; cwd?: string; stopped: boolean; reconciledRuns: string[] }> {
    const context = this.context;
    if (!context?.hasUI) {
      throw new Error("TAKT bridge requires an interactive Pi UI");
    }

    const project = args.trim()
      ? this.ensureProject(this.resolveTargetPath(args, context.cwd))
      : this.activeRunningProject();
    project?.runner.reconcile();
    if (!project?.runner.isRunning) {
      if (project?.runner.hasSession) {
        await project.runner.dispose();
      }
      const reconciledRuns = options.forceObserved && project
        ? this.reconcileObservedRuns(project)
        : [];
      if (project && reconciledRuns.length > 0) {
        await this.refreshProject(project, { includeTaskList: false });
      }
      await this.showLive(false);
      return { project: project?.label, cwd: project?.cwd, stopped: false, reconciledRuns };
    }

    if (options.confirm) {
      const confirmed = await context.ui.confirm(
        "Stop TAKT",
        `Send Ctrl-C to ${project.label}? The current task may be marked aborted.`,
      );
      if (!confirmed) {
        return { project: project.label, cwd: project.cwd, stopped: false, reconciledRuns: [] };
      }
    }

    const ownedPid = project.runner.pid;
    const trackedRun = project.execTracking
      ? findTrackedExecRun(project.summary, project.execTracking)
      : project.summary?.runs.find((run) =>
        ownedPid !== undefined && run.pid === ownedPid && run.status === "running"
      );
    const trackedRunSlug = trackedRun?.slug ?? project.execTracking?.runSlug;
    this.setProjectStage(project, "stopping");
    try {
      await project.runner.stop();
      await project.runner.waitForExit(TAKT_LIFECYCLE_TIMEOUT_MS);
      await waitUntilNotRunning(project.runner, undefined, TAKT_LIFECYCLE_TIMEOUT_MS);
      await project.runner.dispose();
    } catch (error) {
      this.setProjectStage(project, "failed");
      throw new Error(`TAKT stop failed for ${project.label}: ${errorMessage(error)}`);
    }
    const reconciledRuns = trackedRunSlug && reconcileRunAsAborted(
      trackedRun?.workspace ?? project.cwd,
      trackedRunSlug,
      "Stopped by Pi TAKT Bridge operator request; checkpoint data preserved.",
    ).reconciled
      ? [trackedRunSlug]
      : [];
    project.execTracking = undefined;
    if (reconciledRuns.length > 0) {
      await this.refreshProject(project, { includeTaskList: false });
    }
    this.setProjectStage(project, "stopped");
    if (this.inputMode !== "pi") {
      await this.setInputMode("pi", { quiet: true });
    }
    await this.showLive(false);
    context.ui.notify(`TAKT stopped for ${project.label}.`, "info");
    return { project: project.label, cwd: project.cwd, stopped: true, reconciledRuns };
  }

  private reconcileObservedRuns(project: ManagedProject): string[] {
    const candidates = project.summary?.runs.filter((run) =>
      run.status === "stale" || (run.status === "running" && run.sessionStatus === "unknown")
    ) ?? [];
    return candidates.flatMap((run) => reconcileRunAsAborted(
      run.workspace ?? project.cwd,
      run.slug,
      "Force-reconciled stale TAKT metadata by Pi TAKT Bridge; checkpoint data preserved.",
    ).reconciled ? [run.slug] : []);
  }

  async addProject(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }

    const rawPath = args.trim() || await context.ui.input("TAKT project folder", "Absolute repo or development folder path");
    if (!rawPath?.trim()) {
      return;
    }

    try {
      const cwd = normalizeProjectPath(rawPath, context.cwd);
      const project = this.ensureProject(cwd);
      this.persistProjects();
      await this.refreshProject(project, { includeTaskList: false });
      context.ui.notify(`TAKT project added: ${project.label}\n${project.cwd}`, "info");
      await this.showLive(false);
    } catch (error) {
      context.ui.notify(`TAKT project add failed: ${errorMessage(error)}`, "error");
    }
  }

  async addProfile(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }

    const nameArgument = args.trim().split(/\s+/)[0] ?? "";
    const rawName = nameArgument || await context.ui.input("TAKT profile name", "e.g. pi-docs");
    if (!rawName?.trim()) {
      return;
    }

    let name: string;
    try {
      name = normalizeProfileName(rawName);
    } catch (error) {
      context.ui.notify(`TAKT profile name failed: ${errorMessage(error)}`, "error");
      return;
    }

    const rawPath = await context.ui.input(
      `Folder for ${name}`,
      this.profiles.get(name)?.cwd ?? context.cwd,
    );
    if (!rawPath?.trim()) {
      return;
    }

    const current = this.profiles.get(name);
    const rawPreset = await context.ui.input(
      `Default exec preset for ${name}`,
      current?.preset ?? "Optional, e.g. pi-docs",
    );
    if (rawPreset === undefined) {
      return;
    }

    try {
      const cwd = normalizeProjectPath(rawPath, context.cwd);
      const preset = rawPreset.trim();
      this.profiles.set(name, { name, cwd, ...(preset ? { preset } : {}) });
      this.ensureProject(cwd);
      this.persistProfiles();
      this.persistProjects();
      await this.refreshProjects();
      context.ui.notify(
        `TAKT profile saved: ${name}\n${cwd}${preset ? `\npreset: ${preset}` : ""}\nUse /takt:exec ${name}.`,
        "info",
      );
    } catch (error) {
      context.ui.notify(`TAKT profile save failed: ${errorMessage(error)}`, "error");
    }
  }

  async setupProject(options: {
    profile?: string;
    cwd?: string;
    preset?: string;
    copyGlobalPreset?: boolean;
    overwrite?: boolean;
  } = {}): Promise<TaktProjectSetupResult & { profile: string; registered: true }> {
    const context = this.context;
    if (!context?.hasUI) {
      throw new Error("TAKT bridge requires an interactive Pi UI");
    }

    const cwd = normalizeProjectPath(options.cwd?.trim() || context.cwd, context.cwd);
    const profileName = normalizeProfileName(options.profile?.trim() || defaultProfileName(cwd));
    const current = this.profiles.get(profileName);
    if (
      current
      && projectPathKey(current.cwd) !== projectPathKey(cwd)
      && options.overwrite !== true
    ) {
      throw new Error(
        `TAKT profile already points elsewhere: ${profileName} → ${current.cwd}. `
        + "Pass overwrite:true to replace it explicitly.",
      );
    }

    const preset = options.preset?.trim() || current?.preset || "pi-docs";
    const local = setupProjectLocalTakt({
      cwd,
      preset,
      copyGlobalPreset: options.copyGlobalPreset,
    });
    this.ensureProject(cwd);
    this.profiles.set(profileName, { name: profileName, cwd, preset: local.preset });
    this.persistProfiles();
    this.persistProjects();
    await this.refreshProjects();
    return { ...local, profile: profileName, registered: true };
  }

  /**
   * Per-step Pi model selection: workflow → steps → model per step →
   * merged into <project>/.takt/runtime.yaml as runtime-v1 profiles/targets.
   */
  async selectStepModels(context: ExtensionContext, workflowArg?: string): Promise<void> {
    const cwd = context.cwd;
    const taktCommand = process.env.TAKT_COMMAND ?? "takt";

    let workflowName = workflowArg;
    if (!workflowName) {
      const workflows = await listWorkflowNames(cwd, taktCommand);
      if (workflows.length === 0) {
        context.ui.notify("No TAKT workflows found in .takt/workflows, ~/.takt/workflows, or builtins.", "warning");
        return;
      }
      const selected = await openSearchableSelect(
        context,
        `Workflow (${workflows.length} available; type to filter)`,
        workflows.map((entry) => entry.name),
      );
      if (!selected) {
        return;
      }
      workflowName = selected;
    }

    const { root, steps } = await collectSelectableSteps(cwd, workflowName, taktCommand);
    if (steps.length === 0) {
      context.ui.notify(`Workflow ${root.name} has no selectable agent steps.`, "warning");
      return;
    }

    const modelRefs = await loadPiModelRefs();
    if (modelRefs.length === 0) {
      context.ui.notify("pi --list-models returned no auth-configured models.", "error");
      return;
    }

    const inheritOption = "(inherit global default)";
    const selections: StepModelSelection[] = [];
    for (const step of steps) {
      if (step.unresolvedCall !== undefined) {
        continue;
      }
      const pinnedSuffix = step.pinnedInline ? " [pinned in YAML]" : "";
      const chosen = await openSearchableSelect(
        context,
        `${step.targetKey}${pinnedSuffix} — pick model`,
        [inheritOption, ...modelRefs],
      );
      if (chosen === undefined) {
        context.ui.notify("Model selection cancelled; runtime.yaml unchanged.", "info");
        return;
      }
      if (chosen !== inheritOption) {
        selections.push({ targetKey: step.targetKey, modelRef: chosen });
      }
    }

    const unresolved = steps.filter((step): step is WorkflowStepRef => step.unresolvedCall !== undefined);
    const inheritedCount = steps.length - unresolved.length - selections.length;
    const summaryLines = [
      `workflow: ${root.name} (${root.layer})`,
      ...selections.map((selection) => `  ${selection.targetKey} → ${selection.modelRef}`),
      ...(inheritedCount > 0 ? [`  ${inheritedCount} step(s) keep the inherited default`] : []),
      ...unresolved.map((step) => `  ${step.targetKey} — call ${step.unresolvedCall} not expanded`),
      "",
      `Write these into .takt/runtime.yaml?`,
    ];
    const confirmed = await context.ui.confirm("Apply per-step models", summaryLines.join("\n"));
    if (!confirmed) {
      context.ui.notify("Cancelled; runtime.yaml unchanged.", "info");
      return;
    }

    if (selections.length === 0) {
      context.ui.notify("All steps keep the inherited default; runtime.yaml unchanged.", "info");
      return;
    }
    const result = applyStepModelSelections(cwd, root.name, selections);
    context.ui.notify(
      `runtime.yaml updated: ${result.updatedTargets} step target(s), profiles: ${result.profiles.join(", ")}`,
      "info",
    );
  }

  async listProfiles(): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    if (this.profiles.size === 0) {
      context.ui.notify("No TAKT profiles. Use /takt:profile:add <name> to create one.", "info");
      return;
    }
    const lines = [...this.profiles.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((profile) => `${profile.name} → ${profile.cwd}${profile.preset ? ` (preset: ${profile.preset})` : ""}`);
    context.ui.notify(lines.join("\n"), "info");
  }

  async removeProfile(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }

    let name = args.trim();
    if (!name) {
      const choices = [...this.profiles.keys()].sort();
      if (choices.length === 0) {
        context.ui.notify("No TAKT profiles to remove.", "info");
        return;
      }
      const selected = await context.ui.select("Remove TAKT profile", choices);
      if (!selected) {
        return;
      }
      name = selected;
    }

    let normalizedName: string;
    try {
      normalizedName = normalizeProfileName(name);
    } catch (error) {
      context.ui.notify(`TAKT profile name failed: ${errorMessage(error)}`, "error");
      return;
    }
    if (!this.profiles.delete(normalizedName)) {
      context.ui.notify(`TAKT profile not found: ${normalizedName}`, "info");
      return;
    }
    this.persistProfiles();
    context.ui.notify(`TAKT profile removed: ${normalizedName}. The project folder remains registered.`, "info");
  }

  async removeProject(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    const project = await this.selectProject(args, "Remove TAKT project", () => true);
    if (!project) {
      return;
    }
    if (project.runner.isRunning) {
      context.ui.notify("Stop the project before removing it.", "warning");
      return;
    }
    const linkedProfiles = [...this.profiles.values()]
      .filter((profile) => projectPathKey(profile.cwd) === project.id)
      .map((profile) => profile.name);
    if (linkedProfiles.length > 0) {
      context.ui.notify(
        `Remove linked TAKT profile first: ${linkedProfiles.join(", ")}. Use /takt:profile:remove.`,
        "warning",
      );
      return;
    }
    await project.acp.close();
    await project.runner.dispose();
    this.projects.delete(project.id);
    this.persistProjects();
    this.notifyProjects();
    if (!this.hasDisplayableProject()) {
      this.clearLiveWidget();
    }
    context.ui.notify(`TAKT project removed: ${project.label}.`, "info");
  }

  async showLive(notifyWhenEmpty = true): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    if (!this.hasDisplayableProject()) {
      if (this.liveWidgetVisible) {
        this.clearLiveWidget();
      }
      if (notifyWhenEmpty) {
        context.ui.notify("No active TAKT project. Use /takt:project to register another folder.", "info");
      }
      return;
    }
    if (this.liveWidgetVisible) {
      this.notifyProjects();
      return;
    }

    context.ui.setWidget(
      WIDGET_KEY,
      (tui) => createTaktProjectStackWidget(this, tui),
      { placement: "aboveEditor" },
    );
    this.liveWidgetVisible = true;
  }

  async stopRunning(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }

    const project = await this.selectProject(
      args,
      "Stop TAKT in",
      (candidate) => candidate.runner.isRunning,
    );
    if (!project?.runner.isRunning) {
      return;
    }

    await this.stopActive(project.cwd, { confirm: true });
  }

  private setProjectStage(
    project: ManagedProject,
    stage: TaktExecStage,
    onUpdate?: (message: string) => void,
    message?: string,
  ): void {
    project.stage = stage;
    if (stage !== "running" && stage !== "pasting" && stage !== "sending_go") {
      project.promptPreview = undefined;
    }
    if (message) {
      onUpdate?.(message);
    }
    this.notifyProjects();
    if (stage === "waiting_prompt") {
      this.flushQueuedInputsFor(project, { auto: true });
    }
    if (stage === "stopped" || stage === "completed" || stage === "failed") {
      project.queuedInputs?.clearAll();
      void this.showLive(false);
    }
  }

  /**
   * Send queued input lines in order as one bracket-pasted batch. Destructive
   * entries never auto-send: they stay queued with a notification instead.
   */
  private flushQueuedInputsFor(
    project: ManagedProject,
    options: { auto?: boolean; force?: boolean } = {},
  ): void {
    const queue = project.queuedInputs;
    if (queue === undefined || !project.runner.isRunning) {
      return;
    }
    if (!project.runner.hasSession) {
      return;
    }
    const result = queue.takeBatch();
    if (result.batch !== undefined) {
      project.runner.write(formatTaktPastedInput(result.batch));
      this.context?.ui.notify(
        `⏳ Flushed ${result.sentCount} queued line(s) to TAKT ${project.label}${options.auto ? " (session ready)" : ""}.`,
        "info",
      );
    }
    if (result.heldDestructive > 0) {
      this.context?.ui.notify(
        `⚠️ ${result.heldDestructive} destructive queued line(s) held back in ${project.label}; confirm via /taktn:flush.`.replace("/taktn:", "/takt:"),
        "warning",
      );
    }
  }

  async flushQueuedInputs(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    const project = await this.selectProject(
      args,
      "Flush queued input to",
      (candidate) => candidate.runner.isRunning,
    );
    if (!project?.runner.isRunning) {
      context.ui.notify("No running bridge-owned TAKT session to flush into.", "info");
      return;
    }
    this.flushQueuedInputsFor(project, { force: true });
  }

  async shutdown(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.closeTaktFocusView("external-close");
    this.inputMode = "pi";
    this.clearStatusRefreshError();
    this.context?.ui.setStatus(STATUS_KEY, undefined);
    this.clearLiveWidget();
    const results = await Promise.allSettled(
      [...this.projects.values()].map((project) => shutdownManagedProject(project)),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [errorMessage(result.reason)] : [],
    );
    if (failures.length > 0) {
      throw new Error(`TAKT runtime shutdown incomplete: ${failures.join("; ")}`);
    }
    this.projects.clear();
    this.profiles.clear();
    this.initialized = false;
    this.context = undefined;
  }

  resolveTargetPath(args: string, fallbackCwd = this.context?.cwd ?? process.cwd()): string {
    const profile = this.profileForArgument(args);
    return profile?.cwd ?? normalizeProjectPath(args, fallbackCwd);
  }

  private currentProject(): ManagedProject {
    const context = this.context;
    if (!context) {
      throw new Error("TAKT bridge is not attached to a Pi session");
    }
    return this.ensureProject(context.cwd);
  }

  private ensureProject(cwd: string): ManagedProject {
    const normalized = normalizeProjectPath(cwd);
    const id = projectPathKey(normalized);
    const existing = this.projects.get(id);
    if (existing) {
      return existing;
    }

    const label = normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
    const acp = new TaktAcpClient({ cwd: normalized });
    const queuedInputs = createTaktInputQueue();
    const runner = new TaktRunController({
      cwd: normalized,
      onExit: ({ code }) => {
        const project = this.projects.get(id);
        const context = this.context;
        if (!project || !context?.hasUI) {
          return;
        }
        if (
          project.stage !== "stopping" &&
          project.stage !== "failed" &&
          project.stage !== "stopped" &&
          project.stage !== "completed"
        ) {
          this.setProjectStage(project, code === 0 ? "completed" : "failed");
        } else {
          this.notifyProjects();
        }
        project.execTracking = undefined;
        const outcome = code === 0 ? "finished" : "exited with errors";
        context.ui.notify(`TAKT ${project.label} ${outcome} (exit ${code}).`, code === 0 ? "info" : "error");
        if ((this.inputMode === "takt" || this.inputMode === "pi-auto") && !this.activeRunningProject()) {
          void this.setInputMode("pi", { quiet: true });
        }
        void this.showLive(false);
      },
    });
    const project: ManagedProject = {
      id,
      cwd: normalized,
      label,
      acp,
      runner,
      stage: "idle",
      queuedInputs,
    };
    runner.subscribe(() => this.notifyProjects());
    this.projects.set(id, project);
    return project;
  }

  private async refreshProjects(): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }
    this.refreshInFlight = true;
    try {
      await Promise.all(
        [...this.projects.values()].map((project) => this.refreshProject(project, { includeTaskList: false })),
      );
      this.notifyProjects();
      await this.showLive(false);
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async refreshProject(
    project: ManagedProject,
    options: TaktStateOptions = {},
  ): Promise<void> {
    const snapshot = project.runner.reconcile();
    if (snapshot.status === "completed") {
      const completedStage = project.stage === "stopping" ? "stopped" : "completed";
      if (project.stage !== "completed" && project.stage !== "stopped" && project.stage !== "failed") {
        this.setProjectStage(project, completedStage);
      }
    }
    project.summary = await readTaktSummary(project.cwd, options);
    this.reconcileExecCompletion(project);
  }

  private async refreshControlState(project: ManagedProject): Promise<boolean> {
    try {
      await this.refreshProject(project, { includeTaskList: true });
      return true;
    } catch (error) {
      this.context?.ui.notify(
        `TAKT status check failed for ${project.label}: ${errorMessage(error)}`,
        "error",
      );
      return false;
    }
  }

  private recordStatusRefreshError(error: unknown): void {
    const message = errorMessage(error);
    if (message === this.statusRefreshErrorMessage) {
      this.statusRefreshErrorCount += 1;
    } else {
      this.statusRefreshErrorMessage = message;
      this.statusRefreshErrorCount = 1;
    }

    const formatted = `TAKT status refresh failed (x${this.statusRefreshErrorCount}): ${message}`;
    this.context?.ui.setStatus(REFRESH_ERROR_STATUS_KEY, formatted);
    if (this.statusRefreshErrorCount === 1) {
      this.context?.ui.notify(formatted, "warning");
    }
  }

  private clearStatusRefreshError(): void {
    if (this.statusRefreshErrorMessage === undefined) {
      return;
    }
    this.statusRefreshErrorMessage = undefined;
    this.statusRefreshErrorCount = 0;
    this.context?.ui.setStatus(REFRESH_ERROR_STATUS_KEY, undefined);
  }

  private beginExecTracking(project: ManagedProject): void {
    project.execTracking = {
      startedAt: Date.now(),
      baselineRunSlugs: new Set(project.summary?.runs.map((run) => run.slug) ?? []),
    };
  }

  private reconcileExecCompletion(project: ManagedProject): void {
    const tracking = project.execTracking;
    if (!tracking || project.stage !== "running" || !project.runner.isRunning) {
      return;
    }

    const run = findTrackedExecRun(project.summary, tracking);
    if (!run || !isTerminalRunStatus(run.status)) {
      return;
    }

    project.execTracking = undefined;
    this.setProjectStage(project, run.status === "completed" ? "completed" : "failed");
    if (this.inputMode !== "pi") {
      void this.setInputMode("pi", { quiet: true });
    }
  }

  private async selectProject(
    args: string,
    title: string,
    predicate: (project: ManagedProject) => boolean,
  ): Promise<ManagedProject | undefined> {
    const context = this.context;
    if (!context?.hasUI) {
      return undefined;
    }
    const normalizedArgs = args.trim();
    if (normalizedArgs) {
      try {
        const project = this.ensureProject(this.resolveTargetPath(normalizedArgs, context.cwd));
        this.persistProjects();
        await this.refreshProject(project, { includeTaskList: false });
        return project;
      } catch (error) {
        context.ui.notify(`TAKT project path failed: ${errorMessage(error)}`, "error");
        return undefined;
      }
    }

    const candidates = [...this.projects.values()].filter(predicate);
    if (candidates.length === 0) {
      context.ui.notify("No matching TAKT project session.", "info");
      return undefined;
    }
    const current = this.projects.get(projectPathKey(context.cwd));
    if (candidates.length === 1 || (current && candidates.includes(current) && current.runner.isRunning)) {
      return current && candidates.includes(current) ? current : candidates[0];
    }

    const choices = candidates.map((project) => `${project.label} — ${project.cwd}`);
    const selected = await context.ui.select(title, choices);
    if (!selected) {
      return undefined;
    }
    return candidates[choices.indexOf(selected)];
  }

  private profileForArgument(args: string): TaktProjectProfile | undefined {
    const trimmed = args.trim();
    if (!trimmed || /\s/.test(trimmed)) {
      return undefined;
    }
    try {
      return this.profiles.get(normalizeProfileName(trimmed));
    } catch {
      return undefined;
    }
  }

  /** /takt:lang [en|ja] — switch widget UI language for this session. */
  async setWidgetLanguage(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    const arg = args.trim().toLowerCase();
    let lang: TaktLang;
    if (arg === "") {
      lang = toggleTaktLang();
    } else if (arg === "ja" || arg === "ja-jp" || arg.includes("日本語")) {
      lang = setTaktLang("ja");
    } else if (arg === "en" || arg === "en-us" || arg.includes("english")) {
      lang = setTaktLang("en");
    } else {
      context.ui.notify("Usage: /takt:lang [en|ja] (no argument toggles).", "info");
      return;
    }
    const sample = lang === "ja"
      ? "🎭 言語を日本語に切り替えました（このセッションのみ）"
      : "🎭 Language switched to English (this session only)";
    context.ui.notify(sample, "info");
  }

  /**
   * Explicit raw-screen access: /takt:live [path] and /takt:sessions both land
   * here. The stacked widget stays summary-only by default.
   */
  async peekSession(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    const project = await this.selectProject(
      args,
      "Peek TAKT session",
      () => true,
    );
    if (!project) {
      return;
    }
    await openLiveScreenOverlay(context, project);
  }

  /** /takt:sessions — one status line per known session, then peek the choice. */
  async listSessions(): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    const sessions = [...this.projects.values()]
      .filter((project) => project.runner.hasSession || project.runner.isRunning || project.summary !== undefined)
      .sort(compareManagedProjectsForMenu);
    if (sessions.length === 0) {
      context.ui.notify("🎭 TAKT · no sessions yet. Start one with /takt:start or /takt:exec.", "info");
      return;
    }
    const selected = await context.ui.select(
      "🎭 TAKT sessions — pick one to peek",
      sessions.map((project) => sessionMenuLabel(project)),
    );
    if (!selected) {
      return;
    }
    // Map the rendered label back to its project.
    const match = sessions.find((project) => selected.startsWith(project.label));
    if (match) {
      await openLiveScreenOverlay(context, match);
    }
  }

  /** /takt:ask [@label] <message> — conversational input routed by @mention. */
  async askAgent(args = ""): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    const sessions = this.sessionPairs();
    const mentioned = parseSessionMention(args);
    let project: ManagedProject | undefined;
    if (mentioned.token !== undefined) {
      const target = resolveSessionByMention(
        sessions.map((session) => ({ label: session.entry.label, cwd: session.entry.cwd })),
        mentioned.token,
      );
      project = sessions.find((session) => session.entry.cwd === target?.cwd)?.project;
    } else if (sessions.length === 1) {
      project = sessions[0].project;
    }
    if (!project) {
      context.ui.notify("Usage: /takt:ask @<name> <message> (a single session also works without @).", "info");
      return;
    }
    const text = mentioned.rest || (await context.ui.input(`Talk to ${project.label}`, "message for the TAKT agent")) || "";
    if (!text.trim()) {
      return;
    }
    if (project.runner.isRunning && project.stage !== "waiting_prompt") {
      const depth = project.queuedInputs?.enqueue(text) ?? 0;
      context.ui.notify(`⏳ ${project.label} executing; queued (⏳q${depth}).`, "info");
      return;
    }
    project.runner.write(formatTaktPastedInput(text));
    context.ui.notify(`Message sent to TAKT ${project.label}.`, "info");
  }

  /** /takt:inspect — live list of running sessions; arrows move, enter peeks. */
  async inspectSessions(): Promise<void> {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    await openTaktSessionInspector(
      { ...context, runtimeRef: this },
      () => this.sessionPairs(),
    );
  }

  /** Every known session as (project, widget entry) pairs, most active first. */
  sessionPairs(): Array<{ project: ManagedProject; entry: TaktProjectWidgetEntry }> {
    const pairs = [...this.projects.values()]
      .filter((project) => project.runner.hasSession || project.runner.isRunning || project.summary !== undefined)
      .map((project) => ({
        project,
        entry: {
          id: project.id,
          label: project.label,
          cwd: project.cwd,
          runner: project.runner,
          summary: project.summary,
          stage: project.stage,
          promptPreview: project.promptPreview,
          queueDepth: project.queuedInputs?.depth() ?? 0,
        },
      }));
    return pairs.sort((left, right) => {
      const score = (pair: { project: ManagedProject }): number =>
        pair.project.runner.isRunning ? 2 : pair.project.runner.hasSession ? 1 : 0;
      return score(right) - score(left) || left.entry.label.localeCompare(right.entry.label);
    });
  }

  private hasDisplayableProject(): boolean {
    // Session-owned view only: externally started TAKT activity must not mount
    // or keep the live widget here. Explicit diagnostics (/takt:status,
    // takt_read_screen) remain available for external runs.
    return [...this.projects.values()].some((project) =>
      !isTerminalProjectStage(project.stage) &&
      (project.runner.isRunning || project.runner.hasSession),
    );
  }

  private activeRunningProject(): ManagedProject | undefined {
    const running = [...this.projects.values()].filter((project) => project.runner.isRunning);
    if (running.length === 0) {
      return undefined;
    }
    const current = this.context ? this.projects.get(projectPathKey(this.context.cwd)) : undefined;
    if (current?.runner.isRunning) {
      return current;
    }
    return running.sort((left, right) => left.label.localeCompare(right.label))[0];
  }

  private activeSessionProject(): ManagedProject | undefined {
    return this.activeRunningProject()
      ?? [...this.projects.values()].find((project) => project.runner.hasSession);
  }

  private activeObservedProject(): ManagedProject | undefined {
    const current = this.context ? this.projects.get(projectPathKey(this.context.cwd)) : undefined;
    if (hasRecentTaktSummaryActivity(current?.summary)) {
      return current;
    }
    return [...this.projects.values()].find((project) => hasRecentTaktSummaryActivity(project.summary))
      ?? current
      ?? [...this.projects.values()].find((project) => project.summary !== undefined);
  }

  /** Bridge-owned running sessions eligible for fullscreen focus, in shared deterministic order. */
  eligibleFocusSessions(): TaktFocusSession[] {
    const currentProjectId = this.context ? projectPathKey(this.context.cwd) : undefined;
    const eligible = [...this.projects.values()]
      .filter((project) => project.runner.isRunning)
      .map((project): TaktFocusSession => ({
        id: project.id,
        label: project.label,
        cwd: project.cwd,
        get terminal() {
          return project.runner.terminal;
        },
        inputMode: "takt",
        isRunning: () => project.runner.isRunning,
        write: (data) => project.runner.write(data),
        resize: (columns, rows) => project.runner.resize(columns, rows),
        subscribe: (listener) => project.runner.subscribe(listener),
      }));
    return orderTaktFocusSessions(eligible);
  }

  private async openTaktFullscreenFocus(): Promise<void> {
    const context = this.context;
    if (!context?.hasUI || this.focusViewOpenPromise !== undefined) {
      return;
    }
    const eligible = this.eligibleFocusSessions();
    if (eligible.length === 0) {
      await this.setInputMode("pi", { quiet: true });
      context.ui.notify("No running bridge-owned TAKT session to focus.", "warning");
      return;
    }
    const generation = ++this.focusGeneration;
    const currentProjectId = projectPathKey(context.cwd);
    this.focusViewOpenPromise = context.ui.custom<void>((tui, _theme, _keybindings, done) => {
      let viewRef: TaktFullscreenFocusView | undefined;
      const view = new TaktFullscreenFocusView({
        sessions: eligible,
        initialSessionId: currentProjectId,
        callbacks: {
          requestRender: () => tui.requestRender(),
          notify: (message, level) => context.ui.notify(message, level === "warning" ? "warning" : "info"),
          onModeCycle: () => {
            void this.cycleInputMode();
          },
          onExit: (result) => {
            // The host overlay must always close, even when a newer
            // generation superseded this view (mode switch / shutdown).
            done();
            if (generation === this.focusGeneration && viewRef === this.focusView) {
              this.handleTaktFocusExit(result);
            }
          },
        },
      });
      viewRef = view;
      this.focusView = view;
      return {
        render: (width: number) =>
          view.render(width, Math.max(4, Number(tui.terminal?.rows ?? 24))),
        invalidate: () => view.invalidate(),
        handleInput: (data: string) => view.handleInput(data),
      };
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
    });
    try {
      await this.focusViewOpenPromise;
    } finally {
      this.focusViewOpenPromise = undefined;
      if (this.focusView !== undefined && generation === this.focusGeneration) {
        // The host closed the component without our onExit path running.
        this.focusView.close("external-close");
        this.focusView = undefined;
        this.focusGeneration += 1;
      }
    }
  }

  private closeTaktFocusView(reason: TaktFocusExitResult["reason"]): void {
    this.focusGeneration += 1;
    this.focusView?.close(reason);
    this.focusView = undefined;
  }

  private handleTaktFocusExit(result: TaktFocusExitResult): void {
    this.focusView = undefined;
    const label = result.session?.label ?? "session";
    if (result.reason === "user-escape") {
      this.context?.ui.notify(`Left TAKT focus (${label}).`, "info");
      void this.setInputMode("pi", { quiet: true });
      return;
    }
    if (result.reason === "runner-ended") {
      const otherRunning = this.eligibleFocusSessions().filter((session) => session.id !== result.session?.id).length;
      this.context?.ui.notify(
        `TAKT ${label} finished.${otherRunning > 0 ? ` ${otherRunning} other session(s) still running.` : ""}`,
        "info",
      );
      // Never re-pin automatically: return straight to Pi so the next
      // keystroke cannot reach another session unexpectedly.
      void this.setInputMode("pi", { quiet: true });
      return;
    }
    // external-close: the caller already manages mode state and notifications.
  }

  private syncInputModeStatus(): void {
    const context = this.context;
    if (!context?.hasUI) {
      return;
    }
    context.ui.setStatus(
      STATUS_KEY,
      this.inputMode === "pi" ? undefined : `takt input: ${formatTaktInputModeLine(this.inputMode)}`,
    );
  }

  private persistProjects(): void {
    try {
      saveProjectPaths([...this.projects.values()].map((project) => project.cwd));
    } catch (error) {
      this.context?.ui.notify(`TAKT project registry save failed: ${errorMessage(error)}`, "warning");
    }
  }

  private persistProfiles(): void {
    try {
      saveTaktProfiles([...this.profiles.values()]);
    } catch (error) {
      this.context?.ui.notify(`TAKT profile registry save failed: ${errorMessage(error)}`, "warning");
    }
  }

  private clearLiveWidget(): void {
    this.context?.ui.setWidget(WIDGET_KEY, undefined);
    this.liveWidgetVisible = false;
  }

  private notifyProjects(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function blocksNewExecution(summary: TaktSummary | undefined): boolean {
  if (!summary) {
    return false;
  }
  if (summary.status === "live") {
    return true;
  }
  if (summary.status === "unknown") {
    return summary.running > 0;
  }
  return false;
}

function externalSessionError(project: ManagedProject): Error {
  const status = project.summary?.status;
  if (!status) {
    throw new Error(`TAKT summary is unavailable for ${project.label}`);
  }
  return new Error(`TAKT has an external ${status} session in ${project.label}; Pi will not start a duplicate.`);
}

function projectSessionSnapshot(project: ManagedProject): {
  status: TaktSessionStatus;
  pid?: number;
  stage?: string;
  lastExit?: TaktLastExit;
} {
  const runner = project.runner;
  if (isTerminalProjectStage(project.stage)) {
    return {
      status: "completed",
      stage: project.stage,
      ...(runner.pid !== undefined ? { pid: runner.pid } : {}),
      ...(runner.lastExit ? { lastExit: runner.lastExit } : {}),
    };
  }
  if (runner.status === "stale") {
    return {
      status: "stale",
      stage: project.stage,
      ...(runner.pid !== undefined ? { pid: runner.pid } : {}),
    };
  }
  if (runner.isRunning) {
    return {
      status: "live",
      stage: project.stage,
      ...(runner.pid !== undefined ? { pid: runner.pid } : {}),
    };
  }
  const observedSummary = project.summary;
  const bridgeCompleted = runner.lastExit !== undefined || runner.status === "completed";
  if (
    observedSummary &&
    (observedSummary.status === "live" ||
      (!bridgeCompleted &&
        (observedSummary.status === "stale" ||
          (observedSummary.status === "unknown" && observedSummary.running > 0))))
  ) {
    return snapshotObservedSummary(observedSummary);
  }
  if (bridgeCompleted) {
    return {
      status: "completed",
      stage: project.stage,
      ...(runner.pid !== undefined ? { pid: runner.pid } : {}),
      ...(runner.lastExit ? { lastExit: runner.lastExit } : {}),
    };
  }
  if (observedSummary) {
    return snapshotObservedSummary(observedSummary);
  }
  return { status: "unknown", stage: project.stage };
}

function snapshotObservedSummary(summary: TaktSummary): {
  status: TaktSessionStatus;
  pid?: number;
  stage?: string;
  lastExit?: TaktLastExit;
} {
  return {
    status: summary.status,
    ...(summary.stage ? { stage: summary.stage } : {}),
    ...(summary.pid !== undefined ? { pid: summary.pid } : {}),
    ...(summary.lastExit ? { lastExit: summary.lastExit } : {}),
  };
}

function renderSummaryScreen(summary: TaktSummary): string[] {
  return [
    `status: ${summary.status}`,
    ...(summary.pid !== undefined ? [`pid: ${summary.pid}`] : []),
    ...(summary.stage ? [`stage: ${summary.stage}`] : []),
    ...(summary.lastExit ? [`lastExit: ${formatTaktLastExit(summary.lastExit)}`] : []),
    `running: ${summary.running}`,
    `pending: ${summary.pending}`,
    `completed: ${summary.completed}`,
    `stale: ${summary.stale}`,
  ];
}

function isTerminalProjectStage(stage: TaktExecStage): boolean {
  return stage === "stopped" || stage === "completed" || stage === "failed";
}

function containsTaktGoCommand(value: string): boolean {
  return /^\/go(?:\s|$)/i.test(value.trim());
}

function findTrackedExecRun(
  summary: TaktSummary | undefined,
  tracking: TaktExecTracking,
): TaktSummary["runs"][number] | undefined {
  const runs = summary?.runs ?? [];
  if (tracking.runSlug) {
    return runs.find((run) => run.slug === tracking.runSlug);
  }

  const newRun = runs.find((run) => !tracking.baselineRunSlugs.has(run.slug));
  const recentRun = runs.find((run) => {
    if (tracking.baselineRunSlugs.has(run.slug) || !run.startTime) {
      return false;
    }
    const startedAt = Date.parse(run.startTime);
    return Number.isFinite(startedAt) && startedAt >= tracking.startedAt - 1_000;
  });
  const run = newRun ?? recentRun;
  if (run) {
    tracking.runSlug = run.slug;
  }
  return run;
}

function isTerminalRunStatus(status: TaktSummary["runs"][number]["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

async function shutdownManagedProject(project: ManagedProject): Promise<void> {
  const failures: unknown[] = [];
  try {
    await project.acp.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await project.runner.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new Error(failures.map(errorMessage).join("; "));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTaktTaskListError(error: unknown): boolean {
  return errorMessage(error).startsWith("TAKT task list ");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("TAKT prompt execution cancelled");
  }
}

function shouldUsePromptOverlay(project: ManagedProject): boolean {
  return shouldOverlayPromptPreview(project.stage) && Boolean(project.promptPreview?.trim());
}

function sessionMenuLabel(project: ManagedProject): string {
  const run = project.summary?.runs.find((candidate) =>
    candidate.status === "running" || candidate.sessionStatus === "live");
  const state = project.stage === "failed"
    ? "🔴❌"
    : project.runner.isRunning
      ? "🟢⠋"
      : run?.status === "stale"
        ? "⚠️ "
        : project.summary?.runs.some((candidate) => candidate.status === "completed")
          ? "✅"
          : "🔵";
  const workflow = run?.workflow ?? project.summary?.runs[0]?.workflow;
  return `${state} ${project.label}${workflow ? ` · ${workflow}` : ""} — ${project.cwd}`;
}

function compareManagedProjectsForMenu(left: ManagedProject, right: ManagedProject): number {
  const score = (project: ManagedProject): number =>
    project.runner.isRunning ? 2 : project.runner.hasSession ? 1 : 0;
  return score(right) - score(left) || left.label.localeCompare(right.label);
}

/** Live, arrow-driven session inspector: state line per session, Enter peeks raw screen. */
function openTaktSessionInspector(
  context: ExtensionContext & { runtimeRef?: TaktBridgeRuntime },
  getSessions: () => Array<{ project: ManagedProject; entry: TaktProjectWidgetEntry }>,
): Promise<void> {
  return context.ui.custom<void>((_tui, theme, _keybindings, done) => {
    let cursor = 0;
    let sessions: Array<{ project: ManagedProject; entry: TaktProjectWidgetEntry }> = [];
    const text = new Text("", 0, 0);

    const refresh = (nowMs = Date.now()): void => {
      sessions = getSessions();
      cursor = Math.min(cursor, Math.max(0, sessions.length - 1));
      const lines: string[] = [
        theme.fg("accent", "🎭 TAKT sessions · ↑/↓ move · t talk · s stop · l tasks · Enter peek · Esc close"),
        theme.fg("dim", "(live — what each session is doing right now)"),
        "",
      ];
      sessions.forEach((session, index) => {
        const marker = index === cursor ? "❯ " : "  ";
        const row = sessionRow(session.entry, 96, nowMs);
        lines.push(theme.fg(index === cursor ? "text" : "muted", `${marker}${row}`));
      });
      if (sessions.length === 0) {
        lines.push(theme.fg("dim", "no TAKT sessions yet — start one with /takt:start or /takt:exec"));
      }
      text.setText(lines.join("\n"));
      text.invalidate();
    };
    refresh();

    const timer = setInterval(() => refresh(), 1000);
    timer.unref?.();
    return {
      render: (width: number) => text.render(width),
      invalidate: () => text.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "escape")) {
          clearInterval(timer);
          done();
          return;
        }
        if (matchesKey(data, "enter")) {
          clearInterval(timer);
          const session = sessions[cursor];
          if (session) {
            void openLiveScreenOverlay(context, session.project);
          }
          done();
          return;
        }
        if (matchesKey(data, "up")) {
          cursor = Math.max(0, cursor - 1);
          refresh();
          return;
        }
        if (matchesKey(data, "down")) {
          cursor = Math.min(Math.max(0, sessions.length - 1), cursor + 1);
          refresh();
          return;
        }
        if (matchesKey(data, "t")) {
          void talkToSession(context, sessions[cursor]?.project, sessions);
          return;
        }
        if (matchesKey(data, "s")) {
          void stopSessionFromInspector(context, sessions[cursor]?.project);
          return;
        }
        if (matchesKey(data, "l") || matchesKey(data, "tab")) {
          void manipulateTasksFromInspector(context, sessions[cursor]?.project);
        }
      },
    };
  }, { overlay: true });
}

/** Conversational input to a selected session: at the prompt it is sent
 * immediately; mid-execution it goes through the input queue. The inspector
 * stays open, so this is a back-and-forth channel with the TAKT agent. */
async function talkToSession(
  context: ExtensionContext,
  project: ManagedProject | undefined,
  sessions: Array<{ project: ManagedProject; entry: TaktProjectWidgetEntry }> = [],
): Promise<void> {
  const mentions = sessions.map((session) => ({ label: session.entry.label, cwd: session.entry.cwd }));
  const rawText = await context.ui.input(
    project !== undefined ? `Talk to ${project.label}` : "Talk to a TAKT session (@name to target)",
    "@session-name message, or plain message for the selected session",
  );
  if (rawText === undefined || !rawText.trim()) {
    return;
  }
  let text = rawText;
  const mentioned = parseSessionMention(rawText);
  if (mentioned.token !== undefined) {
    const target = resolveSessionByMention(mentions, mentioned.token);
    if (target !== undefined) {
      project = sessions.find((session) => session.entry.cwd === target.cwd)?.project ?? project;
      text = mentioned.rest;
    }
  }
  if (!project) {
    context.ui.notify("No session selected and @name did not match one.", "info");
    return;
  }
  if (!text.trim()) {
    return;
  }
  if (project.runner.isRunning && project.stage !== "waiting_prompt") {
    const depth = project.queuedInputs?.enqueue(text) ?? 0;
    context.ui.notify(`⏳ ${project.label} is executing; queued (⏳q${depth}). It flushes when ready or via /takt:flush.`, "info");
    return;
  }
  project.runner.write(formatTaktPastedInput(text));
  context.ui.notify(`Message sent to TAKT ${project.label}.`, "info");
}

/** Graceful stop of the selected bridge-owned session. */
async function stopSessionFromInspector(
  context: ExtensionContext & { runtimeRef?: TaktBridgeRuntime },
  project: ManagedProject | undefined,
): Promise<void> {
  if (!project) {
    context.ui.notify("No session selected.", "info");
    return;
  }
  const confirmed = await context.ui.confirm(
    "Stop TAKT session",
    `Interrupt ${project.label}?
${project.cwd}`,
  );
  if (!confirmed) {
    return;
  }
  if (!context.runtimeRef) {
    return;
  }
  const result = await context.runtimeRef.stopActive(project.cwd, { confirm: false });
  context.ui.notify(
    result.stopped
      ? `TAKT ${project.label} stopped.`
      : `TAKT ${project.label} was not running.`,
    "info",
  );
}

/** Pick a queued task of the selected session and delete or reset it. */
async function manipulateTasksFromInspector(
  context: ExtensionContext,
  project: ManagedProject | undefined,
): Promise<void> {
  if (!project) {
    context.ui.notify("No session selected.", "info");
    return;
  }
  let tasks: TaktTaskFileEntry[] = [];
  try {
    tasks = (await readTaskItems(project.cwd))
      .filter((item): item is typeof item & { name: string } => item.name !== undefined)
      .map((item) => ({ name: item.name }));
  } catch {
    tasks = readTaktTaskFile(project.cwd)?.tasks ?? [];
  }
  const eligible = tasks.filter((task) => task.name !== undefined);
  if (eligible.length === 0) {
    context.ui.notify(`No queued tasks in ${project.label}.`, "info");
    return;
  }
  const chosen = await context.ui.select(
    `Tasks in ${project.label}`,
    eligible.map((task) => `${task.name} (${task.status ?? "?"})`),
  );
  if (!chosen) {
    return;
  }
  const name = eligible.find((task) => chosen.startsWith(task.name))?.name;
  if (name === undefined) {
    return;
  }
  const action = await context.ui.select(`Task ${name}`, [
    "reset to pending",
    "delete task",
    "nothing",
  ]);
  if (action === "reset to pending") {
    resetTaktTaskToPending(project.cwd, name)
      ? context.ui.notify(`Reset to pending: ${name}.`, "info")
      : context.ui.notify(`Task not found: ${name}.`, "warning");
  } else if (action === "delete task") {
    removeTaktTask(project.cwd, name)
      ? context.ui.notify(`Deleted task: ${name}.`, "info")
      : context.ui.notify(`Task not found: ${name}.`, "warning");
  }
}

/** Esc-closable raw screen overlay; the default widget stays summary-only. */
function openLiveScreenOverlay(context: ExtensionContext, project: ManagedProject): Promise<void> {
  return context.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const text = new Text("", 0, 0);
    const repaint = (): void => {
      const lines: string[] = [
        theme.fg("accent", `🎭 ${project.label} · ${project.cwd}`),
        theme.fg("dim", "raw TAKT screen · enter/esc closes"),
        "",
      ];
      if (project.runner.terminal) {
        lines.push(...visibleWidgetLines(renderTaktTerminal(project.runner.terminal), 22));
      } else if (project.summary) {
        lines.push(...renderSummaryScreen(project.summary).slice(0, 22));
      } else {
        lines.push(theme.fg("dim", "no TAKT activity observed yet"));
      }
      text.setText(lines.join("\n"));
      text.invalidate();
    };
    repaint();
    return {
      render: (width: number) => text.render(width),
      invalidate: () => text.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
          done();
        }
      },
    };
  }, { overlay: true });
}

async function loadPiModelRefs(): Promise<string[]> {
  try {
    const models = await listPiModels("pi");
    return models.map(formatPiModelRef);
  } catch (error) {
    throw new Error(`pi --list-models failed: ${errorMessage(error)}`);
  }
}

/** Type-to-filter selection dialog built on the same primitives as /takt:status. */
function openSearchableSelect(
  context: ExtensionContext,
  title: string,
  options: readonly string[],
): Promise<string | undefined> {
  return context.ui.custom<string | undefined>((_tui, theme, _keybindings, done) => {
    const controller = new SearchableListController(options);
    const text = new Text("", 0, 0);
    const repaint = (): void => {
      const lines = [
        theme.fg("accent", title),
        theme.fg("dim", `filter: ${controller.getQuery() || "(type to filter)"} · up/down move · enter pick · esc back`),
        "",
        ...controller.visible().map((entry) =>
          entry.active ? theme.fg("text", `❯ ${entry.text}`) : theme.fg("muted", `  ${entry.text}`)),
      ];
      text.setText(lines.join("\n"));
      text.invalidate();
    };
    repaint();
    return {
      render: (width: number) => text.render(width),
      invalidate: () => text.invalidate(),
      handleInput: (data: string) => {
        const action = controller.handleInput(data);
        if (action === "cancelled") {
          done(undefined);
          return;
        }
        if (action === "confirmed") {
          done(controller.getHighlightedValue());
          return;
        }
        if (action === "changed") {
          repaint();
        }
      },
    };
  }, { overlay: true });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runTaktClear(
  runner: TaktRunController,
  projectLabel: string,
  timeoutMs: number,
): Promise<void> {
  let result: Awaited<ReturnType<TaktRunController["waitForExit"]>>;
  try {
    await runner.start(["clear"]);
    result = await runner.waitForExit(timeoutMs);
  } catch (error) {
    throw new Error(`takt clear failed in ${projectLabel}: ${errorMessage(error)}`);
  }
  if (!result) {
    throw new Error(`takt clear did not report an exit in ${projectLabel}`);
  }
  if (result.code !== 0) {
    throw new Error(`takt clear failed in ${projectLabel} (exit ${result.code})`);
  }
}

async function stopWaitDispose(
  runner: TaktRunController,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  await runner.stop();
  await runner.waitForExit(timeoutMs);
  await waitUntilNotRunning(runner, signal, timeoutMs);
  await runner.dispose();
}

async function waitUntilNotRunning(
  runner: TaktRunController,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (runner.isRunning && Date.now() < deadline) {
    throwIfAborted(signal);
    await delay(50);
  }
  if (runner.isRunning) {
    throw new Error(`TAKT process did not stop within ${timeoutMs / 1_000} seconds`);
  }
}

async function waitForTaktInputPrompt(
  runner: TaktRunController,
  signal: AbortSignal | undefined,
  timeoutMs = TAKT_INPUT_PROMPT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (!runner.isRunning) {
      const result = await runner.waitForExit();
      throw new Error(`takt exec exited before input (exit ${result?.code ?? "unknown"})`);
    }
    if (terminalEndsWithText(runner.terminal, "Assistant>")) {
      return;
    }
    await delay(50);
  }
  throw new Error(`takt exec did not reach the Assistant> input prompt within ${timeoutMs / 1_000} seconds`);
}

async function waitForFreshTaktInputPrompt(
  runner: TaktRunController,
  previousScreenVersion: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (!runner.isRunning) {
      const result = await runner.waitForExit();
      throw new Error(`takt exec exited before the post-clarification prompt (exit ${result?.code ?? "unknown"})`);
    }
    if (runner.screenVersion > previousScreenVersion && terminalEndsWithText(runner.terminal, "Assistant>")) {
      return;
    }
    await delay(50);
  }
  throw new Error(
    `takt exec did not return to a fresh Assistant> prompt within ${timeoutMs / 1_000} seconds; /go was not sent`,
  );
}

async function waitForTaktInputAccepted(
  runner: TaktRunController,
  previousScreenVersion: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let postExitDeadline: number | undefined;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (
      runner.screenVersion > previousScreenVersion &&
      !terminalEndsWithText(runner.terminal, "Assistant>") &&
      terminalContainsText(runner.terminal, "Assistant> /go")
    ) {
      return;
    }
    if (!runner.isRunning) {
      const result = await runner.waitForExit();
      if (result?.code !== 0) {
        throw new Error(`takt exec exited while submitting /go (exit ${result?.code ?? "unknown"})`);
      }
      // On macOS, node-pty can deliver the final data event after onExit.
      // Keep a short drain window so a clean, fast TAKT exit is not reported
      // as a failed /go submission before xterm has parsed the output.
      postExitDeadline ??= Date.now() + TAKT_GO_OUTPUT_DRAIN_GRACE_MS;
      if (Date.now() >= postExitDeadline) {
        throw new Error(`takt exec exited while submitting /go (exit ${result?.code ?? "unknown"})`);
      }
    }
    await delay(50);
  }
  throw new Error(`takt exec did not acknowledge /go within ${timeoutMs / 1_000} seconds`);
}

async function waitForTaktResumeMenu(
  runner: TaktRunController,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (!runner.isRunning) {
      const result = await runner.waitForExit();
      throw new Error(`takt resume exited before selection (exit ${result?.code ?? "unknown"})`);
    }
    if (terminalContainsText(runner.terminal, "Select action:") && terminalContainsText(runner.terminal, "Requeue")) {
      return;
    }
    await delay(50);
  }
  throw new Error(`takt resume did not show the Requeue menu within ${timeoutMs / 1_000} seconds`);
}

async function waitForFreshTerminalOutput(
  runner: TaktRunController,
  previousScreenVersion: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (!runner.isRunning) {
      const result = await runner.waitForExit();
      throw new Error(`takt ${operation} exited before starting (exit ${result?.code ?? "unknown"})`);
    }
    if (runner.screenVersion > previousScreenVersion) {
      return;
    }
    await delay(50);
  }
  throw new Error(`takt ${operation} did not acknowledge the selection within ${timeoutMs / 1_000} seconds`);
}

export default function register(pi: ExtensionAPI): void {
  let runtime: TaktBridgeRuntime | undefined;
  const getRuntime = async (context: ExtensionContext): Promise<TaktBridgeRuntime> => {
    if (!runtime) {
      runtime = new TaktBridgeRuntime(context.cwd);
    }
    runtime.attach(context);
    await runtime.initialize();
    return runtime;
  };

  // No-slash conversational actions: "@<session> <verb>" selects a session and
  // runs the same operations the slash commands expose, without typing /takt:*.
  pi.on("input", async (event, context) => {
    const text = event.text ?? "";
    const match = /^\s*@([\w.-]+)\s+(stop|inspect|tasks|task|flush|status|live|talk)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (match === null) {
      return { action: "continue" };
    }
    try {
      const runtimeRef = await getRuntime(context);
      const sessions = runtimeRef.sessionPairs();
      const target = resolveSessionByMention(
        sessions.map((session) => ({ label: session.entry.label, cwd: session.entry.cwd })),
        match[1],
      );
      const project = sessions.find((session) => session.entry.cwd === target?.cwd)?.project;
      if (project === undefined) {
        return { action: "continue" };
      }
      const verb = match[2].toLocaleLowerCase();
      const rest = (match[3] ?? "").trim();
      switch (verb) {
        case "stop":
          await runtimeRef.stopActive(project.cwd, { confirm: false });
          context.ui.notify(`TAKT ${project.label} stopped.`, "info");
          break;
        case "inspect":
          await runtimeRef.inspectSessions();
          break;
        case "tasks":
        case "task":
          await manipulateTasksFromInspector(context, project);
          break;
        case "flush":
          await runtimeRef.flushQueuedInputs(project.cwd);
          break;
        case "status":
          await showStatus(context, project.cwd, runtimeRef.getProjectStatus(project.cwd));
          break;
        case "live":
          await runtimeRef.peekSession(project.cwd);
          break;
        case "talk":
          if (rest.length === 0) {
            await talkToSession(context, project, sessions);
          } else if (project.runner.isRunning && project.stage !== "waiting_prompt") {
            const depth = project.queuedInputs?.enqueue(rest) ?? 0;
            context.ui.notify(`⏳ ${project.label} executing; queued (⏳q${depth}).`, "info");
          } else {
            project.runner.write(formatTaktPastedInput(rest));
            context.ui.notify(`Message sent to TAKT ${project.label}.`, "info");
          }
          break;
      }
      return { action: "handled" };
    } catch (error) {
      context.ui.notify(`@-action failed: ${errorMessage(error)}`, "error");
      return { action: "continue" };
    }
  });

  pi.registerTool({
    name: "takt_project_setup",
    label: "TAKT Project Setup",
    description: "Create project-local .takt scaffolding, copy one safe exec preset, and register a reusable profile.",
    promptSnippet: "Register a TAKT project and prepare its local .takt preset",
    promptGuidelines: [
      "Use before takt_exec_prompt when the target profile or project-local .takt preset may be missing.",
      "Pass the exact target cwd from the user or the current Pi project; do not guess a repository path.",
      "The setup is idempotent and copies only the selected preset from the global TAKT directory; it never copies runs, tasks, sessions, logs, or credentials.",
      "Use overwrite:true only when the user explicitly wants an existing profile moved to another cwd.",
    ],
    parameters: TAKT_PROJECT_SETUP_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const activeRuntime = await getRuntime(context);
      const result = await activeRuntime.setupProject(params);
      const copied = result.copiedFiles.length > 0
        ? `\ncopied: ${result.copiedFiles.join(", ")}`
        : "";
      const warnings = result.warnings.length > 0
        ? `\nwarnings: ${result.warnings.join("; ")}`
        : "";
      return {
        content: [{
          type: "text",
          text: [
            `TAKT project ready: ${result.profile}`,
            result.cwd,
            `local .takt: ${result.taktDir}`,
            `preset: ${result.preset} (${result.presetSource})`,
            `registered: ${result.registered}`,
            copied,
            warnings,
          ].filter(Boolean).join("\n"),
        }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "takt_enqueue_task",
    label: "TAKT Enqueue Task",
    description: "Queue a confirmed task through TAKT ACP without starting execution.",
    promptSnippet: "Queue a finalized task in TAKT after Pi-side planning",
    promptGuidelines: [
      "Call only after the task body is finalized and the user has confirmed enqueueing.",
      "Use takt_project_setup first when the named profile or exact target project is not ready.",
      "This tool creates a pending task only; use takt_exec_prompt or takt-pi-runner for execution.",
      "Pass the exact task body unchanged. Do not silently shorten acceptance criteria or verification steps.",
    ],
    parameters: TAKT_ENQUEUE_TASK_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const activeRuntime = await getRuntime(context);
      const result = await activeRuntime.enqueueProfileTask(
        params.profile?.trim() || "pi-docs",
        params.task,
      );
      return {
        content: [{
          type: "text",
          text: `TAKT task queued: ${result.project}\n${result.cwd}\nstopReason: ${result.stopReason}`,
        }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "takt_exec_prompt",
    label: "TAKT Exec Prompt",
    description: "Run a task through a named TAKT project profile, show raw output in the Pi widget, and submit /go.",
    promptSnippet: "Run an exact task prompt through a named TAKT profile with raw Pi TUI output",
    promptGuidelines: [
      "Use takt_exec_prompt when the user asks to execute an issue or task through TAKT with Pi agents.",
      "Pass the user's task body exactly as prompt; default profile pi-docs is explicit and must not be replaced by a guessed path.",
      "Do not shell out to takt exec when takt_exec_prompt is available; the tool owns the PTY and stacked Pi widget.",
      "If the tool reports a missing profile or extension, stop and report the missing configuration instead of guessing.",
    ],
    parameters: TAKT_EXEC_PROMPT_PARAMETERS,
    async execute(_toolCallId, params, signal, onUpdate, context) {
      const activeRuntime = await getRuntime(context);
      const result = await activeRuntime.executePrompt(
        params.profile?.trim() || "pi-docs",
        params.prompt,
        {
          clear: params.clear,
          preset: params.preset,
          goMode: params.goMode,
          sendGo: params.sendGo,
          replace: params.replace,
        },
        signal,
        (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
      );
      return {
        content: [{
          type: "text",
          text: `TAKT started: ${result.profile} (${result.preset})\n${result.cwd}\nreplaced: ${result.replaced}\ngoMode: ${result.goMode}\nsentGo: ${result.sentGo}\nawaitingGo: ${result.awaitingGo}\nmode: pi-auto`,
        }],
        details: result,
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "takt_submit_go",
    label: "TAKT Submit GO",
    description: "Submit /go to a bridge-owned TAKT session that is waiting in manual GO mode.",
    promptSnippet: "Explicitly start a task after takt_exec_prompt manual GO mode",
    promptGuidelines: [
      "Use only after takt_exec_prompt returns awaitingGo:true.",
      "This sends raw /go plus Enter; it does not replay or modify the task body.",
      "Read the live screen first when approval depends on TAKT's clarification response.",
    ],
    parameters: TAKT_SUBMIT_GO_PARAMETERS,
    async execute(_toolCallId, params, signal, onUpdate, context) {
      const activeRuntime = await getRuntime(context);
      const result = await activeRuntime.submitGo(
        params.profile?.trim() || "",
        signal,
        (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
      );
      return {
        content: [{ type: "text", text: `TAKT /go submitted: ${result.project}\n${result.cwd}` }],
        details: result,
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "takt_resume_run",
    label: "TAKT Resume Run",
    description: "Resume a checkpointed TAKT run through the bridge without clear or a fresh exec task.",
    promptSnippet: "Resume a stopped TAKT checkpoint with an explicit Pi provider/model route",
    promptGuidelines: [
      "Use after takt_stop when the existing checkpoint must continue rather than restart from the beginning.",
      "This starts takt resume, selects Requeue, and never runs takt clear.",
      "Keep provider=pi when Claude must not be used; pass the exact model route when required.",
    ],
    parameters: TAKT_RESUME_PARAMETERS,
    async execute(_toolCallId, params, signal, onUpdate, context) {
      const activeRuntime = await getRuntime(context);
      const result = await activeRuntime.resumeRun(
        params.profile?.trim() || "pi-docs",
        {
          provider: params.provider,
          model: params.model,
          replace: params.replace,
        },
        signal,
        (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
      );
      return {
        content: [{
          type: "text",
          text: `TAKT resumed: ${result.profile}\n${result.cwd}\nprovider: ${result.provider}${result.model ? `\nmodel: ${result.model}` : ""}\nmode: pi-auto`,
        }],
        details: result,
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "takt_stop",
    label: "TAKT Stop",
    description: "Stop the active bridge-owned TAKT PTY without an interactive confirmation prompt.",
    promptSnippet: "Stop a stuck or running bridge-owned TAKT session before retrying",
    promptGuidelines: [
      "Use takt_stop when TAKT is already running and you need a clean restart.",
      "Prefer takt_exec_prompt with replace:true for one-shot restart+submit flows.",
      "Do not shell out to taskkill or takt stop when this tool is available.",
    ],
    parameters: TAKT_STOP_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const activeRuntime = await getRuntime(context);
      const result = await activeRuntime.stopActive(params.profile?.trim() || "", {
        confirm: false,
        forceObserved: params.forceObserved ?? false,
      });
      return {
        content: [{
          type: "text",
          text: result.stopped
            ? `TAKT stopped: ${result.project}\n${result.cwd}${result.reconciledRuns.length ? `\nreconciled: ${result.reconciledRuns.join(", ")}` : ""}`
            : result.reconciledRuns.length
              ? `TAKT stale metadata reconciled: ${result.reconciledRuns.join(", ")}`
              : `TAKT was not running${result.project ? `: ${result.project}` : ""}`,
        }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "takt_set_mode",
    label: "TAKT Set Mode",
    description: "Cycle or set TAKT input mode: pi, takt, or pi-auto.",
    promptSnippet: "Switch Pi/TAKT input mode for follow-up control",
    promptGuidelines: [
      "takt_exec_prompt already switches to pi-auto after a successful submit.",
      "Use takt_set_mode when you need an explicit mode change outside that flow.",
    ],
    parameters: TAKT_SET_MODE_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const activeRuntime = await getRuntime(context);
      const mode = await activeRuntime.cycleOrSetInputMode(params.mode);
      return {
        content: [{ type: "text", text: `TAKT input mode: ${mode}` }],
        details: { mode },
      };
    },
  });

  pi.registerTool({
    name: "takt_read_screen",
    label: "TAKT Read Screen",
    description: "Read the current bridge-owned TAKT live screen for pi-auto follow-up decisions.",
    promptSnippet: "Inspect the live TAKT widget screen while pi-auto mode is active",
    promptGuidelines: [
      "Use takt_read_screen before sending follow-up input in pi-auto mode.",
      "Only the active bridge-owned TAKT PTY is visible; external status cards are not raw screens.",
    ],
    parameters: TAKT_READ_SCREEN_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const activeRuntime = await getRuntime(context);
      const screen = await activeRuntime.readActiveScreen(params.rows);
      const header = [
        `mode: ${screen.mode}`,
        screen.project ? `project: ${screen.project}` : "project: none",
        screen.cwd ? `cwd: ${screen.cwd}` : undefined,
        `status: ${screen.status}`,
        screen.pid !== undefined ? `pid: ${screen.pid}` : undefined,
        `running: ${screen.running}`,
        `ptyRunning: ${screen.ptyRunning}`,
        `stage: ${screen.stage}`,
        screen.lastExit ? `lastExit: ${formatTaktLastExit(screen.lastExit)}` : undefined,
      ].filter(Boolean);
      return {
        content: [{
          type: "text",
          text: `${header.join("\n")}\n\n${screen.lines.join("\n") || "(empty screen)"}`,
        }],
        details: screen,
      };
    },
  });

  pi.registerTool({
    name: "takt_send_input",
    label: "TAKT Send Input",
    description: "Send follow-up text to the active bridge-owned TAKT PTY while pi-auto mode is enabled.",
    promptSnippet: "Send allowed TAKT follow-up input during pi-auto mode",
    promptGuidelines: [
      "Only use takt_send_input after /takt:mode pi-auto or the Ctrl+Alt+T cycle lands on pi-auto.",
      "Read the live screen with takt_read_screen first when deciding what to send.",
      "Keep auto input short. Destructive commands require an interactive confirmation.",
      "Do not use this tool to replace takt_exec_prompt for the initial clear → exec → /go flow.",
    ],
    parameters: TAKT_SEND_INPUT_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const activeRuntime = await getRuntime(context);
      const result = await activeRuntime.sendAutoInput(params.text, { submit: params.submit });
      return {
        content: [{
          type: "text",
          text: `TAKT auto input sent to ${result.project}${result.submitted ? " (submitted)" : ""}\n${result.cwd}`,
        }],
        details: result,
      };
    },
  });

  pi.on("session_start", async (_event, context) => {
    const previousRuntime = runtime;
    if (previousRuntime) {
      try {
        await previousRuntime.shutdown();
      } catch (error) {
        previousRuntime.attach(context);
        context.ui.notify(
          `TAKT previous runtime retained because shutdown is incomplete: ${errorMessage(error)}`,
          "error",
        );
        return;
      }
    }

    const nextRuntime = new TaktBridgeRuntime(context.cwd);
    nextRuntime.attach(context);
    runtime = nextRuntime;
    await nextRuntime.initialize();
  });

  pi.on("session_shutdown", async (_event, context) => {
    const activeRuntime = runtime;
    if (!activeRuntime) {
      return;
    }
    try {
      await activeRuntime.shutdown();
      runtime = undefined;
    } catch (error) {
      activeRuntime.attach(context);
      context.ui.notify(
        `TAKT runtime retained because shutdown is incomplete: ${errorMessage(error)}`,
        "error",
      );
    }
  });

  pi.registerCommand("takt", {
    description: "Run or attach to stacked TAKT project terminals",
    handler: async (_args, _context) => {
      await runtime?.runOrAttach();
    },
  });

  pi.registerCommand("takt:live", {
    description: "Peek the raw TAKT screen of a session (Esc to close)",
    handler: async (args, _context) => {
      await runtime?.peekSession(args);
    },
  });

  pi.registerCommand("takt:lang", {
    description: "Switch widget language: en | ja (no argument toggles)",
    handler: async (args, _context) => {
      await runtime?.setWidgetLanguage(args);
    },
  });

  pi.registerCommand("takt:ask", {
    description: "Talk to a TAKT session: /takt:ask @label <message>",
    handler: async (args, _context) => {
      await runtime?.askAgent(args);
    },
  });

pi.registerCommand("takt:inspect", {
    description: "Live session inspector: see and pick what each TAKT session is doing",
    handler: async (_args, _context) => {
      await runtime?.inspectSessions();
    },
  });

pi.registerCommand("takt:flush", {
    description: "Flush queued input lines into the running TAKT session",
    handler: async (args, _context) => {
      await runtime?.flushQueuedInputs(args);
    },
  });

  pi.registerCommand("takt:sessions", {
    description: "List TAKT sessions and pick one to peek",
    handler: async (_args, _context) => {
      await runtime?.listSessions();
    },
  });

  pi.registerCommand("takt:status", {
    description: "Open the TAKT diagnostic status overlay",
    handler: async (args, context) => {
      try {
        const cwd = args.trim()
          ? runtime?.resolveTargetPath(args, context.cwd) ?? normalizeProjectPath(args, context.cwd)
          : context.cwd;
        await showStatus(context, cwd, runtime?.getProjectStatus(cwd));
      } catch (error) {
        context.ui.notify(`TAKT status path failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("takt:enqueue", {
    description: "Queue a TAKT task through ACP; pass a project path to target another folder",
    handler: async (args, context) => {
      if (!context.hasUI || !runtime) {
        return;
      }
      const task = await context.ui.input("TAKT task", "Describe the task to queue");
      if (task?.trim()) {
        await runtime.enqueueTask(task.trim(), args);
      }
    },
  });

  pi.registerCommand("takt:project", {
    description: "Register another repo or development folder for TAKT monitoring",
    handler: async (args, _context) => {
      await runtime?.addProject(args);
    },
  });

  pi.registerCommand("takt:project:init", {
    description: "Create project-local .takt scaffolding and register a named profile",
    handler: async (args, context) => {
      if (!runtime || !context.hasUI) {
        return;
      }
      const profile = args.trim() || undefined;
      try {
        const result = await runtime.setupProject({ profile, cwd: context.cwd });
        context.ui.notify(
          `TAKT project ready: ${result.profile}\n${result.cwd}\npreset: ${result.preset} (${result.presetSource})`,
          "info",
        );
      } catch (error) {
        context.ui.notify(`TAKT project setup failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("takt:profile:add", {
    description: "Create a named TAKT project profile with an optional exec preset",
    handler: async (args, _context) => {
      await runtime?.addProfile(args);
    },
  });

  pi.registerCommand("takt:profile:list", {
    description: "List named TAKT project profiles",
    handler: async (_args, _context) => {
      await runtime?.listProfiles();
    },
  });

  pi.registerCommand("takt:profile:remove", {
    description: "Remove a named TAKT project profile",
    handler: async (args, _context) => {
      await runtime?.removeProfile(args);
    },
  });

  pi.registerCommand("takt:profile", {
    description: "List named TAKT project profiles",
    handler: async (_args, _context) => {
      await runtime?.listProfiles();
    },
  });

  pi.registerCommand("takt:project:remove", {
    description: "Remove a registered TAKT project folder",
    handler: async (args, _context) => {
      await runtime?.removeProject(args);
    },
  });

  pi.registerCommand("takt:models", {
    description: "Pick per-step Pi models for a TAKT workflow into .takt/runtime.yaml",
    handler: async (args, context) => {
      try {
        await runtime?.selectStepModels(context, args.trim() || undefined);
      } catch (error) {
        context.ui.notify(`takt:models failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("takt:start", {
    description: "Start pending TAKT tasks; pass a project path to target another folder",
    handler: async (args, _context) => {
      await runtime?.startPending(args);
    },
  });

  pi.registerCommand("takt:exec", {
    description: "Start a fresh interactive TAKT exec in a registered folder",
    handler: async (args, _context) => {
      await runtime?.startExec(args);
    },
  });

  pi.registerCommand("takt:clear", {
    description: "Run takt clear in a selected project before a fresh exec",
    handler: async (args, _context) => {
      await runtime?.clearSessions(args);
    },
  });

  pi.registerCommand("takt:send", {
    description: "Send pasted multiline input to a TAKT exec session",
    handler: async (args, _context) => {
      await runtime?.sendInput(args);
    },
  });

  pi.registerCommand("takt:mode", {
    description: "Cycle or set TAKT input mode: pi, takt, or pi-auto",
    handler: async (args, _context) => {
      await runtime?.cycleOrSetInputMode(args);
    },
  });

  pi.registerCommand("takt:session", {
    description: "Switch TAKT fullscreen focus to the previous/next running session",
    handler: async (args, _context) => {
      await runtime?.switchTaktFocusSession(args);
    },
  });

  pi.registerCommand("takt:stop", {
    description: "Stop a TAKT process started by Pi",
    handler: async (args, _context) => {
      await runtime?.stopRunning(args);
    },
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Cycle TAKT input mode (pi → takt → pi-auto)",
    handler: async () => {
      await runtime?.cycleInputMode();
    },
  });

}
