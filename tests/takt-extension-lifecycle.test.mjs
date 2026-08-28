import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register from "../extensions/index.ts";

const DEAD_OWNER_PID = "999999999";

function createContext(cwd) {
  const notifications = [];
  const statuses = [];
  const widgetUpdates = [];
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    notifications,
    statuses,
    widgetUpdates,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      },
      setWidget(key, widget, options) {
        widgetUpdates.push({ key, widget, options });
      },
      onTerminalInput() {
        return () => {};
      },
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined,
    },
  };
}

function loadExtension() {
  const tools = new Map();
  const events = new Map();
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand() {},
    registerShortcut() {},
  };
  register(pi);
  return { tools, events };
}

async function invoke(tools, name, params, context) {
  return tools.get(name).execute("test-call", params, undefined, () => {}, context);
}

function writeProfile(configRoot, cwd) {
  const directory = join(configRoot, "pi-takt-bridge");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "profiles.json"),
    JSON.stringify({ version: 1, profiles: [{ name: "pi-docs", cwd, preset: "default" }] }),
    "utf8",
  );
}

function createTaktCommand(directory) {
  const nodeScript = join(directory, "fake-takt.mjs");
  writeFileSync(nodeScript, [
    'import { appendFileSync } from "node:fs";',
    "const logPath = process.env.TEST_TAKT_LOG;",
    "const args = process.argv.slice(2);",
    "const operation = args.at(-1) === \"resume\" ? \"resume\" : args[0];",
    "const preset = operation === \"exec\" ? args[1] : undefined;",
    "const event = (value) => appendFileSync(logPath, `${value}\\n`);",
    "if (operation === \"list\") {",
    "  if (process.env.TEST_LIST_MODE === \"fail\") {",
    "    process.stderr.write(\"invalid task list\\n\");",
    "    process.exit(7);",
    "  }",
    "  const taskMode = process.env.TEST_TASK_MODE;",
    "  const tasks = taskMode === \"pending\"",
    "    ? [{ kind: \"pending\", name: \"pending-task\" }]",
    "    : taskMode === \"external\" || taskMode === \"stale\"",
    "      ? [{ kind: \"running\", ownerPid: Number(process.env.TEST_OWNER_PID), stage: \"external-stage\" }]",
    "    : [];",
    "  process.stdout.write(JSON.stringify({ tasks }) + \"\\n\");",
    "  process.exit(0);",
    "}",
    "if (operation === \"clear\") {",
    "  event(\"clear\");",
    "  if (process.env.TEST_CLEAR_MODE === \"fail\") process.exit(7);",
    "  process.exit(0);",
    "}",
    "if (operation === \"run\") {",
    "  event(\"run\");",
    "  process.stdout.write(\"Running pending tasks…\\r\\n\");",
    "  process.on(\"SIGINT\", () => { event(\"signal:run\"); process.exit(130); });",
    "  setTimeout(() => process.exit(0), 80);",
    "}",
    "else if (operation === \"resume\") {",
    "  event(`resume:${args.join(\"|\")}`);",
    "  process.on(\"SIGINT\", () => { event(\"signal:resume\"); process.exit(130); });",
    "  process.stdout.write(\"Select action:\\r\\n> Requeue\\r\\n  Cancel\\r\\n\");",
    "  process.stdin.setEncoding(\"utf8\");",
    "  process.stdin.once(\"data\", () => { event(\"resume:requeue\"); if (process.env.TEST_RESUME_MODE === \"stale-run\") { process.stdout.write(\"[ERROR] Workflow \\\"exec-x\\\" not found for direct run \\\"20260817-x\\\"\\r\\n\"); setTimeout(() => process.exit(1), 30); } else { process.stdout.write(\"Resuming workflow…\\r\\n\"); } });",
    "} else {",
    "if (operation !== \"exec\") process.exit(2);",
    "event(`exec:${preset}`);",
    "process.on(\"exit\", (code) => event(`exit:${preset}:${code}`));",
    "process.on(\"SIGINT\", () => { event(`signal:${preset}`); process.exit(130); });",
    "process.stdout.write(\"Assistant>\\r\\n\");",
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", (data) => {",
    "  const isGo = data.includes(\"/go\");",
    "  event(`input:${preset}:${isGo ? \"go\" : \"body\"}`);",
    "  if (!isGo) {",
    "    process.stdout.write(\"clarifying task…\\r\\n\");",
    "    const delay = Number(process.env.TEST_PROMPT_DELAY_MS || 5);",
    "    setTimeout(() => { event(`ready:${preset}`); process.stdout.write(\"Assistant>\\r\\n\"); }, delay);",
    "  } else {",
    "    process.stdout.write(\"Assistant> /go\\r\\nStarting workflow…\\r\\n\");",
    "  }",
    "  if (preset === \"second\" && data.includes(\"/go\")) {",
    "    event(\"natural:second\");",
    "    process.exit(0);",
    "  }",
    "});",
    "}",
  ].join("\n"), "utf8");

  const quote = (value) => `"${value.replaceAll('"', '\\"')}"`;
  if (process.platform === "win32") {
    const command = join(directory, "fake-takt.cmd");
    writeFileSync(command, `@echo off\r\n@${quote(process.execPath)} ${quote(nodeScript)} %*\r\n`, "utf8");
    return command;
  }
  const command = join(directory, "fake-takt.sh");
  writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nodeScript)} "$@"\n`, "utf8");
  chmodSync(command, 0o755);
  return command;
}

function configureEnvironment(root, command, logPath, taskMode, listMode = "ok") {
  const previous = new Map([
    ["APPDATA", process.env.APPDATA],
    ["XDG_CONFIG_HOME", process.env.XDG_CONFIG_HOME],
    ["TAKT_CONFIG_DIR", process.env.TAKT_CONFIG_DIR],
    ["TAKT_COMMAND", process.env.TAKT_COMMAND],
    ["TEST_TAKT_LOG", process.env.TEST_TAKT_LOG],
    ["TEST_TASK_MODE", process.env.TEST_TASK_MODE],
    ["TEST_LIST_MODE", process.env.TEST_LIST_MODE],
    ["TEST_OWNER_PID", process.env.TEST_OWNER_PID],
    ["TEST_CLEAR_MODE", process.env.TEST_CLEAR_MODE],
    ["TEST_PROMPT_DELAY_MS", process.env.TEST_PROMPT_DELAY_MS],
    ["TEST_RESUME_MODE", process.env.TEST_RESUME_MODE],
  ]);
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.TAKT_CONFIG_DIR = root;
  process.env.TAKT_COMMAND = command;
  process.env.TEST_TAKT_LOG = logPath;
  process.env.TEST_TASK_MODE = taskMode;
  process.env.TEST_LIST_MODE = listMode;
  process.env.TEST_OWNER_PID = taskMode === "stale" ? DEAD_OWNER_PID : String(process.pid);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

test("exec waits for a fresh Assistant prompt before sending /go", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-fresh-go-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  process.env.TEST_PROMPT_DELAY_MS = "150";
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const result = await invoke(tools, "takt_exec_prompt", {
      profile: "pi-docs",
      prompt: "wait before go",
      clear: false,
      preset: "delayed",
    }, context);
    assert.equal(result.details.sentGo, true);
    const lines = logLines(logPath);
    assert.ok(lines.indexOf("input:delayed:body") < lines.indexOf("ready:delayed"));
    assert.ok(lines.indexOf("ready:delayed") < lines.indexOf("input:delayed:go"));
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("manual GO mode never submits /go until takt_submit_go is called", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-manual-go-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const started = await invoke(tools, "takt_exec_prompt", {
      profile: "pi-docs",
      prompt: "clarify but do not go",
      clear: false,
      preset: "manual",
      goMode: "manual",
    }, context);
    assert.equal(started.details.goMode, "manual");
    assert.equal(started.details.sentGo, false);
    assert.equal(started.details.awaitingGo, true);
    assert.equal(logLines(logPath).includes("input:manual:go"), false);

    const screen = await invoke(tools, "takt_read_screen", { rows: 4 }, context);
    assert.equal(screen.details.stage, "awaiting_go");

    const submitted = await invoke(tools, "takt_submit_go", { profile: "pi-docs" }, context);
    assert.equal(submitted.details.sentGo, true);
    assert.equal(logLines(logPath).includes("input:manual:go"), true);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("resume requeues a checkpoint with the requested Pi model and without clear", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-resume-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const result = await invoke(tools, "takt_resume_run", {
      profile: "pi-docs",
      provider: "pi",
      model: "cursor/composer-2.5-fast",
    }, context);
    assert.equal(result.details.provider, "pi");
    assert.equal(result.details.model, "cursor/composer-2.5-fast");
    const lines = logLines(logPath);
    assert.ok(lines.includes("resume:--provider|pi|--model|cursor/composer-2.5-fast|resume"));
    assert.ok(lines.includes("resume:requeue"));
    assert.equal(lines.includes("clear"), false);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("resume fails fast when TAKT targets a stale run without a workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-resume-stale-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  process.env.TEST_RESUME_MODE = "stale-run";
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    await assert.rejects(
      invoke(tools, "takt_resume_run", { profile: "pi-docs", provider: "pi" }, context),
      /not found for direct run/,
    );
    const lines = logLines(logPath);
    assert.ok(lines.includes("resume:--provider|pi|resume"));
    assert.ok(lines.includes("resume:requeue"));
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("run pending starts all queued tasks through the shared bridge PTY lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-run-pending-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  mkdirSync(join(root, "builtins", "en", "workflows"), { recursive: true });
  writeFileSync(join(root, "builtins", "en", "workflows", "default.yaml"), "name: default\nsteps: []\n", "utf8");
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "pending");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const catalog = await invoke(tools, "takt_workflow_catalog", { profile: "pi-docs" }, context);
    assert.equal(catalog.details.ready, true);
    assert.deepEqual(catalog.details.workflows.map((entry) => entry.name), ["default"]);
    const result = await invoke(tools, "takt_run_pending", { profile: "pi-docs" }, context);
    assert.equal(result.details.started, true);
    assert.equal(result.details.pending, 1);
    await waitFor(() => logLines(logPath).includes("run"));
    assert.ok(logLines(logPath).includes("run"));
    const screen = await waitFor(async () => {
      const current = await invoke(tools, "takt_read_screen", { rows: 4 }, context);
      return current.details.status === "completed" ? current : undefined;
    });
    assert.equal(screen.details.stage, "completed");
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition did not settle within ${timeoutMs}ms`);
}

