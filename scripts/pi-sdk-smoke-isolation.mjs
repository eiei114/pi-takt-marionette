import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Environment isolation for the real-Pi SDK smoke harness.
 *
 * The smoke host loads this package with `-e .`, so the extension resolves the
 * same user-level roots a real Pi session uses:
 *
 * - project/profile registries: `APPDATA` (win32) or `XDG_CONFIG_HOME`
 *   (`lib/takt-config-path.ts`)
 * - PTY broker descriptors: `os.tmpdir()/.pm-<identity>` (`brokerPaths()` in
 *   `lib/takt-run-controller.ts`)
 * - TAKT global config and CLI: `TAKT_CONFIG_DIR`, `TAKT_COMMAND`
 *   (`lib/takt-workflow-catalog.ts`, `lib/takt-state.ts`)
 *
 * Isolating only `PI_CODING_AGENT_DIR`/`PI_OFFLINE` left those roots pointing at
 * the operator's live setup: the smoke host enumerated the real project
 * registry, attached to a live PTY broker, and its `session_shutdown` sent that
 * broker `shutdown`, which stops the running TAKT process.
 */

const SECRET_ENV_PATTERN = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)|^AWS_|^AZURE_/i;

/** Subcommands that would mutate a real TAKT project; the fake CLI logs them. */
export const MUTATING_TAKT_SUBCOMMANDS = ["run", "exec", "clear", "resume", "stop"];

const CHILD_ENV_PROBE_SOURCE = `
const os = require("node:os");
const registryRoot = process.platform === "win32"
  ? process.env.APPDATA ?? ""
  : process.env.XDG_CONFIG_HOME ?? "";
console.log(JSON.stringify({
  tmpdir: os.tmpdir(),
  registryRoot,
  taktConfigDir: process.env.TAKT_CONFIG_DIR ?? "",
  taktCommand: process.env.TAKT_COMMAND ?? "",
  piAgentDir: process.env.PI_CODING_AGENT_DIR ?? "",
}));
`;

const FAKE_TAKT_CLI_SOURCE = `
import { appendFileSync } from "node:fs";
const logPath = process.env.PI_TAKT_SMOKE_LOG;
const argv = process.argv.slice(2);
if (logPath) appendFileSync(logPath, JSON.stringify({ argv }) + "\\n", "utf8");
if (argv[0] === "list") {
  console.log(JSON.stringify({ tasks: [] }));
} else if (argv[0] === "root") {
  console.log("");
}
`;

const here = dirname(fileURLToPath(import.meta.url));
export const BROKER_FIXTURE = join(here, "..", "tests", "fixtures", "fake-takt-broker.mjs");

/**
 * macOS `sockaddr_un.sun_path` is 104 bytes including the NUL terminator, so a
 * Unix socket path must stay below it (Linux: 108). `server.listen()` fails with
 * EINVAL beyond the limit.
 */
export const UNIX_SOCKET_PATH_LIMIT_BYTES = 103;

/**
 * Socket file name for one fake endpoint.
 *
 * Deliberately short: it is appended to the chosen base, and every byte counts
 * against the Unix socket path limit.
 */
export function fakeBrokerSocketName(label, token) {
  return `${label.slice(0, 4)}-${token.slice(0, 6)}.s`;
}

function existingCandidates(bases) {
  return bases
    .filter((base) => typeof base === "string" && base.length > 0)
    .filter((base, index, all) => all.indexOf(base) === index)
    .filter((base) => existsSync(base));
}

/**
 * Socket path for one fake endpoint.
 *
 * The descriptor must live in `brokerPaths()`' directory under `tempRoot`, but
 * the socket cannot when the temp root is already long: a hosted macOS runner
 * `TMPDIR` is `/var/folders/...` (~55 bytes), so
 * `tempRoot/.pm-<identity>/<label>-<token>.s` reached 109-113 bytes and the
 * broker died with EINVAL before publishing its descriptor — the macOS CI
 * failure this repairs. Prefer the socket inside the run's own `tempRoot`, and
 * fall back to `/tmp` (Unix only; short and already required by the harness)
 * when the nested path does not fit. The random token keeps every fallback
 * socket unique, and both the broker and `close()` unlink it again.
 */
