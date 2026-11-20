import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaktKeyboardAdapter,
  getTaktModeCompatibilityShortcutLabel,
  getTaktModeShortcutLabel,
  isCtrlAltTSequence,
  isF6Sequence,
  isTaktModeCycleSequence,
  normalizeTaktKeyboardPlatform,
} from "../lib/takt-keyboard.ts";

const ESC = "\u001b";

test("normalizeTaktKeyboardPlatform recognizes macOS and Windows only", () => {
  assert.equal(normalizeTaktKeyboardPlatform("darwin"), "darwin");
  assert.equal(normalizeTaktKeyboardPlatform("win32"), "win32");
  assert.equal(normalizeTaktKeyboardPlatform("linux"), "other");
  assert.equal(normalizeTaktKeyboardPlatform("freebsd"), "other");
});

test("shortcut labels reflect the normalized platform", () => {
  assert.equal(getTaktModeShortcutLabel("darwin"), "F6 / Fn+F6");
  assert.equal(getTaktModeShortcutLabel("win32"), "F6");
  assert.equal(getTaktModeShortcutLabel("linux"), "F6");

  assert.equal(getTaktModeCompatibilityShortcutLabel("darwin"), "Ctrl+Option+T");
  assert.equal(getTaktModeCompatibilityShortcutLabel("win32"), "Ctrl+Alt+T");
  assert.equal(getTaktModeCompatibilityShortcutLabel("linux"), "Ctrl+Alt+T");
});

test("isCtrlAltTSequence recognizes the observed terminal encodings only", () => {
  assert.equal(isCtrlAltTSequence(`${ESC}\u0014`), true);
  assert.equal(isCtrlAltTSequence(`${ESC}[27;7;116~`), true);
  assert.equal(isCtrlAltTSequence(`${ESC}[116;7u`), true);

  assert.equal(isCtrlAltTSequence(`${ESC}[27;7t`), false);
  assert.equal(isCtrlAltTSequence(`${ESC}[20;7u`), false);
  assert.equal(isCtrlAltTSequence(`${ESC}[B`), false);
  assert.equal(isCtrlAltTSequence("x"), false);
});

test("isF6Sequence accepts legacy and modifier-bearing encodings", () => {
  assert.equal(isF6Sequence(`${ESC}[17~`), true);
  assert.equal(isF6Sequence(`${ESC}[17;1~`), true);
  assert.equal(isF6Sequence(`${ESC}[17;1u`), true);

  assert.equal(isF6Sequence(`${ESC}[17;2~`), false);
  assert.equal(isF6Sequence(`${ESC}[18~`), false);
  assert.equal(isF6Sequence(`${ESC}[B`), false);
  assert.equal(isF6Sequence("x"), false);
});

test("keyboard adapter matches mode-cycle shortcuts and rejects unrelated input", () => {
  const adapter = createTaktKeyboardAdapter("win32");

  for (const sequence of [
    `${ESC}[17~`,
    `${ESC}[17;1~`,
    `${ESC}[17;1u`,
    `${ESC}\u0014`,
    `${ESC}[27;7;116~`,
    `${ESC}[116;7u`,
  ]) {
    assert.equal(adapter.match(sequence), "cycle-input-mode", JSON.stringify(sequence));
  }

  for (const sequence of ["", "x", `${ESC}[B`, `${ESC}[27;7t`]) {
    assert.equal(adapter.match(sequence), undefined, JSON.stringify(sequence));
  }
});

test("isTaktModeCycleSequence delegates to the platform keyboard adapter", () => {
  assert.equal(isTaktModeCycleSequence(`${ESC}[17~`, "darwin"), true);
  assert.equal(isTaktModeCycleSequence(`${ESC}[116;7u`, "win32"), true);
  assert.equal(isTaktModeCycleSequence(`${ESC}[B`, "linux"), false);
});
