import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, relative } from "node:path";
import {
  behaviorAssertions,
  EXTENSION_LOAD_ERROR_PATTERN,
  parseJsonLines,
  SDK_NAMES,
  UNHANDLED_ERROR_PATTERN,
  VERIFICATION_CONTRACT,
} from "./pi-sdk-smoke-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const reportPath = process.argv.includes("--update-curated-report")
  ? resolve(root, "docs/verification/pi-sdk-smoke.json")
  : resolve(root, ".tmp/pi-sdk-smoke.json");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = readJson(resolve(root, "package.json"));
const sdkVersions = Object.fromEntries(SDK_NAMES.map((name) => [
  name,
  readJson(resolve(root, "node_modules", name, "package.json")).version,
]));

for (const name of SDK_NAMES) {
  if (manifest.devDependencies?.[name] !== "1.1.0" || sdkVersions[name] !== "1.1.0") {
    throw new Error(`Pi SDK smoke requires exact 1.1.0 dev/test pins for ${name}; manifest=${manifest.devDependencies?.[name]}, installed=${sdkVersions[name]}`);
  }
}

const piManifest = readJson(resolve(root, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const piCli = resolve(root, "node_modules/@earendil-works/pi-coding-agent", piManifest.bin.pi);
const agentDir = mkdtempSync(resolve(tmpdir(), "pi-takt-sdk-smoke-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^PI_/i.test(name) && !/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)|^AWS_|^AZURE_/i.test(name)));
env.PI_CODING_AGENT_DIR = agentDir;
env.PI_OFFLINE = "1";

const rpcArgs = [
  piCli,
  "--offline",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "-e",
  ".",
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-mcp",
  "--mode",
  "rpc",
];
const commandsInput = `${JSON.stringify({ type: "get_commands" })}\n`;
const featureInput = `${JSON.stringify({ id: "feature-1", type: "prompt", message: "/takt:mode pi" })}\n`;

function quoteForPowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sanitizeLocalPaths(value) {
  const escapeBackslashes = (path) => path.replaceAll("\\", "\\\\");
  return value
    .replaceAll(escapeBackslashes(agentDir), "<isolated-agent-dir>")
    .replaceAll(agentDir, "<isolated-agent-dir>")
    .replaceAll(escapeBackslashes(root), "<repo>")
    .replaceAll(root, "<repo>");
}

function runHost(input) {
  const result = spawnSync(process.execPath, rpcArgs, {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const fullOutput = sanitizeLocalPaths(`stdout:\n${stdout}\nstderr:\n${stderr}`);
  return {
    exit_code: result.status ?? 1,
    timed_out: result.error?.code === "ETIMEDOUT",
    error: result.error?.message,
    stdout,
    stderr,
    fullOutput,
    responses: parseJsonLines(stdout),
  };
}

function commandDescription(inputLabel) {
  const cli = relative(root, piCli).replaceAll("\\", "/");
  return `node ${cli} --offline --no-session --no-tools --no-extensions -e . --no-skills --no-context-files --no-prompt-templates --no-mcp --mode rpc; stdin JSONL: ${inputLabel}`;
}

function makeCase(name, command, runResult, assertions, extra = {}) {
  const unhandledError = UNHANDLED_ERROR_PATTERN.test(runResult.fullOutput);
  const extensionLoadError = EXTENSION_LOAD_ERROR_PATTERN.test(runResult.fullOutput);
  const passed = runResult.exit_code === 0
    && !runResult.timed_out
    && !runResult.error
    && !unhandledError
    && !extensionLoadError
    && assertions.every((item) => item.passed);
  const evidence = runResult.fullOutput.length > 6_000
    ? `[validated full output; stored tail of 6000 chars]\n${runResult.fullOutput.slice(-6_000)}`
    : runResult.fullOutput;
  const safeAssertions = JSON.parse(sanitizeLocalPaths(JSON.stringify(assertions)));
  return {
    name,
    command,
    exit_code: runResult.exit_code,
    passed,
    timeout_ms: 15_000,
    timed_out: runResult.timed_out === true,
    ...(runResult.error ? { process_error: runResult.error } : {}),
    evidence,
    assertions: safeAssertions,
    ...extra,
    _unhandledError: unhandledError,
    _extensionLoadError: extensionLoadError,
  };
}

try {
  const cases = [];

  const extensionLoad = runHost(commandsInput);
  cases.push(makeCase(
    "extension_load",
    commandDescription('{"type":"get_commands"}'),
    extensionLoad,
    behaviorAssertions("extension_load", extensionLoad),
  ));

  const happyPath = runHost(featureInput);
  cases.push(makeCase(
    "happy_path",
    commandDescription('{"id":"feature-1","type":"prompt","message":"/takt:mode pi"}'),
    happyPath,
    behaviorAssertions("happy_path", happyPath),
  ));

  const errorPath = runHost("not-json\n");
  cases.push(makeCase(
    "error_path",
    commandDescription("malformed JSONL: not-json"),
    errorPath,
    behaviorAssertions("error_path", errorPath),
  ));

  // Close the first real host on EOF, then load and exercise a second isolated
  // host to prove registration, feature handling, and disposal survive reload.
  const firstReloadHost = runHost(commandsInput);
  const secondReloadHost = runHost(`${commandsInput}${featureInput}`);
  const reloadOutput = `${firstReloadHost.fullOutput}\n${secondReloadHost.fullOutput}`;
  const reload = {
    ...secondReloadHost,
    fullOutput: `${firstReloadHost.fullOutput}\n--- second Pi host ---\n${secondReloadHost.fullOutput}`,
  };
  cases.push(makeCase(
    "reload_cleanup",
    `two sequential Pi hosts: first stdin JSONL {"type":"get_commands"}; second stdin JSONL {"type":"get_commands"} then {"id":"feature-1","type":"prompt","message":"/takt:mode pi"}`,
    reload,
    behaviorAssertions("reload_cleanup", {
      ...secondReloadHost,
      exit_code: firstReloadHost.exit_code,
      fullOutput: reloadOutput,
      firstReloadResponses: firstReloadHost.responses,
      reloadResponses: secondReloadHost.responses,
      reloadExitCodes: [secondReloadHost.exit_code],
      reloadOutput,
    }),
    { first_process_exit_code: firstReloadHost.exit_code },
  ));

  let hostShell;
  let hostShellDescription;
  if (process.platform === "win32") {
    const shell = resolve(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const command = `& ${quoteForPowerShell(process.execPath)} ${quoteForPowerShell(piCli)} --no-extensions --version; exit $LASTEXITCODE`;
    const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    hostShell = {
      exit_code: result.status ?? 1,
      timed_out: result.error?.code === "ETIMEDOUT",
      error: result.error?.message,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      fullOutput: sanitizeLocalPaths(`${result.stdout ?? ""}${result.stderr ?? ""}`),
      responses: [],
    };
    hostShellDescription = `PowerShell -NoProfile -NonInteractive: node ${relative(root, piCli).replaceAll("\\", "/")} --no-extensions --version`;
  } else {
    const result = spawnSync("/bin/sh", ["-c", '"$1" "$2" --no-extensions --version', "pi-host-shell", process.execPath, piCli], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    hostShell = {
      exit_code: result.status ?? 1,
      timed_out: result.error?.code === "ETIMEDOUT",
      error: result.error?.message,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      fullOutput: sanitizeLocalPaths(`${result.stdout ?? ""}${result.stderr ?? ""}`),
      responses: [],
    };
    hostShellDescription = `/bin/sh -c '"$1" "$2" --no-extensions --version' node ${relative(root, piCli).replaceAll("\\", "/")}`;
  }
  cases.push(makeCase(
    "host_shell",
    hostShellDescription,
    hostShell,
    behaviorAssertions("host_shell", {
      ...hostShell,
      expectedVersion: sdkVersions["@earendil-works/pi-coding-agent"],
    }),
  ));

  const report = {
    schema_version: 1,
    verification_contract: VERIFICATION_CONTRACT,
    sdk_versions: sdkVersions,
    platform: process.platform,
    model_inference: "none; deterministic slash-command feature path in the actual Pi RPC host",
    mocked_boundary: "Pi host, extension loader/lifecycle, and /takt:mode feature are real; only provider inference is omitted",
    unhandled_errors: cases.filter((item) => item._unhandledError).length,
    extension_load_errors: cases.filter((item) => item._extensionLoadError
      || item.assertions.some((assertion) =>
        (assertion.id === "extension_registered"
          || assertion.id === "first_reload_host_registered"
          || assertion.id === "reloaded_extension_registered")
        && !assertion.passed)).length,
    cases: cases.map(({ _unhandledError, _extensionLoadError, ...item }) => item),
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    verification_contract: VERIFICATION_CONTRACT,
    platform: process.platform,
    cases: cases.map(({ name, passed, exit_code }) => ({ name, passed, exit_code })),
  }));
  if (cases.some((item) => !item.passed)) process.exitCode = 1;
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
