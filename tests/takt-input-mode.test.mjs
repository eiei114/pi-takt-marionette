import assert from "node:assert/strict";
import test from "node:test";
import {
  cycleTaktInputMode,
  formatTaktInputModeLine,
  isDestructiveTaktAutoInput,
  isTaktModeCycleSequence,
  parseTaktInputMode,
} from "../lib/takt-input-mode.ts";
import {
  createTaktKeyboardAdapter,
  getTaktModeCompatibilityShortcutLabel,
  getTaktModeShortcutLabel,
} from "../lib/takt-keyboard.ts";

test("cycleTaktInputMode rotates pi → takt → pi-auto → pi", () => {
  assert.equal(cycleTaktInputMode("pi"), "takt");
  assert.equal(cycleTaktInputMode("takt"), "pi-auto");
  assert.equal(cycleTaktInputMode("pi-auto"), "pi");
});

test("parseTaktInputMode accepts mode names and cycle aliases", () => {
  assert.equal(parseTaktInputMode(""), "cycle");
  assert.equal(parseTaktInputMode("next"), "cycle");
  assert.equal(parseTaktInputMode("pi-auto"), "pi-auto");
  assert.equal(parseTaktInputMode("nope"), undefined);
});

test("formatTaktInputModeLine states where keys go in plain words", () => {
  assert.match(formatTaktInputModeLine("pi"), /typing in Pi/);
  assert.match(formatTaktInputModeLine("takt"), /typing into TAKT/);
  assert.match(formatTaktInputModeLine("pi-auto"), /Autopilot/);
});

test("isDestructiveTaktAutoInput gates clear/stop style follow-ups", () => {
  assert.equal(isDestructiveTaktAutoInput("/go"), false);
  assert.equal(isDestructiveTaktAutoInput("looks good, continue"), false);
  assert.equal(isDestructiveTaktAutoInput("/clear"), true);
  assert.equal(isDestructiveTaktAutoInput("please takt clear"), true);
  assert.equal(isDestructiveTaktAutoInput("abort\u0003"), true);
});

test("isCtrlAltTSequence recognises raw shortcut encodings and rejects other bytes", async () => {
  const { isCtrlAltTSequence } = await import("../lib/takt-input-mode.ts");
  assert.equal(isCtrlAltTSequence("\u001b\u0014"), true); // ESC + Ctrl+T
  assert.equal(isCtrlAltTSequence("\u001b[27;7;116~"), true); // modifyOtherKeys
  assert.equal(isCtrlAltTSequence("\u001b[116;7u"), true); // Kitty CSI-u
  assert.equal(isCtrlAltTSequence("\u001b[27;7t"), false); // truncated modifyOtherKeys
  assert.equal(isCtrlAltTSequence("\u001b[20;7u"), false); // wrong Kitty codepoint
  assert.equal(isCtrlAltTSequence("\u001b[B"), false); // plain down arrow
  assert.equal(isCtrlAltTSequence("x"), false);
});

test("isTaktModeCycleSequence recognises the portable F6 terminal sequence", () => {
  assert.equal(isTaktModeCycleSequence("\u001b[17~"), true);
  assert.equal(isTaktModeCycleSequence("\u001b[17;1~", "darwin"), true);
  assert.equal(isTaktModeCycleSequence("\u001b[17;1u", "darwin"), true);
  assert.equal(isTaktModeCycleSequence("\u001b[B"), false);
});

test("session history expires quiet finished activity after three days", async () => {
  const { isTaktSessionHistoryVisible } = await import("../lib/takt-types.ts");
  const now = Date.parse("2026-09-01T00:00:00.000Z");
  const finished = {
    cwd: "/repo",
    status: "completed",
    running: 0,
    pending: 0,
    blocked: 0,
    failed: 0,
    completed: 1,
    stale: 0,
    activityAt: "2026-08-30T23:59:59.000Z",
    runs: [],
  };
  assert.equal(isTaktSessionHistoryVisible(finished, now), true);
  assert.equal(isTaktSessionHistoryVisible(finished, now + 2 * 86_400_000), false);
  assert.equal(isTaktSessionHistoryVisible({ ...finished, running: 1 }, now + 10 * 86_400_000), true);
  assert.equal(isTaktSessionHistoryVisible({ ...finished, pending: 1 }, now + 10 * 86_400_000), true);
});

test("keyboard adapter keeps Windows behavior and gives macOS a clear F6 hint", () => {
  const windows = createTaktKeyboardAdapter("win32");
  const macos = createTaktKeyboardAdapter("darwin");

  assert.equal(getTaktModeShortcutLabel("win32"), "F6");
  assert.equal(getTaktModeCompatibilityShortcutLabel("win32"), "Ctrl+Alt+T");
  assert.equal(getTaktModeShortcutLabel("darwin"), "F6 / Fn+F6");
  assert.equal(getTaktModeCompatibilityShortcutLabel("darwin"), "Ctrl+Option+T");
  assert.equal(windows.match("\u001b[17~"), "cycle-input-mode");
  assert.equal(macos.match("\u001b[17~"), "cycle-input-mode");
  assert.equal(macos.match("x"), undefined);
  assert.match(formatTaktInputModeLine("pi", "darwin"), /F6 \/ Fn\+F6/);
  assert.match(formatTaktInputModeLine("pi", "win32"), /cycle: F6/);
});