function logLines(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

function writeCompletedRunMeta(project, slug = "completed-run", timestamp = new Date()) {
  const runRoot = join(project, ".takt", "runs", slug);
  const now = timestamp.toISOString();
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, "meta.json"), JSON.stringify({
    task: "completed workflow",
    workflow: "exec-test",
    runSlug: slug,
    runRoot,
    reportDirectory: join(runRoot, "reports"),
    contextDirectory: join(runRoot, "context"),
    logsDirectory: join(runRoot, "logs"),
    status: "completed",
    startTime: now,
    endTime: now,
    updatedAt: now,
  }), "utf8");
}

function writeOwnerlessRunningMeta(project, slug = "stale-run", ownerPid) {
  const runRoot = join(project, ".takt", "runs", slug);
  const now = new Date().toISOString();
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, "meta.json"), JSON.stringify({
    task: "checkpointed workflow",
    workflow: "exec-test",
    runSlug: slug,
    runRoot,
    reportDirectory: join(runRoot, "reports"),
    contextDirectory: join(runRoot, "context"),
    logsDirectory: join(runRoot, "logs"),
    status: "running",
    ...(ownerPid === undefined ? {} : { ownerPid }),
    startTime: now,
    updatedAt: now,
    resume_point: { iteration: 15 },
  }), "utf8");
  return join(runRoot, "meta.json");
}

