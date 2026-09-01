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
import { basename, join } from "node:path";
import test from "node:test";
import register from "../extensions/index.ts";

const ESC = "\u001b";
const CTRL_ALT_T = `${ESC}\u0014`;
const CTRL_ALT_UP = `${ESC}[1;7A`;
const CTRL_ALT_DOWN = `${ESC}[1;7B`;

/** Fake TAKT CLI: per-project logs derived from cwd, plus a stay-alive run op. */
function createTaktCommand(directory) {
  const nodeScript = join(directory, "fake-takt.mjs");
  writeFileSync(nodeScript, [
    'import { appendFileSync } from "node:fs";',
    'import { join, basename } from "node:path";',
    'const dir = process.env.TEST_TAKT_LOG_DIR;',
    'const logPath = join(dir, `${basename(process.cwd())}.log`);',
    'const args = process.argv.slice(2);',
    'const operation = args.at(-1) === "resume" ? "resume" : args[0];',
    'const event = (value) => appendFileSync(logPath, `${value}\\n`);',
    'if (operation === "list") {',
    '  process.stdout.write(JSON.stringify({ tasks: [] }) + "\\n");',
    '  process.exit(0);',
    '} else if (operation === "clear") {',
    '  event("clear");',
    '  process.exit(0);',
    '} else if (operation === "resume") {',
    '  process.stdout.write("Select action:\\r\\n> Requeue\\r\\n  Cancel\\r\\n");',
    '  process.stdin.once("data", () => process.stdout.write("Resuming…\\r\\n"));',
    '  setInterval(() => {}, 1000);',
    '} else if (operation === "run") {',
    '  event("run-start");',
    '  process.stdout.write("Assistant>\\r\\n");',
    '  process.stdin.setEncoding("utf8");',
    '  process.stdin.on("data", (data) => {',
    '    if (data.includes("quit-now")) { event("run-exit"); process.exit(0); }',
    '    event(`in:${JSON.stringify(data)}`);',
    '  });',
    '  setInterval(() => {}, 1000);',
    '} else {',
    '  process.exit(2);',
    '}',
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

function configureEnvironment(root, command, logDir) {
  const previous = new Map([
    ["APPDATA", process.env.APPDATA],
    ["XDG_CONFIG_HOME", process.env.XDG_CONFIG_HOME],
    ["TAKT_CONFIG_DIR", process.env.TAKT_CONFIG_DIR],
    ["TAKT_COMMAND", process.env.TAKT_COMMAND],
    ["TEST_TAKT_LOG_DIR", process.env.TEST_TAKT_LOG_DIR],
    ["TEST_TASK_MODE", process.env.TEST_TASK_MODE],
    ["TEST_LIST_MODE", process.env.TEST_LIST_MODE],
    ["TEST_OWNER_PID", process.env.TEST_OWNER_PID],
  ]);
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.TAKT_CONFIG_DIR = root;
  process.env.TAKT_COMMAND = command;
  process.env.TEST_TAKT_LOG_DIR = logDir;
  delete process.env.TEST_TASK_MODE;
  delete process.env.TEST_LIST_MODE;
  delete process.env.TEST_OWNER_PID;
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

function writeProfiles(root, profiles) {
  const directory = join(root, "pi-takt-bridge");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "profiles.json"),
    JSON.stringify({ version: 1, profiles }),
    "utf8",
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(stepMs);
  }
  return predicate();
}

async function setupFocusHarness(projectA, projectB) {
  const root = mkdtempSync(join(tmpdir(), "pi-takt-focus-mode-"));
  mkdirSync(projectA, { recursive: true });
  if (projectB) {
    mkdirSync(projectB, { recursive: true });
  }
  const logDir = join(root, "logs");
  mkdirSync(logDir);
  const command = createTaktCommand(root);
  mkdirSync(join(root, "builtins", "en", "workflows"), { recursive: true });
  writeFileSync(join(root, "builtins", "en", "workflows", "default.yaml"), "name: default\nsteps: []\n", "utf8");
  const profiles = [{ name: "alpha", cwd: projectA, preset: "default" }];
  if (projectB) {
    profiles.push({ name: "beta", cwd: projectB, preset: "default" });
  }
  writeProfiles(root, profiles);
  const restoreEnvironment = configureEnvironment(root, command, logDir);

  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  register({
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerShortcut() {},
  });

  const notifications = [];
  const statuses = [];
  let activeCustom = null;
  let terminalInputHandler;
  let editorResponses = [];
  const fakeTui = {
    requestRender() {},
    terminal: { rows: 30, columns: 120 },
  };
  const themeStub = { fg: (_color, text) => text };
  const context = {
    cwd: projectA,
    mode: "tui",
    hasUI: true,
    notifications,
    statuses,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      },
      setWidget() {},
      onTerminalInput(handler) {
        terminalInputHandler = handler;
        return () => {
          if (terminalInputHandler === handler) {
            terminalInputHandler = undefined;
          }
        };
      },
      select: async (_title, choices) => choices[0],
      confirm: async () => true,
      input: async () => undefined,
      editor: async (title) => editorResponses.length > 0 ? editorResponses.shift() : "",
      custom(factory, options) {
        return new Promise((resolve) => {
          const done = (value) => {
            activeCustom = null;
            resolve(value);
          };
          const component = factory(fakeTui, themeStub, {}, done);
          activeCustom = { component, done, options };
        });
      },
    },
  };

  await events.get("session_start")({ reason: "startup" }, context);

  const readLog = (projectCwd) => {
    const path = join(logDir, `${basename(projectCwd)}.log`);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };

  return {
    root,
    tools,
    commands,
    events,
    context,
    notifications,
    statuses,
    readLog,
    getActiveCustom: () => activeCustom,
    sendTerminalInput(data) {
      return terminalInputHandler?.(data);
    },
    setActiveCustom(value) {
      activeCustom = value;
    },
    nextEditorResponse(text) {
      editorResponses.push(text);
    },
    async shutdown() {
      await events.get("session_shutdown")?.({ reason: "test" }, context);
      restoreEnvironment();
    },
    restoreEnvironment,
  };
}

