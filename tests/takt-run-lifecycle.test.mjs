import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { terminalContainsText, TaktRunController } from "../lib/takt-run-controller.ts";

function createExitCommand(directory) {
  if (process.platform === "win32") {
    const command = join(directory, "natural-exit.cmd");
    writeFileSync(command, "@echo natural exit\r\n", "utf8");
    return command;
  }
  const command = join(directory, "natural-exit.sh");
  writeFileSync(command, "#!/bin/sh\nprintf 'natural exit\\n'\n", "utf8");
  chmodSync(command, 0o755);
  return command;
}

function createBlockingCommand(directory) {
  if (process.platform === "win32") {
    const command = join(directory, "blocking.cmd");
    writeFileSync(command, "@echo blocking\r\n@ping -n 20 127.0.0.1 >nul\r\n", "utf8");
    return command;
  }
  const command = join(directory, "blocking.sh");
  writeFileSync(command, "#!/bin/sh\nsleep 20\n", "utf8");
  chmodSync(command, 0o755);
  return command;
}

test("natural PTY exit reconciles to completed and remains disposable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-lifecycle-"));
  const controller = new TaktRunController({ cwd, command: createExitCommand(cwd), cols: 40, rows: 4 });

  try {
    await controller.start(["exec", "preset"]);
    const exit = await controller.waitForExit(5_000);

    assert.equal(exit?.code, 0);
    assert.equal(controller.isRunning, false);
    assert.equal(controller.hasSession, true);
    assert.equal(controller.status, "completed");
    assert.equal(typeof controller.pid, "number");
    assert.equal(controller.lastExit?.code, 0);
    assert.equal(controller.reconcile().status, "completed");
    await controller.stop();
    assert.equal(controller.status, "completed");

    await controller.dispose();
    assert.equal(controller.hasSession, false);
    assert.equal(controller.isRunning, false);
    assert.equal(controller.status, "completed");
    assert.equal(controller.lastExit?.code, 0);

    await controller.start(["exec", "next"]);
    const nextExit = await controller.waitForExit(5_000);
    assert.equal(nextExit?.code, 0);
    await controller.dispose();
    assert.equal(controller.status, "completed");
  } finally {
    if (controller.isRunning || controller.hasSession) {
      await controller.dispose();
    }
  }
});

test("malformed broker descriptor is removed before starting a replacement broker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-invalid-descriptor-"));
  const identity = typeof process.getuid === "function" ? String(process.getuid()) : userInfo().username;
  const runtimeDir = join(tmpdir(), `.pm-${createHash("sha256").update(identity).digest("hex").slice(0, 6)}`);
  const descriptorPath = join(runtimeDir, `${createHash("sha256").update(cwd).digest("hex").slice(0, 20)}.json`);
  const controller = new TaktRunController({ cwd, command: process.execPath, cols: 40, rows: 4 });

  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(descriptorPath, "{\"version\":1", "utf8");
  try {
    await controller.start(["-e", "process.exit(0)"]);
    assert.equal((await controller.waitForExit(5_000))?.code, 0);
  } finally {
    if (controller.isRunning || controller.hasSession) await controller.shutdown();
  }
});

test("waitForExit reports a bounded timeout and remains disposable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-timeout-"));
  const controller = new TaktRunController({ cwd, command: createBlockingCommand(cwd), cols: 40, rows: 4 });

  try {
    await controller.start(["exec", "blocking"]);
    await assert.rejects(
      () => controller.waitForExit(20),
      /TAKT process did not exit within 0.02 seconds/,
    );
  } finally {
    if (controller.isRunning || controller.hasSession) {
      await controller.dispose();
    }
  }
});

test("reload attach restores broker control state and queued inputs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-control-state-"));
  const command = createBlockingCommand(cwd);
  const first = new TaktRunController({ cwd, command, cols: 40, rows: 4 });
  const queuedInputs = [{ text: "continue after reload", queuedAt: new Date().toISOString() }];

  try {
    await first.start(["exec", "blocking"]);
    first.setControlState({ stage: "awaiting_go", queuedInputs });
    const pid = first.pid;
    await first.detach();

    const second = new TaktRunController({ cwd, command, cols: 40, rows: 4 });
    await second.attach();
    assert.equal(second.pid, pid);
    assert.equal(second.controlState.stage, "awaiting_go");
    assert.deepEqual(second.controlState.queuedInputs, queuedInputs);
    await second.shutdown();
  } finally {
    if (first.isRunning || first.hasSession) await first.shutdown();
  }
});

test("concurrent controllers converge on one authenticated broker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-singleton-"));
  const blockingArgs = ["-e", "process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000)"];
  const first = new TaktRunController({ cwd, command: process.execPath, cols: 40, rows: 4 });
  const second = new TaktRunController({ cwd, command: process.execPath, cols: 40, rows: 4 });

  try {
    const results = await Promise.allSettled([first.start(blockingArgs), second.start(blockingArgs)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    await first.detach();
    await second.detach();
    await first.attach();
    await second.attach();
    assert.equal(first.isRunning, true);
    assert.equal(second.isRunning, true);
    assert.equal(first.pid, second.pid);
    await first.shutdown();
  } finally {
    await second.detach();
  }
});

test("attach orders snapshot and live events without losing final output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-attach-race-"));
  const first = new TaktRunController({ cwd, command: process.execPath, cols: 60, rows: 8 });
  const second = new TaktRunController({ cwd, command: process.execPath, cols: 60, rows: 8 });
  const script = [
    "let index = 0;",
    "const timer = setInterval(() => {",
    "  console.log(`race-${index}`);",
    "  index += 1;",
    "  if (index === 80) { clearInterval(timer); console.log('RACE_FINAL_MARKER'); }",
    "}, 1);",
  ].join("\n");

  try {
    await first.start(["-e", script]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await first.detach();
    await second.attach();
    assert.equal((await second.waitForExit(5_000))?.code, 0);
    assert.equal(second.status, "completed");
    assert.equal(terminalContainsText(second.terminal, "RACE_FINAL_MARKER"), true);
    await second.shutdown();
  } finally {
    await first.detach();
  }
});

test("stop terminates a broker-owned PTY and allows a fresh start after dispose", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-takt-bridge-stop-timeout-"));
  const blockingArgs = ["-e", "process.on('SIGINT', () => {}); setTimeout(() => {}, 20000)"];
  const controller = new TaktRunController({
    cwd,
    command: process.execPath,
    cols: 40,
    rows: 4,
  });

  try {
    await controller.start(blockingArgs);
    await controller.stop();
    assert.equal(controller.status, "completed");
    assert.equal(controller.isRunning, false);
    await controller.dispose();
    await controller.start(["-e", "process.exit(0)"]);
    assert.equal((await controller.waitForExit(5_000))?.code, 0);
  } finally {
    if (controller.isRunning || controller.hasSession) {
      await controller.dispose();
    }
  }
});
