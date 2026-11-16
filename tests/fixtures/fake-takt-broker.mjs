import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

/**
 * Managed fake PTY broker for the SDK smoke harness.
 *
 * It speaks the descriptor protocol the bridge expects (see
 * lib/takt-run-controller.ts and lib/takt-run-broker.mjs) but never spawns a
 * PTY or a TAKT process. Every request is appended to a JSONL log so the
 * harness can assert which endpoint a Pi host actually reached.
 *
 * Usage:
 *   node fake-takt-broker.mjs --descriptor <path> --socket <path>
 *        --token <hex> --log <path> --running <0|1> [--shutdown-exits 0|1]
 */

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const descriptorPath = argument("descriptor");
const socketPath = argument("socket");
const authToken = argument("token");
const logPath = argument("log");
const label = argument("label") ?? "fake";

if (!descriptorPath || !socketPath || !authToken || !logPath) {
  throw new Error("fake broker requires --descriptor, --socket, --token and --log");
}

let sessionRunning = argument("running") === "1";
// A real broker exits on shutdown. The smoke fixture stays alive by default so
// every host in the reload sequence records its own attach/shutdown against the
// same endpoint; `--exit-on-shutdown` restores the real broker's behaviour.
const exitOnShutdown = argument("exit-on-shutdown") === "1";
let sequence = 0;
const clients = new Set();

function record(entry) {
  appendFileSync(logPath, `${JSON.stringify({ label, ...entry, at: Date.now() })}\n`, "utf8");
}

function state() {
  sequence += 1;
  return {
    status: sessionRunning ? "live" : "completed",
    pid: sessionRunning ? process.pid : undefined,
    running: sessionRunning,
    hasSession: sessionRunning,
    outputVersion: 0,
    lastOutputAt: undefined,
    cols: 120,
    rows: 30,
    sequence,
    controlState: {},
    transcript: "",
  };
}

const server = createServer((socket) => {
  clients.add(socket);
  record({ type: "connection" });
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
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        record({ type: "malformed" });
        continue;
      }
      const authorized = message.token === authToken;
      record({ type: message.type ?? "unknown", authorized });
      if (!authorized) {
        socket.destroy();
        continue;
      }
      if (message.type === "shutdown" || message.type === "stop" || message.type === "dispose") {
        sessionRunning = false;
      }
      socket.write(`${JSON.stringify({ id: message.id, ok: true, state: state() })}\n`);
      if (message.type === "shutdown" && exitOnShutdown) {
        setTimeout(() => shutdown(), 10);
      }
    }
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

server.listen(socketPath, () => {
  try {
    const fd = openSync(descriptorPath, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({
        version: 1,
        pid: process.pid,
        socketPath,
        authToken,
      })}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    record({ type: "descriptor_error", code: error?.code });
  }
  record({ type: "ready", pid: process.pid });
});

server.on("error", (error) => {
  record({ type: "server_error", code: error?.code });
  process.exit(1);
});

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

function shutdown() {
  record({ type: "broker_exit", pid: process.pid });
  for (const socket of clients) socket.destroy();
  clients.clear();
  server.close(() => process.exit(0));
  try {
    const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
    if (value?.pid === process.pid) unlinkSync(descriptorPath);
  } catch {
    // The descriptor is already gone or owned by another broker.
  }
  if (process.platform !== "win32" && existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* already removed */ }
  }
  setTimeout(() => process.exit(0), 100).unref();
}