async function invoke(tools, name, params, context) {
  return tools.get(name).execute("test-call", params, undefined, () => {}, context);
}

async function runCommand(commands, name, args, context) {
  await commands.get(name)?.handler(args ?? "", context);
}

test("two running sessions require explicit selection before any PTY receives input", async () => {
  const projectA = join(mkdtempSync(join(tmpdir(), "pi-takt-focus-a-")), "alpha");
  const projectB = join(mkdtempSync(join(tmpdir(), "pi-takt-focus-b-")), "beta");
  const harness = await setupFocusHarness(projectA, projectB);
  try {
    await runCommand(harness.commands, "takt:start", "alpha", harness.context);
    await runCommand(harness.commands, "takt:start", "beta", harness.context);
    assert.ok(await waitFor(() =>
      harness.readLog(projectA).includes("run-start") &&
      harness.readLog(projectB).includes("run-start")));

    await runCommand(harness.commands, "takt:mode", "takt", harness.context);
    assert.ok(await waitFor(() => harness.getActiveCustom() !== null));

    // Selection phase: typed bytes reach neither PTY.
    harness.getActiveCustom().component.handleInput("nope");
    await sleep(80);
    assert.ok(!harness.readLog(projectA).includes('"in:'));
    assert.ok(!harness.readLog(projectB).includes('"in:'));

    const lines = harness.getActiveCustom().component.render(120, 30).join("\n");
    assert.match(lines, /select a running session/);
    assert.match(lines, /current/);

    // Enter confirms the highlighted (current cwd = alpha) target.
    harness.getActiveCustom().component.handleInput("\r");
    harness.getActiveCustom().component.handleInput("hello\r");
    assert.ok(await waitFor(() => harness.readLog(projectA).includes("hello")));
    assert.ok(!harness.readLog(projectB).includes('"in:'));

    // Header identifies the pinned project plus the other running session.
    const focused = harness.getActiveCustom().component.render(120, 30).join("\n");
    assert.match(focused, /alpha/);
    assert.match(focused, /\+1 other running/);
  } finally {
    await harness.shutdown();
  }
});