export function fakeBrokerSocketPath(tempRoot, label, token, { platform = process.platform, bases } = {}) {
  const socketName = fakeBrokerSocketName(label, token);
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-takt-smoke-${label}-${token.slice(0, 16)}`;
  }
  const candidates = existingCandidates(bases ?? [tempRoot, "/tmp"]);
  const tried = [];
  for (const base of candidates) {
    const candidate = join(base, socketName);
    tried.push(`${candidate} (${Buffer.byteLength(candidate)} bytes)`);
    if (Buffer.byteLength(candidate) <= UNIX_SOCKET_PATH_LIMIT_BYTES) return candidate;
  }
  throw new Error(
    `fake TAKT broker ${label} has no socket base short enough for the ${UNIX_SOCKET_PATH_LIMIT_BYTES}-byte Unix socket path limit: `
    + tried.join(", "),
  );
}

/** Stable broker runtime directory, mirroring brokerPaths() in the controller. */
export function brokerRuntimeDirectory(tempRoot) {
  const identity = typeof process.getuid === "function"
    ? String(process.getuid())
    : userInfo().username;
  const identityHash = createHash("sha256").update(identity).digest("hex").slice(0, 6);
  return join(tempRoot, `.pm-${identityHash}`);
}

export function brokerDescriptorPath(tempRoot, projectCwd) {
  return join(
    brokerRuntimeDirectory(tempRoot),
    `${createHash("sha256").update(projectCwd).digest("hex").slice(0, 20)}.json`,
  );
}

/**
 * Build the child environment for the smoke host.
 *
 * Every user-level root is redirected into `roots`, inherited `PI_*` and
 * credential variables are dropped, and the TAKT CLI is replaced with a managed
 * fake so the host cannot resolve the operator's live configuration even when
 * the caller's own environment points at it.
 */
export function smokeEnvironment(baseEnv, roots) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([name]) =>
    !/^PI_/i.test(name) && !SECRET_ENV_PATTERN.test(name)));
  env.PI_CODING_AGENT_DIR = roots.agent;
  env.PI_OFFLINE = "1";
  env.PI_TAKT_SMOKE_LOG = roots.taktLog;
  env.TAKT_CONFIG_DIR = roots.takt;
  env.TAKT_COMMAND = roots.taktCommand;
  env.TEMP = roots.temp;
  env.TMP = roots.temp;
  env.TMPDIR = roots.temp;
  if (process.platform === "win32") {
    env.APPDATA = roots.config;
  } else {
    env.XDG_CONFIG_HOME = roots.config;
    env.HOME = roots.home;
  }
  return env;
}

/** Write a project registry the way the extension expects to read one. */
export function seedProjectRegistry(configRoot, projects) {
  const registryPath = join(configRoot, "pi-takt-bridge", "projects.json");
  mkdirSync(join(configRoot, "pi-takt-bridge"), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, "utf8");
  return registryPath;
}

export function fileFingerprint(filePath) {
  if (!existsSync(filePath)) {
    return "missing";
  }
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createFakeTaktCommand(binDirectory, logPath) {
  const cliPath = join(binDirectory, "fake-takt-cli.mjs");
  writeFileSync(cliPath, FAKE_TAKT_CLI_SOURCE.trimStart(), "utf8");
  if (process.platform === "win32") {
    const commandPath = join(binDirectory, "fake-takt.cmd");
    writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`, "utf8");
    return commandPath;
  }
  const commandPath = join(binDirectory, "fake-takt");
  writeFileSync(commandPath, `#!/bin/sh\n"${process.execPath}" "${cliPath}" "$@"\n`, "utf8");
  const chmod = spawnSync("chmod", ["+x", commandPath], { windowsHide: true });
  if (chmod.status !== 0) {
    throw new Error(`fake TAKT CLI could not be made executable: ${chmod.stderr?.toString() ?? "chmod failed"}`);
  }
  return commandPath;
}

function layoutRoots(base, name) {
  return {
    ...base,
    project: join(base.root, name, "project"),
    config: join(base.root, name, "config"),
    temp: join(base.root, name, "temp"),
    takt: join(base.root, name, "takt"),
    home: join(base.root, name, "home"),
    taktLog: join(base.root, `${name}-takt-invocations.jsonl`),
  };
}

/**
 * Test-owned root tree for one smoke run.
 *
 * Two layouts live under one temp root:
 *
 * - `paths`: the isolated layout handed to every smoke host (a seeded registry
 *   entry that points at a managed fake PTY endpoint);
 * - `bait`: an operator-shaped layout (registry + PTY endpoint + project) that
 *   the isolated hosts must never reach, so a lost isolation is detected
 *   instead of silently reaching a live session;
 * - `control`: a second layout, reached on purpose by one negative-control host
 *   run, proving that a host resolving its registry and broker root elsewhere
 *   really is detectable.
 */
