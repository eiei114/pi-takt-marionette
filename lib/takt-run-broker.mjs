import { spawn as spawnChild } from "node:child_process";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import xterm from "@xterm/headless";
import { spawn as spawnPty } from "node-pty";
import { ensureNodePtyHelpers } from "./node-pty-helpers.mjs";

const { Terminal } = xterm;

const STOP_GRACE_MS = 1_500;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const IDLE_EXIT_MS = 30_000;
const ORPHAN_EXIT_MS = 5 * 60 * 1_000;

const descriptorPath = process.argv[2];
const socketPath = process.argv[3];
const authToken = process.argv[4];
if (!descriptorPath || !socketPath || !authToken) {
  throw new Error("TAKT broker descriptor, socket, and token are required");
}

let pty;
let transcript = "";
let outputVersion = 0;
let lastOutputAt;
let lastExit;
let lastPid;
let cols = 120;
let rows = 30;
let idleTimer;
let sequence = 0;
let controlState = {};
let terminal;
const clients = new Set();

const server = createServer((socket) => {
  clients.add(socket);
  clearIdleTimer();
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      void handleMessage(socket, line);
    }
  });
  socket.on("close", () => {
    clients.delete(socket);
    scheduleIdleExit();
  });
  socket.on("error", () => {
    clients.delete(socket);
    scheduleIdleExit();
  });
});

server.listen(socketPath, () => {
  if (process.platform !== "win32") {
    try { chmodSync(socketPath, 0o600); } catch { /* local umask remains fallback */ }
  }
  try {
    const fd = openSync(descriptorPath, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({
        version: 1,
        pid: process.pid,
        socketPath,
        authToken,
      }), "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error?.code === "EEXIST") {
      server.close(() => process.exit(0));
      removeOwnedSocket();
      return;
    }
    throw error;
  }
  scheduleIdleExit();
});

server.on("error", () => process.exit(1));
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

async function handleMessage(socket, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const respond = (ok, extra = {}) => send(socket, {
    id: message.id,
    ok,
    ...extra,
  });

  if (message.token !== authToken) {
    respond(false, { error: "TAKT broker authentication failed" });
    socket.destroy();
    return;
  }

  try {
    switch (message.type) {
      case "snapshot":
        respond(true, { state: snapshot(true) });
        return;
      case "start":
        if (pty) throw new Error("TAKT process is already running");
        startPty(message);
        respond(true, { state: snapshot(true) });
        return;
      case "write":
        if (pty && typeof message.data === "string") pty.write(message.data);
        respond(true, { state: snapshot(false) });
        return;
      case "resize":
        resize(message.cols, message.rows);
        respond(true, { state: snapshot(false) });
        return;
      case "control":
        controlState = message.controlState && typeof message.controlState === "object"
          ? message.controlState
          : {};
        sequence += 1;
        respond(true, { state: snapshot(false) });
        return;
      case "stop":
        await stopPty();
        respond(true, { state: snapshot(true) });
        return;
      case "dispose":
        await stopPty();
        transcript = "";
        outputVersion = 0;
        lastOutputAt = undefined;
        lastExit = undefined;
        lastPid = undefined;
        controlState = {};
        sequence += 1;
        terminal?.dispose();
        terminal = undefined;
        respond(true, { state: snapshot(true) });
        return;
      case "shutdown":
        await stopPty();
        respond(true, { state: snapshot(false) });
        setTimeout(() => void shutdown(), 10).unref();
        return;
      default:
        throw new Error(`Unknown TAKT broker message: ${String(message.type)}`);
    }
  } catch (error) {
    respond(false, { error: error instanceof Error ? error.message : String(error) });
  }
}

function startPty(message) {
  const command = String(message.command || "takt");
  const args = Array.isArray(message.args) ? message.args.map(String) : ["run"];
  const helperStatus = ensureNodePtyHelpers();
  cols = positiveInteger(message.cols, 120);
  rows = positiveInteger(message.rows, 30);
  transcript = "";
  outputVersion = 0;
  lastOutputAt = undefined;
  lastExit = undefined;
  sequence += 1;
  terminal?.dispose();
  terminal = new Terminal({
    cols,
    rows,
    scrollback: 2_000,
    convertEol: false,
    allowProposedApi: true,
  });
  const ptyCommand = createPtyCommand(command, args);
  let child;
  try {
    child = spawnPty(ptyCommand.file, ptyCommand.args, {
      cwd: String(message.cwd),
      cols,
      rows,
      name: "xterm-256color",
      env: {
        ...process.env,
        ...(message.env && typeof message.env === "object" ? message.env : {}),
        TERM: "xterm-256color",
        FORCE_COLOR: "1",
      },
      ...(process.platform !== "win32" ? { encoding: "utf8" } : {}),
      ...(process.platform === "win32" ? { useConpty: false } : {}),
    });
  } catch (error) {
    const suffix = process.platform === "darwin"
      ? ` macOS ${process.arch} node-pty helpers: ${helperStatus.helperPaths.length} found, ${helperStatus.fixed} repaired`
      : "";
    throw new Error(`TAKT PTY spawn failed for ${ptyCommand.file}: ${error instanceof Error ? error.message : String(error)}.${suffix}`);
  }
  pty = child;
  lastPid = child.pid;
  child.onData((data) => {
    terminal?.write(data, () => {
      appendTranscript(data);
      outputVersion += 1;
      sequence += 1;
      lastOutputAt = Date.now();
      broadcast({ event: "output", data, outputVersion, lastOutputAt, sequence });
    });
  });
  child.onExit(({ exitCode, signal }) => {
    if (pty !== child) return;
    const finalize = () => {
      if (pty !== child) return;
      pty = undefined;
      lastExit = { code: exitCode, signal };
      sequence += 1;
      disposePty(child);
      broadcast({ event: "exit", result: lastExit, state: snapshot(false), sequence });
      scheduleIdleExit();
    };
    if (terminal) terminal.write("", finalize);
    else finalize();
  });
}