test("Ctrl+Alt+Up/Down navigate atomically and match the /takt:session fallback", async () => {
  const projectA = join(mkdtempSync(join(tmpdir(), "pi-takt-nav-a-")), "alpha");
  const projectB = join(mkdtempSync(join(tmpdir(), "pi-takt-nav-b-")), "beta");
  const harness = await setupFocusHarness(projectA, projectB);
  try {
    await runCommand(harness.commands, "takt:start", "alpha", harness.context);
    await runCommand(harness.commands, "takt:start", "beta", harness.context);
    assert.ok(await waitFor(() =>
      harness.readLog(projectA).includes("run-start") &&
      harness.readLog(projectB).includes("run-start")));

    await runCommand(harness.commands, "takt:mode", "takt", harness.context);
    assert.ok(await waitFor(() => harness.getActiveCustom() !== null));
    harness.getActiveCustom().component.handleInput("\r"); // pin alpha

    // Next: atomic switch, then the byte lands only in beta.
    harness.getActiveCustom().component.handleInput(CTRL_ALT_DOWN);
    harness.getActiveCustom().component.handleInput("to-beta\r");
    assert.ok(await waitFor(() => harness.readLog(projectB).includes("to-beta")));
    assert.ok(!harness.readLog(projectA).includes("to-beta"));
    assert.ok(harness.notifications.some((entry) => entry.message.includes("alpha → beta")));

    // Command fallback shares ordering/transition with the shortcut.
    await runCommand(harness.commands, "takt:session", "previous", harness.context);
    harness.getActiveCustom().component.handleInput("to-alpha\r");
    assert.ok(await waitFor(() => harness.readLog(projectA).includes("to-alpha")));
    assert.ok(!harness.readLog(projectB).includes("to-alpha"));

    // Wraparound: previous from the first ordered session wraps to the end.
    await runCommand(harness.commands, "takt:session", "next", harness.context); // alpha → beta
    harness.getActiveCustom().component.handleInput(CTRL_ALT_DOWN); // beta → wraps to alpha
    harness.getActiveCustom().component.handleInput(CTRL_ALT_UP); // alpha → wraps to beta
    harness.getActiveCustom().component.handleInput("wrapped\r");
    assert.ok(await waitFor(() => harness.readLog(projectB).includes("wrapped")));
    assert.ok(!harness.readLog(projectA).includes("wrapped"));

    // Navigation shortcuts never leak bytes to either PTY.
    const shortcutsOnly = CTRL_ALT_UP + CTRL_ALT_DOWN;
    assert.ok(!harness.readLog(projectA).includes(JSON.stringify(shortcutsOnly.slice(0, 6))));
  } finally {
    await harness.shutdown();
  }
});

test("Esc leaves fullscreen focus and returns to PI without forwarding", async () => {
  const projectA = join(mkdtempSync(join(tmpdir(), "pi-takt-esc-a-")), "proj");
  const harness = await setupFocusHarness(projectA, undefined);
  try {
    await runCommand(harness.commands, "takt:start", "alpha", harness.context);
    assert.ok(await waitFor(() => harness.readLog(projectA).includes("run-start")));

    await runCommand(harness.commands, "takt:mode", "takt", harness.context);
    assert.ok(await waitFor(() => harness.getActiveCustom() !== null));
    // Single eligible session pins automatically.
    harness.getActiveCustom().component.handleInput("direct\r");
    assert.ok(await waitFor(() => harness.readLog(projectA).includes("direct")));

    harness.getActiveCustom().component.handleInput("\u001b");
    assert.ok(await waitFor(() => harness.getActiveCustom() === null));
    assert.ok(harness.notifications.some((entry) => entry.message.includes("Left TAKT focus")));
    assert.ok(harness.statuses.some((entry) => entry.key.includes("input-mode") && entry.value === undefined));
  } finally {
    await harness.shutdown();
  }
});