export function createSmokeIsolation({ rootPrefix = "pi-takt-sdk-smoke" } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${rootPrefix}-`));
  const binDirectory = join(root, "bin");
  mkdirSync(binDirectory, { recursive: true });
  const taktCommand = createFakeTaktCommand(binDirectory, join(root, "takt-invocations.jsonl"));
  const base = { root, agent: join(root, "agent"), taktCommand };
  const paths = {
    ...base,
    project: join(root, "project"),
    config: join(root, "config"),
    temp: join(root, "temp"),
    takt: join(root, "takt"),
    home: join(root, "home"),
    taktLog: join(root, "takt-invocations.jsonl"),
  };
  const bait = layoutRoots(base, "bait");
  const control = layoutRoots(base, "control");
  for (const layout of [paths, bait, control]) {
    for (const directory of [layout.project, layout.config, layout.temp, layout.takt, layout.home]) {
      mkdirSync(directory, { recursive: true });
    }
  }
  mkdirSync(paths.agent, { recursive: true });

  return {
    root,
    paths,
    bait,
    control,
    env: smokeEnvironment(process.env, paths),
    baitEnvironment: () => smokeEnvironment(process.env, bait),
    controlEnvironment: () => smokeEnvironment(process.env, control),
    taktInvocations(logPath) {
      const selected = logPath ?? paths.taktLog;
      if (!existsSync(selected)) return [];
      return readFileSync(selected, "utf8")
        .split(/\r?\n/)
        .flatMap((line) => {
          if (!line.trim()) return [];
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function readBrokerLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const NOT_A_REQUEST = new Set([
  "connection",
  "ready",
  "broker_exit",
  "descriptor_error",
  "server_error",
  "malformed",
]);

/**
 * Managed fake PTY broker endpoint.
 *
 * Runs `tests/fixtures/fake-takt-broker.mjs` in its own process: it speaks the
 * descriptor protocol the controller expects, but owns no PTY and no TAKT
 * process. Requests are logged so a harness run can assert which endpoint a Pi
 * host actually reached. A separate process (not an in-process server) is
 * required because host runs use a synchronous spawn.
 */
export async function startFakeBrokerEndpoint({
  projectCwd,
  tempRoot,
  running = true,
  label = "isolated",
  readyTimeoutMs = 15_000,
}) {
  const token = randomBytes(32).toString("hex");
  mkdirSync(brokerRuntimeDirectory(tempRoot), { recursive: true });
  const socketPath = fakeBrokerSocketPath(tempRoot, label, token);
  const descriptorPath = brokerDescriptorPath(tempRoot, projectCwd);
  // The log name carries the random token so repeated runs in the same temp
  // directory never append to an earlier run's evidence.
  const logPath = join(tempRoot, `${label}-${token.slice(0, 8)}-broker-log.jsonl`);

  const child = spawn(process.execPath, [
    BROKER_FIXTURE,
    "--descriptor", descriptorPath,
    "--socket", socketPath,
    "--token", token,
    "--log", logPath,
    "--label", label,
    "--running", running ? "1" : "0",
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  let exited;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code) => {
      exited = code;
      resolve(code);
    });
  });

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline && !existsSync(descriptorPath) && exited === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (exited !== undefined || !existsSync(descriptorPath)) {
    child.kill("SIGKILL");
    if (process.platform !== "win32" && existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* owned by this endpoint */ }
    }
    const socketFailure = readBrokerLog(logPath).find((event) => event.type === "server_error");
    throw new Error(`fake TAKT broker ${label} did not become ready (exit ${String(exited)}, descriptor ${existsSync(descriptorPath) ? "present" : "missing"}${socketFailure ? `, socket ${String(socketFailure.code)} at ${Buffer.byteLength(socketPath)} bytes` : ""})`);
  }

  const events = () => readBrokerLog(logPath);

  return {
    label,
    descriptorPath,
    socketPath,
    logPath,
    events,
    counts() {
      const log = events();
      const requests = log.filter((event) => !NOT_A_REQUEST.has(event.type));
      return {
        connections: log.filter((event) => event.type === "connection").length,
        requests: requests.map((event) => event.type),
        snapshot_requests: requests.filter((event) => event.type === "snapshot").length,
        stop_requests: requests.filter((event) => event.type === "stop").length,
        shutdown_requests: requests.filter((event) => event.type === "shutdown").length,
        unauthorized: log.filter((event) => event.authorized === false).length,
        sessionRunning: !requests.some((event) =>
          event.type === "shutdown" || event.type === "stop" || event.type === "dispose"),
      };
    },
    async close() {
      if (exited === undefined) {
        child.kill("SIGTERM");
        await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
        if (exited === undefined) child.kill("SIGKILL");
        await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      }
      if (existsSync(descriptorPath)) {
        try { unlinkSync(descriptorPath); } catch { /* owned by the temp root */ }
      }
      if (process.platform !== "win32" && existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* owned by this endpoint */ }
      }
      // The endpoint log is the harness's own artifact; remove it so a repeated
      // run cannot count an earlier run's requests.
      if (existsSync(logPath)) {
        try { unlinkSync(logPath); } catch { /* owned by the temp root */ }
      }
    },
  };
}

/**
 * Run a child process with the same environment the smoke hands to Pi and report
 * the roots that child resolves. Broker children inherit `process.env`, so this
 * is the inheritance check for `TEMP`/`APPDATA`/`TAKT_CONFIG_DIR`/`TAKT_COMMAND`.
 */
export function probeChildEnvironment(env) {
  const result = spawnSync(process.execPath, ["-e", CHILD_ENV_PROBE_SOURCE], {
    env,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const stdout = (result.stdout ?? "").trim();
  let resolved;
  try {
    resolved = JSON.parse(stdout);
  } catch {
    return { exit_code: result.status ?? 1, error: result.error?.message, resolved: undefined };
  }
  return { exit_code: result.status ?? 1, error: result.error?.message, resolved };
}

function isInsideRoot(root, value) {
  if (typeof value !== "string" || !value) return false;
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  const normalizedValue = value.replaceAll("\\", "/").toLowerCase();
  return normalizedValue === normalizedRoot || normalizedValue.startsWith(`${normalizedRoot}/`);
}

function requestSummary(counts = {}) {
  return {
    connections: counts.connections ?? 0,
    requests: [...(counts.requests ?? [])],
    snapshot_requests: counts.snapshot_requests ?? 0,
    stop_requests: counts.stop_requests ?? 0,
    shutdown_requests: counts.shutdown_requests ?? 0,
    sessionRunning: counts.sessionRunning === true,
  };
}

/**
 * Assertions recorded in the smoke report.
 *
 * They fail closed: the isolated endpoint must have been reached (proving the
 * overrides are effective) while the operator-shaped bait endpoint and registry
 * must stay unchanged, and no mutating TAKT command may have run.
 */
export function isolationAssertions({
  root,
  isolatedCounts = {},
  baitCounts = {},
  baitRegistry = { before: "missing", after: "missing" },
  childProbe = { exit_code: 1 },
  taktInvocations = [],
}) {
  const isolatedUsed = (isolatedCounts.connections ?? 0) >= 1
    && (isolatedCounts.snapshot_requests ?? 0) >= 1
    && (isolatedCounts.shutdown_requests ?? 0) >= 1;
  const baitUntouched = (baitCounts.connections ?? 0) === 0
    && (baitCounts.stop_requests ?? 0) === 0
    && (baitCounts.shutdown_requests ?? 0) === 0
    && (baitCounts.snapshot_requests ?? 0) === 0
    && baitRegistry.before === baitRegistry.after;
  const probe = childProbe.resolved;
  const childIsolated = childProbe.exit_code === 0
    && probe !== undefined
    && isInsideRoot(root, probe.tmpdir)
    && isInsideRoot(root, probe.registryRoot)
    && isInsideRoot(root, probe.piAgentDir)
    && isInsideRoot(root, probe.taktConfigDir)
    && isInsideRoot(root, probe.taktCommand);
  const mutating = taktInvocations.filter((entry) =>
    MUTATING_TAKT_SUBCOMMANDS.includes(String(entry?.argv?.[0] ?? "")));

  return [
    {
      id: "smoke_config_isolated",
      expected: "The smoke hosts resolve the project registry and PTY endpoint under the test-owned root, while the operator-shaped bait registry and fake endpoint stay unchanged",
      observed: {
        isolated_endpoint: requestSummary(isolatedCounts),
        bait_endpoint: requestSummary(baitCounts),
        bait_registry_fingerprint: { ...baitRegistry },
      },
      passed: isolatedUsed && baitUntouched,
    },
    {
      id: "child_process_env_isolated",
      expected: "A child process inheriting the smoke environment resolves temp, registry, Pi agent, TAKT config and TAKT command roots inside the test-owned root",
      observed: probe ?? { error: childProbe.error ?? "child env probe produced no parsable output" },
      passed: childIsolated,
    },
    {
      id: "no_mutating_takt_command",
      expected: "The isolated smoke never invokes a mutating TAKT command (run, exec, clear, resume, stop)",
      observed: { invocations: taktInvocations.map((entry) => entry?.argv), mutating },
      passed: mutating.length === 0,
    },
  ];
}

/**
 * Negative control assertion.
 *
 * One host run with the *control* layout's environment must attach to that
 * layout's endpoint and send it shutdown. Without it the bait fixture could not
 * prove that a host resolving its registry/broker root elsewhere is detectable,
 * and the isolation assertions above would be vacuous.
 */
export function bypassControlAssertion({ controlCounts = {} }) {
  const detected = (controlCounts.connections ?? 0) >= 1
    && (controlCounts.snapshot_requests ?? 0) >= 1
    && (controlCounts.shutdown_requests ?? 0) >= 1
    && controlCounts.sessionRunning === false;
  return [{
    id: "bait_endpoint_detectable",
    expected: "A host run against a non-isolated layout attaches to that layout's fake endpoint and sends it shutdown, proving a lost isolation is detected instead of silently ignored",
    observed: requestSummary(controlCounts),
    passed: detected,
  }];
}
