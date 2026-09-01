import assert from "node:assert/strict";
import test from "node:test";

const xterm = await import("@xterm/headless");
const { TaktFullscreenFocusView, orderTaktFocusSessions, isCtrlAltArrowSequence } =
  await import("../lib/takt-focus-view.ts");
const Terminal = xterm.default?.Terminal ?? xterm.Terminal;

const ESC = "\u001b";
const CTRL_C = "\u0003";
const PASTE = `${ESC}[200~typed lines${ESC}[201~\r`;
const CTRL_ALT_T = `${ESC}\u0014`;
const F6 = `${ESC}[17~`;
const CTRL_ALT_UP = `${ESC}[1;7A`;
const CTRL_ALT_DOWN = `${ESC}[1;7B`;

function createTerminal(lines, options = {}) {
  const terminal = new Terminal({
    cols: options.cols ?? 40,
    rows: options.rows ?? 6,
    scrollback: 500,
    allowProposedApi: true,
  });
  if (lines) {
    terminal.writeSync?.(lines);
    // headless write is async; flush via callback
  }
  return terminal;
}

async function writeLines(terminal, text) {
  await new Promise((resolve) => terminal.write(text, resolve));
}

function createFakeSession(options = {}) {
  const state = { running: true };
  const listeners = new Set();
  const session = {
    id: options.id ?? "s1",
    label: options.label ?? "proj-1",
    cwd: options.cwd ?? "C:/proj-1",
    inputMode: "takt",
    writes: [],
    resizes: [],
    state,
    listeners,
    terminal: options.terminal,
    isRunning() {
      return state.running;
    },
    write(data) {
      session.writes.push(data);
    },
    resize(columns, rows) {
      session.resizes.push([columns, rows]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitOutput() {
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
  return session;
}

function createView(sessions, options = {}) {
  const recorded = {
    exits: [],
    notifications: [],
    modeCycles: 0,
    renders: 0,
  };
  const view = new TaktFullscreenFocusView({
    sessions,
    initialSessionId: options.initialSessionId,
    refreshIntervalMs: options.refreshIntervalMs ?? 15,
    callbacks: {
      onExit(result) {
        recorded.exits.push(result);
      },
      onModeCycle() {
        recorded.modeCycles += 1;
      },
      notify(message, level) {
        recorded.notifications.push({ message, level });
      },
      requestRender() {
        recorded.renders += 1;
      },
    },
  });
  return { view, recorded };
}

test("pinned header keeps other-session count visible with long cwd paths", () => {
  const longCwd = "C:\\Users\\Keisu\\AppData\\Local\\Temp\\pi-takt-focus-a-RPD8MJ\\sessions\\alpha-project-with-a-deliberately-long-name";
  const alpha = createFakeSession({ id: "a", label: "alpha", cwd: longCwd });
  const beta = createFakeSession({ id: "b", label: "beta", cwd: "C:/beta" });
  const { view } = createView([alpha, beta], { initialSessionId: "a" });

  view.handleInput("\r");
  const flat = view.render(120, 24).join("\n");
  assert.match(flat, /\+1 other running/);
  assert.match(flat, /alpha/);
  assert.match(flat, /…/);
  assert.match(flat, /input: takt/);
  for (const line of view.render(120, 24)) {
    assert.ok(line.length <= 120, `line too wide: ${line}`);
  }
});

test("single eligible running session pins automatically and renders header plus viewport", async () => {
  const terminal = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true });
  await writeLines(terminal, "latest reply from takt");
  const session = createFakeSession({ id: "only", label: "repo-a", cwd: "C:/repo-a", terminal });
  const { view, recorded } = createView([session]);

  assert.equal(view.currentPhase, "pinned");
  assert.equal(view.pinnedId, "only");

  const lines = view.render(120, 24);
  const flat = lines.join("\n");
  assert.match(flat, /repo-a/);
  assert.match(flat, /C:\/repo-a/);
  assert.match(flat, /TAKT/i);
  assert.match(flat, /\+0 others running/);
  assert.ok(lines.some((line) => line.includes("latest reply from takt")), flat);
  // Width invariant: every line fits the requested width.
  for (const line of lines) {
    assert.ok(line.length <= 120, `line too wide: ${line}`);
  }
  assert.equal(recorded.exits.length, 0);
  terminal.dispose();
});

test("ordinary text, paste, Enter, and Ctrl+C reach only the pinned runner unchanged", () => {
  const session = createFakeSession({});
  const { view } = createView([session]);

  view.handleInput("h");
  view.handleInput(PASTE);
  view.handleInput("\r");
  view.handleInput(`${ESC}[A`);
  view.handleInput(CTRL_C);

  assert.deepEqual(session.writes, ["h", PASTE, "\r", `${ESC}[A`, CTRL_C]);
});

test("Esc closes focused mode without reaching TAKT and reports a single exit", () => {
  const session = createFakeSession({});
  const { view, recorded } = createView([session]);

  view.handleInput(ESC);

  assert.equal(view.currentPhase, "closed");
  assert.equal(session.writes.length, 0);
  assert.equal(recorded.exits.length, 1);
  assert.equal(recorded.exits[0].reason, "user-escape");
  assert.equal(recorded.exits[0].session.id, "s1");

  // Repeated close stays idempotent.
  view.close("external-close");
  assert.equal(recorded.exits.length, 1);
});

test("Ctrl+Alt+T cycles modes and is never forwarded", () => {
  const session = createFakeSession({});
  const { view, recorded } = createView([session]);

  view.handleInput(CTRL_ALT_T);

  assert.equal(recorded.modeCycles, 1);
  assert.deepEqual(session.writes, []);
  assert.equal(view.currentPhase, "pinned");
});

test("F6 cycles modes while fullscreen focus owns input and is never forwarded", () => {
  const session = createFakeSession({});
  const { view, recorded } = createView([session]);

  view.handleInput(F6);

  assert.equal(recorded.modeCycles, 1);
  assert.deepEqual(session.writes, []);
  assert.equal(view.currentPhase, "pinned");
});

test("focused dimensions resize the pinned PTY and follow terminal changes", () => {
  const session = createFakeSession({});
  const { view } = createView([session]);

  view.render(80, 24);
  assert.deepEqual(session.resizes.at(-1), [80, 22]);
  view.render(80, 24);
  assert.equal(session.resizes.length, 1);
  view.render(100, 30);
  assert.deepEqual(session.resizes.at(-1), [100, 28]);
});

test("pinned runner exit closes once, clears subscriptions, and never re-pins", async () => {
  const first = createFakeSession({ id: "a", label: "alpha" });
  const second = createFakeSession({ id: "b", label: "beta" });
  const { view, recorded } = createView([first, second], { initialSessionId: "a" });

  // Selection phase with two sessions; pin alpha explicitly.
  assert.equal(view.currentPhase, "select");
  view.handleInput("\r");
  assert.equal(view.pinnedId, "a");

  first.state.running = false;
  first.emitOutput();

  assert.equal(view.currentPhase, "closed");
  assert.equal(recorded.exits.length, 1);
  assert.equal(recorded.exits[0].reason, "runner-ended");
  assert.equal(recorded.exits[0].session.id, "a");

  // Input after close is ignored; no byte can leak to another session.
  view.handleInput("leak");
  assert.deepEqual(second.writes, []);
  assert.equal(view.pinnedId, undefined);
});

test("refresh tick detects runner exit without an output event", async () => {
  const session = createFakeSession({});
  const { view, recorded } = createView([session], { refreshIntervalMs: 15 });

  session.state.running = false;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(view.currentPhase, "closed");
  assert.equal(recorded.exits.length, 1);
  assert.equal(recorded.exits[0].reason, "runner-ended");
});

test("live output requests renders through the subscription", () => {
  const session = createFakeSession({});
  const { view, recorded } = createView([session]);

  const before = recorded.renders;
  session.emitOutput();
  assert.ok(recorded.renders > before);
});

test("multiple sessions require explicit selection before any PTY receives input", () => {
  const alpha = createFakeSession({ id: "a", label: "alpha" });
  const beta = createFakeSession({ id: "b", label: "beta" });
  const { view } = createView([alpha, beta], { initialSessionId: "b" });

  assert.equal(view.currentPhase, "select");
  assert.equal(view.pinnedId, undefined);

  // Typing during selection must not reach any PTY.
  view.handleInput("abc");
  view.handleInput("\u0007");
  assert.deepEqual(alpha.writes, []);
  assert.deepEqual(beta.writes, []);

  const lines = view.render(80, 20).join("\n");
  assert.match(lines, /alpha/);
  assert.match(lines, /beta/);
  // Current cwd highlighted initially but not silently accepted.
  assert.match(lines, /current/);
  assert.equal(view.pinnedId, undefined);

  view.handleInput("\r");
  assert.equal(view.currentPhase, "pinned");
  assert.equal(view.pinnedId, "b"); // cursor started on current cwd
});

test("selection cursor moves with arrows and Enter pins the chosen session", () => {
  const alpha = createFakeSession({ id: "a", label: "alpha" });
  const beta = createFakeSession({ id: "b", label: "beta" });
  const gamma = createFakeSession({ id: "c", label: "gamma" });
  const { view } = createView([alpha, beta, gamma]);

  view.handleInput(`${ESC}[B`); // down
  view.handleInput("\r");
  assert.equal(view.pinnedId, "b");

  view.handleInput("ping");
  assert.deepEqual(beta.writes, ["ping"]);
  assert.deepEqual(alpha.writes, []);
  assert.deepEqual(gamma.writes, []);
});

test("Ctrl+Alt+Up/Down navigate deterministically with wraparound and emit switch notifications", () => {
  const sessions = [
    createFakeSession({ id: "c", label: "gamma", cwd: "C:/g" }),
    createFakeSession({ id: "a", label: "alpha", cwd: "C:/a" }),
    createFakeSession({ id: "b", label: "beta", cwd: "C:/b" }),
  ];
  const { view, recorded } = createView(sessions);
  // Deterministic shared ordering: alpha, beta, gamma.
  view.handleInput("\r"); // pins alpha
  assert.equal(view.pinnedId, "a");

  view.handleInput(CTRL_ALT_DOWN); // beta
  assert.equal(view.pinnedId, "b");
  view.handleInput(CTRL_ALT_DOWN); // gamma
  assert.equal(view.pinnedId, "c");
  view.handleInput(CTRL_ALT_DOWN); // wraps to alpha
  assert.equal(view.pinnedId, "a");
  view.handleInput(CTRL_ALT_UP); // wraps back to gamma
  assert.equal(view.pinnedId, "c");

  const switches = recorded.notifications.filter((entry) => entry.message.includes("→"));
  assert.equal(switches.length, 4);
  assert.match(switches[0].message, /alpha → beta/);
  assert.match(switches[3].message, /alpha → gamma/);
});

test("navigation shortcuts are consumed and never forwarded to old or new PTY", () => {
  const alpha = createFakeSession({ id: "a", label: "alpha" });
  const beta = createFakeSession({ id: "b", label: "beta" });
  const { view } = createView([alpha, beta]);
  view.handleInput("\r"); // pin alpha

  view.handleInput(CTRL_ALT_UP);
  view.handleInput(CTRL_ALT_DOWN);
  view.handleInput(CTRL_ALT_UP);

  assert.deepEqual(alpha.writes, []);
  assert.deepEqual(beta.writes, []);
  assert.equal(view.pinnedId, "beta".startsWith("beta") ? "b" : view.pinnedId);
});

test("switchTarget updates identity atomically: next byte reaches only the new runner", () => {
  const alpha = createFakeSession({ id: "a", label: "alpha" });
  const beta = createFakeSession({ id: "b", label: "beta" });
  const gamma = createFakeSession({ id: "c", label: "gamma" });
  const { view } = createView([alpha, beta, gamma]);
  view.handleInput("\r"); // pin alpha
  assert.equal(view.switchTarget(1), true); // → beta

  view.handleInput("X");
  assert.deepEqual(beta.writes, ["X"]);
  assert.deepEqual(alpha.writes, []);
  assert.deepEqual(gamma.writes, []);
});

test("command fallback uses identical ordering and transition as shortcuts", () => {
  const sessions = [
    createFakeSession({ id: "c", label: "gamma" }),
    createFakeSession({ id: "a", label: "alpha" }),
    createFakeSession({ id: "b", label: "beta" }),
  ];
  const { view, recorded } = createView(sessions);
  view.handleInput("\r"); // pin alpha (first in deterministic order)
  assert.equal(view.switchTarget(-1), true);
  assert.equal(view.pinnedId, "c"); // wrap to end of ordered list
  const viaCommand = view.switchTarget(1);
  assert.equal(viaCommand, true);
  assert.equal(view.pinnedId, "a");
  assert.ok(recorded.notifications.some((entry) => entry.message.includes("gamma → alpha")));
});

test("rapid navigation, stop-during-switch, and duplicate closes stay safe", async () => {
  const pool = [
    createFakeSession({ id: "a", label: "alpha" }),
    createFakeSession({ id: "b", label: "beta" }),
    createFakeSession({ id: "c", label: "gamma" }),
  ];
  const { view, recorded } = createView(pool);
  view.handleInput("\r");

  // Rapid repeated navigation.
  for (let i = 0; i < 12; i += 1) {
    view.handleInput(i % 2 === 0 ? CTRL_ALT_DOWN : CTRL_ALT_UP);
  }
  assert.ok(["a", "b", "c"].includes(view.pinnedId));

  // Stop-during-switch: pinned dies right as navigation lands elsewhere.
  const dying = view.pinnedId;
  pool.find((session) => session.id === dying).state.running = false;
  view.switchTarget(1);
  assert.equal(view.currentPhase, "closed");
  assert.equal(recorded.exits.length, 1);
  assert.equal(recorded.exits[0].reason, "runner-ended");

  view.close("external-close");
  view.close("user-escape");
  assert.equal(recorded.exits.length, 1);
});

test("all candidates dying during selection closes without pinning anything", async () => {
  const alpha = createFakeSession({ id: "a", label: "alpha" });
  const beta = createFakeSession({ id: "b", label: "beta" });
  const { view, recorded } = createView([alpha, beta], { refreshIntervalMs: 15 });

  alpha.state.running = false;
  beta.state.running = false;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(view.currentPhase, "closed");
  assert.equal(recorded.exits.length, 1);
  assert.equal(recorded.exits[0].reason, "runner-ended");
  assert.equal(recorded.exits[0].session, undefined);
});

test("orderTaktFocusSessions is stable and shared by selector and navigation", () => {
  const ordered = orderTaktFocusSessions([
    { id: "z", label: "zeta", cwd: "C:/z" },
    { id: "m", label: "alpha", cwd: "C:/m2" },
    { id: "a", label: "alpha", cwd: "C:/m10" },
    { id: "k", label: "kappa", cwd: "C:/k" },
  ]);
  assert.deepEqual(ordered.map((session) => session.id), ["a", "m", "k", "z"]);
});

test("isCtrlAltArrowSequence matches legacy and kitty encodings but not plain arrows", () => {
  assert.equal(isCtrlAltArrowSequence("\u001b[1;7A", "up"), true);
  assert.equal(isCtrlAltArrowSequence("\u001b[1;7B", "down"), true);
  assert.equal(isCtrlAltArrowSequence("\u001b[A", "up"), false);
  assert.equal(isCtrlAltArrowSequence("\u001b[B", "down"), false);
  assert.equal(isCtrlAltArrowSequence("\u001b[1;5A", "up"), false); // ctrl+up
});