function appendTranscript(data) {
  transcript += data;
  if (Buffer.byteLength(transcript, "utf8") <= MAX_TRANSCRIPT_BYTES) return;
  transcript = terminalCheckpoint();
}

function terminalCheckpoint() {
  if (!terminal) return "";
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < buffer.length; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  return `\u001bc${lines.join("\r\n")}`;
}

function resize(nextCols, nextRows) {
  cols = positiveInteger(nextCols, cols);
  rows = positiveInteger(nextRows, rows);
  try {
    if (terminal && (terminal.cols !== cols || terminal.rows !== rows)) terminal.resize(cols, rows);
    pty?.resize(cols, rows);
  } catch {
    // Process may have exited between request and resize.
  }
}

async function stopPty() {
  const child = pty;
  if (!child) return;
  try {
    child.write("\u0003");
  } catch {
    // Continue to process-tree fallback.
  }
  if (await waitUntil(() => pty !== child, STOP_GRACE_MS)) return;
  try {
    if (process.platform === "win32") {
      await killWindowsTree(child.pid);
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    // Exit wait below is authoritative.
  }
  if (!await waitUntil(() => pty !== child, STOP_GRACE_MS)) {
    throw new Error(`TAKT process did not stop within ${STOP_GRACE_MS * 2 / 1_000} seconds`);
  }
}

function snapshot(includeTranscript) {
  return {
    status: pty ? "live" : lastExit ? "completed" : "unknown",
    pid: pty?.pid ?? lastPid,
    lastExit,
    running: Boolean(pty),
    hasSession: Boolean(pty || lastExit || transcript),
    outputVersion,
    lastOutputAt,
    cols,
    rows,
    sequence,
    controlState,
    ...(includeTranscript ? { transcript } : {}),
  };
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function broadcast(message) {
  for (const socket of clients) send(socket, message);
}

function scheduleIdleExit() {
  clearIdleTimer();
  if (clients.size > 0) return;
  idleTimer = setTimeout(() => void shutdown(), pty ? ORPHAN_EXIT_MS : IDLE_EXIT_MS);
  idleTimer.unref();
}

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

async function shutdown() {
  clearIdleTimer();
  try {
    await stopPty();
  } catch {
    // Process exit must not leave the broker socket behind.
  }
  for (const socket of clients) socket.destroy();
  server.close(() => process.exit(0));
  removeOwnedDescriptor();
  removeOwnedSocket();
  setTimeout(() => process.exit(0), 250).unref();
}

function removeOwnedDescriptor() {
  try {
    const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
    if (value?.authToken === authToken && value?.pid === process.pid) unlinkSync(descriptorPath);
  } catch {
    // Missing or replaced descriptors belong to no cleanup work here.
  }
}

function removeOwnedSocket() {
  if (process.platform === "win32" || !existsSync(socketPath)) return;
  try { unlinkSync(socketPath); } catch { /* already removed */ }
}

function createPtyCommand(command, args) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    const commandLine = [command, ...args].map(quoteWindowsArg).join(" ");
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
    };
  }
  return { file: command, args };
}

function quoteWindowsArg(value) {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function disposePty(child) {
  try {
    if (typeof child.destroy === "function") child.destroy();
    else child.kill();
  } catch {
    try { child.kill(); } catch { /* process already exited */ }
  }
  if (process.platform === "win32") {
    try {
      child._agent?._conoutSocketWorker?.dispose();
      child._socket?.destroy();
    } catch {
      // Best effort cleanup for node-pty's winpty internals.
    }
  }
}

function killWindowsTree(pid) {
  return new Promise((resolve, reject) => {
    const child = spawnChild("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 || code === 128
      ? resolve()
      : reject(new Error(`taskkill exited with code ${String(code)}`)));
  });
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function waitUntil(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 25);
  });
}