test("raw macOS Ctrl+Option+T input cycles mode before the Pi editor", async () => {
  const projectA = join(mkdtempSync(join(tmpdir(), "pi-takt-shortcut-a-")), "alpha");
  const harness = await setupFocusHarness(projectA, undefined);
  try {
    await runCommand(harness.commands, "takt:start", "alpha", harness.context);
    assert.ok(await waitFor(() => harness.readLog(projectA).includes("run-start")));

    // macOS terminals can emit ESC + Ctrl-T; Pi's registered shortcut matcher
    // does not see this legacy raw sequence in kitty-compatible mode.
    assert.deepEqual(harness.sendTerminalInput(CTRL_ALT_T), { consume: true });
    assert.ok(await waitFor(() => harness.getActiveCustom() !== null));

    // The same boundary listener cycles back and consumes the sequence while
    // the fullscreen view owns focus too.
    assert.deepEqual(harness.sendTerminalInput(CTRL_ALT_T), { consume: true });
    assert.ok(await waitFor(() => harness.getActiveCustom() === null));
    assert.equal(harness.sendTerminalInput("x"), undefined);
  } finally {
    await harness.shutdown();
  }
});

test("pinned runner exit closes focus, returns to PI, and reports remaining sessions", async () => {
  const projectA = join(mkdtempSync(join(tmpdir(), "pi-takt-exit-a-")), "alpha");
  const projectB = join(mkdtempSync(join(tmpdir(), "pi-takt-exit-b-")), "beta");
  const harness = await setupFocusHarness(projectA, projectB);
  try {
    await runCommand(harness.commands, "takt:start", "alpha", harness.context);
    await runCommand(harness.commands, "takt:start", "beta", harness.context);
    assert.ok(await waitFor(() =>
      harness.readLog(projectA).includes("run-start") &&
      harness.readLog(projectB).includes("run-start")));

    await runCommand(harness.commands, "takt:mode", "takt", harness.context);
    assert.ok(await waitFor(() => harness.getActiveCustom() !== null));
    harness.getActiveCustom().component.handleInput("\r");

    // Kill the pinned runner through its own control sequence contract.
    harness.getActiveCustom().component.handleInput("quit-now\r");
    assert.ok(await waitFor(() => harness.readLog(projectA).includes("run-exit")));
    assert.ok(await waitFor(() => harness.getActiveCustom() === null));
    assert.ok(harness.notifications.some((entry) =>
      entry.message.includes("finished") && entry.message.includes("other session")));
    // Mode returned to PI: status line cleared.
    assert.ok(await waitFor(() =>
      harness.statuses.some((entry) => entry.key.includes("input-mode") && entry.value === undefined)));
  } finally {
    await harness.shutdown();
  }
});

test("rapid repeated mode entries open at most one focused view instance", async () => {
  const projectA = join(mkdtempSync(join(tmpdir(), "pi-takt-race-a-")), "alpha");
  const projectB = join(mkdtempSync(join(tmpdir(), "pi-takt-race-b-")), "beta");
  const harness = await setupFocusHarness(projectA, projectB);
  let customOpenings = 0;
  const originalCustom = harness.context.ui.custom.bind(harness.context.ui);
  harness.context.ui.custom = (factory, options) => {
    customOpenings += 1;
    return originalCustom(factory, options);
  };
  try {
    await runCommand(harness.commands, "takt:start", "alpha", harness.context);
    await runCommand(harness.commands, "takt:start", "beta", harness.context);
    assert.ok(await waitFor(() =>
      harness.readLog(projectA).includes("run-start") &&
      harness.readLog(projectB).includes("run-start")));

    // Fire three overlapping mode switches without awaiting between them.
    await Promise.all([
      runCommand(harness.commands, "takt:mode", "takt", harness.context),
      runCommand(harness.commands, "takt:mode", "takt", harness.context),
      runCommand(harness.commands, "takt:mode", "takt", harness.context),
    ]);

    assert.ok(customOpenings <= 1, `expected one focused view, saw ${customOpenings}`);
    assert.ok(harness.getActiveCustom() !== null);

    // Cycling away closes the single view cleanly.
    await runCommand(harness.commands, "takt:mode", "pi", harness.context);
    assert.ok(await waitFor(() => harness.getActiveCustom() === null));
  } finally {
    await harness.shutdown();
  }
});