test("extension replaces owned exec and starts again after natural exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-extension-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const first = await invoke(tools, "takt_exec_prompt", {
      profile: "pi-docs",
      prompt: "first body",
      preset: "first",
    }, context);
    assert.equal(first.details.replaced, false);

    const second = await invoke(tools, "takt_exec_prompt", {
      profile: "pi-docs",
      prompt: "second body",
      clear: false,
      replace: true,
      preset: "second",
    }, context);
    assert.equal(second.details.replaced, true);

    const completed = await waitFor(async () => {
      const result = await invoke(tools, "takt_read_screen", { rows: 4 }, context);
      return result.details.status === "completed" ? result.details : undefined;
    });
    assert.equal(completed.stage, "completed");
    assert.equal(completed.lastExit.code, 0);
    assert.equal(typeof completed.pid, "number");
    // Run outcome retention: the widget stays mounted with the ✅ outcome row
    // instead of being cleared the moment the run finishes.
    assert.notEqual(context.widgetUpdates.at(-1)?.widget, undefined);
    assert.ok(context.notifications.some(
      (entry) => entry.message.includes("✅ TAKT project finished") && entry.type === "info",
    ), String(context.notifications.map((entry) => entry.message)));

    const third = await invoke(tools, "takt_exec_prompt", {
      profile: "pi-docs",
      prompt: "third body",
      preset: "third",
    }, context);
    assert.equal(third.details.replaced, false);

    const lines = logLines(logPath);
    const firstClear = lines.indexOf("clear");
    const firstExec = lines.indexOf("exec:first");
    const firstExit = lines.indexOf("exit:first:130");
    const secondClear = lines.indexOf("clear", firstExit + 1);
    const secondExec = lines.indexOf("exec:second");
    const secondExit = lines.indexOf("exit:second:0");
    const thirdClear = lines.indexOf("clear", secondExit + 1);
    const thirdExec = lines.indexOf("exec:third");
    assert.ok(firstClear >= 0 && firstClear < firstExec);
    assert.ok(firstExec < firstExit && firstExit < secondClear && secondClear < secondExec);
    assert.ok(secondExec < secondExit && secondExit < thirdClear && thirdClear < thirdExec);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("stopping a bridge-owned PTY clears the live widget", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-stop-widget-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    await invoke(tools, "takt_exec_prompt", {
      profile: "pi-docs",
      prompt: "stop and clear widget",
      clear: false,
      preset: "first",
    }, context);
    assert.ok(context.widgetUpdates.some((update) => update.widget !== undefined));

    const result = await invoke(tools, "takt_stop", { profile: "pi-docs" }, context);
    assert.equal(result.details.stopped, true);
    assert.equal(context.widgetUpdates.at(-1)?.widget, undefined);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("completed exec workflow keeps the retained outcome widget alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-completed-widget-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    writeCompletedRunMeta(project, "historical-run", new Date(Date.now() - 60_000));
    await invoke(tools, "takt_exec_prompt", {
      profile: "pi-docs",
      prompt: "workflow that completes while exec waits",
      clear: false,
      preset: "first",
    }, context);
    assert.ok(context.widgetUpdates.some((update) => update.widget !== undefined));

    await new Promise((resolve) => setTimeout(resolve, 2_200));
    assert.notEqual(context.widgetUpdates.at(-1)?.widget, undefined);

    // The completed run keeps the widget mounted with the retained ✅/❌ row.
    writeCompletedRunMeta(project);
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    assert.notEqual(context.widgetUpdates.at(-1)?.widget, undefined);
    const screen = await invoke(tools, "takt_read_screen", { rows: 4 }, context);
    assert.equal(screen.details.status, "completed");
    assert.equal(screen.details.running, false);
    assert.equal(screen.details.ptyRunning, true);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("project setup registers a profile and materializes a project-local preset", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-project-setup-extension-"));
  const project = join(root, "project");
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  mkdirSync(project);
  mkdirSync(join(root, "exec", "presets"), { recursive: true });
  writeFileSync(join(root, "exec", "presets", "pi-docs.yaml"), "name: pi-docs\nworkers: []\n", "utf8");
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const result = await invoke(tools, "takt_project_setup", {
      profile: "bridge",
      cwd: project,
      preset: "pi-docs",
    }, context);
    assert.equal(result.details.profile, "bridge");
    assert.equal(result.details.presetSource, "global");
    assert.equal(existsSync(join(project, ".takt", "exec", "presets", "pi-docs.yaml")), true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "pi-takt-bridge", "profiles.json"), "utf8")).profiles, [
      { name: "bridge", cwd: project, preset: "pi-docs" },
    ]);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("project setup surfaces an external run stored in a managed clone", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-project-clone-extension-"));
  const currentProject = join(root, "current");
  const targetProject = join(root, "target");
  const managedClone = join(root, "managed-clone");
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  mkdirSync(currentProject);
  mkdirSync(targetProject);
  mkdirSync(managedClone);
  mkdirSync(join(root, "exec", "presets"), { recursive: true });
  mkdirSync(join(targetProject, ".takt", "clone-meta"), { recursive: true });
  writeFileSync(join(root, "exec", "presets", "pi-docs.yaml"), "name: pi-docs\nworkers: []\n", "utf8");
  writeFileSync(
    join(targetProject, ".takt", "clone-meta", "external.json"),
    JSON.stringify({ branch: "feature/demo", clonePath: managedClone }),
    "utf8",
  );
  writeOwnerlessRunningMeta(managedClone, "external-clone-run", process.pid);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(currentProject);

  try {
    await invoke(tools, "takt_project_setup", {
      profile: "external-project",
      cwd: targetProject,
      preset: "pi-docs",
    }, context);

    // Session-owned widget rule: an externally started clone run must not
    // mount the live widget; it stays reachable through explicit diagnostics.
    const lastWidgetUpdate = context.widgetUpdates.at(-1);
    assert.ok(lastWidgetUpdate === undefined || lastWidgetUpdate.widget === undefined);
    const observed = await invoke(tools, "takt_read_screen", { rows: 4 }, context);
    assert.equal(observed.details.cwd, targetProject);
    assert.equal(observed.details.status, "live");
    assert.equal(observed.details.pid, process.pid);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("forced stop reconciles stale metadata inside a managed clone", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-clone-reconcile-"));
  const currentProject = join(root, "current");
  const targetProject = join(root, "target");
  const managedClone = join(root, "managed-clone");
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  mkdirSync(currentProject);
  mkdirSync(targetProject);
  mkdirSync(managedClone);
  mkdirSync(join(root, "exec", "presets"), { recursive: true });
  mkdirSync(join(targetProject, ".takt", "clone-meta"), { recursive: true });
  writeFileSync(join(root, "exec", "presets", "pi-docs.yaml"), "name: pi-docs\nworkers: []\n", "utf8");
  writeFileSync(
    join(targetProject, ".takt", "clone-meta", "external.json"),
    JSON.stringify({ branch: "feature/demo", clonePath: managedClone }),
    "utf8",
  );
  const metaPath = writeOwnerlessRunningMeta(managedClone, "clone-stale-run");
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(currentProject);

  try {
    await invoke(tools, "takt_project_setup", {
      profile: "external-project",
      cwd: targetProject,
      preset: "pi-docs",
    }, context);
    const result = await invoke(tools, "takt_stop", {
      profile: "external-project",
      forceObserved: true,
    }, context);

    assert.deepEqual(result.details.reconciledRuns, ["clone-stale-run"]);
    assert.equal(JSON.parse(readFileSync(metaPath, "utf8")).status, "aborted");
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("extension cleans up a failed clear before reporting the error", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-clear-failure-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  process.env.TEST_CLEAR_MODE = "fail";
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    await assert.rejects(
      () => invoke(tools, "takt_exec_prompt", {
        profile: "pi-docs",
        prompt: "clear must fail",
        preset: "never-started",
      }, context),
      /takt clear failed in/,
    );
    const lines = logLines(logPath);
    assert.equal(lines.includes("clear"), true);
    assert.equal(lines.some((line) => line.startsWith("exec:")), false);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("extension replaces an observed stale session instead of blocking fresh exec", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-stale-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "stale");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const observed = await invoke(tools, "takt_read_screen", { rows: 4 }, context);
    assert.equal(observed.details.status, "stale");

    const started = await invoke(tools, "takt_exec_prompt", {
      profile: "pi-docs",
      prompt: "replace stale",
      clear: false,
      preset: "second",
    }, context);
    assert.equal(started.details.replaced, false);

    assert.equal(logLines(logPath).includes("exec:second"), true);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("forced stop reconciles ownerless metadata without starting or killing a process", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-force-observed-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const metaPath = writeOwnerlessRunningMeta(project);
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const result = await invoke(tools, "takt_stop", { profile: "pi-docs", forceObserved: true }, context);
    assert.equal(result.details.stopped, false);
    assert.deepEqual(result.details.reconciledRuns, ["stale-run"]);
    const saved = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(saved.status, "aborted");
    assert.deepEqual(saved.resume_point, { iteration: 15 });
    assert.equal(logLines(logPath).some((line) => line.startsWith("signal:")), false);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("extension rejects exec when task metadata reports an external live session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-external-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  const metaPath = writeOwnerlessRunningMeta(project, "external-live-run", process.pid);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "external");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const observed = await invoke(tools, "takt_read_screen", { rows: 4 }, context);
    assert.equal(observed.details.status, "live");
    assert.equal(observed.details.stage, "external-stage");
    assert.equal(observed.details.pid, process.pid);

    const stopResult = await invoke(tools, "takt_stop", {
      profile: "pi-docs",
      forceObserved: true,
    }, context);
    assert.equal(stopResult.details.stopped, false);
    assert.equal(stopResult.details.cwd, project);
    assert.deepEqual(stopResult.details.reconciledRuns, []);
    assert.equal(JSON.parse(readFileSync(metaPath, "utf8")).status, "running");

    await assert.rejects(
      () => invoke(tools, "takt_exec_prompt", {
        profile: "pi-docs",
        prompt: "must not start",
        clear: false,
        preset: "blocked",
      }, context),
      /external live session/,
    );
    assert.equal(logLines(logPath).some((line) => line.startsWith("exec:")), false);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("background status refresh does not invoke a broken task list", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-background-refresh-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none", "fail");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const result = await invoke(tools, "takt_set_mode", { mode: "pi" }, context);
    assert.equal(result.details.mode, "pi");

    await new Promise((resolve) => setTimeout(resolve, 2_200));
    assert.equal(
      context.notifications.some((notification) => notification.message.includes("status refresh failed")),
      false,
    );
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("external screen reads stay available when the task list is locked", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-screen-refresh-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none", "fail");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const result = await invoke(tools, "takt_read_screen", { rows: 4 }, context);
    assert.equal(result.details.status, "unknown");
    assert.equal(result.details.running, false);
    assert.equal(
      context.notifications.some((notification) => notification.message.includes("task list failed")),
      false,
    );
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("initial status refresh failure does not reject extension startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-initial-refresh-failure-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  mkdirSync(join(project, ".takt"), { recursive: true });
  writeFileSync(join(project, ".takt", "runs"), "not a directory", "utf8");
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    const result = await invoke(tools, "takt_set_mode", { mode: "pi" }, context);
    assert.equal(result.details.mode, "pi");
    assert.equal(
      context.notifications.filter((notification) => notification.message.includes("status refresh failed")).length,
      1,
    );
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});

test("repeated background refresh failures use one warning and an xN status count", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-bridge-refresh-count-"));
  const project = join(root, "project");
  mkdirSync(project);
  const logPath = join(root, "events.log");
  const command = createTaktCommand(root);
  writeProfile(root, project);
  const restoreEnvironment = configureEnvironment(root, command, logPath, "none");
  const { tools, events } = loadExtension();
  const context = createContext(project);

  try {
    await invoke(tools, "takt_set_mode", { mode: "pi" }, context);
    mkdirSync(join(project, ".takt"), { recursive: true });
    writeFileSync(join(project, ".takt", "runs"), "not a directory", "utf8");

    await new Promise((resolve) => setTimeout(resolve, 4_200));
    const refreshStatuses = context.statuses.filter((status) => status.key === "pi-takt-marionette-refresh-error");
    const refreshWarnings = context.notifications.filter((notification) => notification.message.includes("status refresh failed"));
    assert.match(refreshStatuses.at(-1)?.value ?? "", /\(x2\):/);
    assert.equal(refreshWarnings.length, 1);
  } finally {
    await events.get("session_shutdown")?.({ reason: "quit" }, context);
    restoreEnvironment();
  }
});