test("external state-card-only sessions are excluded from focus eligibility", async () => {
  const projectA = join(mkdtempSync(join(tmpdir(), "pi-takt-ext-a-")), "proj");
  const root = mkdtempSync(join(tmpdir(), "pi-takt-focus-ext-"));
  mkdirSync(projectA, { recursive: true });
  const logDir = join(root, "logs");
  mkdirSync(logDir);
  const command = createTaktCommand(root);
  writeProfiles(root, [{ name: "alpha", cwd: projectA, preset: "default" }]);
  const previousTaskMode = process.env.TEST_TASK_MODE;
  const restoreEnvironment = configureEnvironment(root, command, logDir);
  process.env.TEST_TASK_MODE = "external";
  process.env.TEST_OWNER_PID = "999999999";

  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  register({
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerShortcut() {},
  });

  const notifications = [];
  let customCalls = 0;
  const context = {
    cwd: projectA,
    mode: "tui",
    hasUI: true,
    notifications,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus() {},
      setWidget() {},
      onTerminalInput() {
        return () => {};
      },
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      editor: async () => "",
      custom: async () => {
        customCalls += 1;
        return undefined;
      },
    },
  };

  try {
    await events.get("session_start")({ reason: "startup" }, context);
    await runCommand(commands, "takt:mode", "takt", context);
    assert.ok(notifications.some((entry) =>
      entry.message.includes("Cannot enter takt mode")));
    assert.equal(customCalls, 0);
  } finally {
    await events.get("session_shutdown")?.({ reason: "test" }, context);
    restoreEnvironment();
    if (previousTaskMode === undefined) {
      delete process.env.TEST_TASK_MODE;
    } else {
      process.env.TEST_TASK_MODE = previousTaskMode;
    }
  }
});

test("queued programmatic input stays owned by its original project across focus switches", async () => {
  const projectA = join(mkdtempSync(join(tmpdir(), "pi-takt-q-a-")), "alpha");
  const projectB = join(mkdtempSync(join(tmpdir(), "pi-takt-q-b-")), "beta");
  const harness = await setupFocusHarness(projectA, projectB);
  try {
    await runCommand(harness.commands, "takt:start", "alpha", harness.context);
    await runCommand(harness.commands, "takt:start", "beta", harness.context);
    assert.ok(await waitFor(() =>
      harness.readLog(projectA).includes("run-start") &&
      harness.readLog(projectB).includes("run-start")));

    await runCommand(harness.commands, "takt:mode", "takt", harness.context);
    assert.ok(await waitFor(() => harness.getActiveCustom() !== null));
    harness.getActiveCustom().component.handleInput("\r"); // pin alpha

    // Programmatic send marks stage running ("/go" body) then a follow-up
    // line is queued because the session is mid-execution.
    harness.nextEditorResponse("/go build feature");
    await runCommand(harness.commands, "takt:send", "alpha", harness.context);
    assert.ok(await waitFor(() => harness.readLog(projectA).includes("build feature")));

    harness.nextEditorResponse("queued-for-alpha");
    await runCommand(harness.commands, "takt:send", "alpha", harness.context);
    await sleep(80);
    assert.ok(!harness.readLog(projectA).includes("queued-for-alpha"));

    // Switch focus to beta; the queued line must remain alpha-owned.
    harness.getActiveCustom().component.handleInput("\u001b[1;7B");
    harness.getActiveCustom().component.handleInput("typed-into-beta\r");
    assert.ok(await waitFor(() => harness.readLog(projectB).includes("typed-into-beta")));

    // Flush delivers the queued batch to its original project.
    await runCommand(harness.commands, "takt:flush", "alpha", harness.context);
    assert.ok(await waitFor(() => harness.readLog(projectA).includes("queued-for-alpha")));
    assert.ok(!harness.readLog(projectB).includes("queued-for-alpha"));
  } finally {
    await harness.shutdown();
  }
});
