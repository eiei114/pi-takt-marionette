import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  behaviorAssertions,
  EXTENSION_LOAD_ERROR_PATTERN,
  parseJsonLines,
  SDK_NAMES,
  UNHANDLED_ERROR_PATTERN,
  VERIFICATION_CONTRACT,
} from "./pi-sdk-smoke-contract.mjs";
import {
  bypassControlAssertion,
  createSmokeIsolation,
  fileFingerprint,
  isolationAssertions,
  probeChildEnvironment,
  seedProjectRegistry,
  startFakeBrokerEndpoint,
} from "./pi-sdk-smoke-isolation.mjs";

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
  if (manifest.devDependencies?.[name] !== "1.5.0" || sdkVersions[name] !== "1.5.0") {
    throw new Error(`Pi SDK smoke requires exact 1.5.0 dev/test pins for ${name}; manifest=${manifest.devDependencies?.[name]}, installed=${sdkVersions[name]}`);
  }
}

const piManifest = readJson(resolve(root, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const piCli = resolve(root, "node_modules/@earendil-works/pi-coding-agent", piManifest.bin.pi);

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

const isolation = createSmokeIsolation();
const { paths } = isolation;
const env = isolation.env;

function quoteForPowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sanitizeLocalPaths(value) {
  const escapeBackslashes = (path) => path.replaceAll("\\", "\\\\");
  return value
    .replaceAll(escapeBackslashes(isolation.root), "<isolated-root>")
    .replaceAll(isolation.root, "<isolated-root>")
    .replaceAll(escapeBackslashes(root), "<repo>")
    .replaceAll(root, "<repo>");
}

/** Run one real Pi RPC host with the isolated environment. */
function runHost(input, hostEnv = env) {
  const result = spawnSync(process.execPath, rpcArgs, {
    cwd: root,
    env: hostEnv,
    input,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    exit_code: result.status ?? 1,
    timed_out: result.error?.code === "ETIMEDOUT",
    error: result.error?.message,
    stdout,
    stderr,
    fullOutput: sanitizeLocalPaths(`stdout:\n${stdout}\nstderr:\n${stderr}`),
    responses: parseJsonLines(stdout),
  };
}

function commandDescription(inputLabel) {
  const cli = relative(root, piCli).replaceAll("\\", "/");
  return `node ${cli} --offline --no-session --no-tools --no-extensions -e . --no-skills --no-context-files --no-prompt-templates --no-mcp --mode rpc; stdin JSONL: ${inputLabel}; env: APPDATA/XDG_CONFIG_HOME, TEMP/TMP/TMPDIR, PI_CODING_AGENT_DIR, TAKT_CONFIG_DIR and TAKT_COMMAND point at a test-owned root`;
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

function runHostShell() {
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
    return {
      run: {
        exit_code: result.status ?? 1,
        timed_out: result.error?.code === "ETIMEDOUT",
        error: result.error?.message,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        fullOutput: sanitizeLocalPaths(`${result.stdout ?? ""}${result.stderr ?? ""}`),
        responses: [],
      },
      description: `PowerShell -NoProfile -NonInteractive: node ${relative(root, piCli).replaceAll("\\", "/")} --no-extensions --version`,
    };
  }
  const result = spawnSync("/bin/sh", ["-c", '"$1" "$2" --no-extensions --version', "pi-host-shell", process.execPath, piCli], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    run: {
      exit_code: result.status ?? 1,
      timed_out: result.error?.code === "ETIMEDOUT",
      error: result.error?.message,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      fullOutput: sanitizeLocalPaths(`${result.stdout ?? ""}${result.stderr ?? ""}`),
      responses: [],
    },
    description: `/bin/sh -c '"$1" "$2" --no-extensions --version' node ${relative(root, piCli).replaceAll("\\", "/")}`,
  };
}

async function main() {
  let isolatedEndpoint;
  let baitEndpoint;
  let controlEndpoint;
  let baitRegistryPath;
  let baitRegistryBefore;
  try {
    // A registered project with a fake PTY endpoint proves the extension really
    // resolves the isolated registry instead of the operator's live one.
    seedProjectRegistry(paths.config, [paths.project]);
    baitRegistryPath = seedProjectRegistry(isolation.bait.config, [isolation.bait.project]);
    baitRegistryBefore = fileFingerprint(baitRegistryPath);
    seedProjectRegistry(isolation.control.config, [isolation.control.project]);

    isolatedEndpoint = await startFakeBrokerEndpoint({
      projectCwd: paths.project,
      tempRoot: paths.temp,
      running: true,
      label: "isolated",
    });
    baitEndpoint = await startFakeBrokerEndpoint({
      projectCwd: isolation.bait.project,
      tempRoot: isolation.bait.temp,
      running: true,
      label: "bait",
    });
    controlEndpoint = await startFakeBrokerEndpoint({
      projectCwd: isolation.control.project,
      tempRoot: isolation.control.temp,
      running: true,
      label: "control",
    });

    // Run every host first, then read the fake endpoints: each host's
    // session_shutdown is exactly what an un-isolated run delivers to a live
    // PTY broker, so the counters must be observed after all hosts closed.
    const extensionLoad = runHost(commandsInput, env);
    const happyPath = runHost(featureInput, env);
    const errorPath = runHost("not-json\n", env);
    const firstReloadHost = runHost(commandsInput, env);
    const secondReloadHost = runHost(`${commandsInput}${featureInput}`, env);
    const hostShell = runHostShell();
    // Negative control: one host against the control layout, proving the
    // bait/isolated assertions cannot pass merely because nothing is observable.
    runHost(commandsInput, isolation.controlEnvironment());

    const isolatedCounts = isolatedEndpoint.counts();
    const baitCounts = baitEndpoint.counts();
    const controlCounts = controlEndpoint.counts();

    const cases = [];

    cases.push(makeCase(
      "extension_load",
      commandDescription('{"type":"get_commands"}'),
      extensionLoad,
      [
        ...behaviorAssertions("extension_load", extensionLoad),
        // Run-level isolation evidence. Every host above used the isolated
        // environment; the extra control host used a different fixture layout
        // so a host that resolves elsewhere cannot pass unnoticed.
        ...isolationAssertions({
          root: isolation.root,
          isolatedCounts,
          baitCounts,
          baitRegistry: { before: baitRegistryBefore, after: fileFingerprint(baitRegistryPath) },
          childProbe: probeChildEnvironment(env),
          taktInvocations: isolation.taktInvocations(),
        }),
        ...bypassControlAssertion({ controlCounts }),
      ],
      { isolation_fixture: { isolated: isolatedCounts, bait: baitCounts, control: controlCounts } },
    ));

    cases.push(makeCase(
      "happy_path",
      commandDescription('{"id":"feature-1","type":"prompt","message":"/takt:mode pi"}'),
      happyPath,
      behaviorAssertions("happy_path", happyPath),
    ));

    cases.push(makeCase(
      "error_path",
      commandDescription("malformed JSONL: not-json"),
      errorPath,
      behaviorAssertions("error_path", errorPath),
    ));

    // Close the first real host on EOF, then load and exercise a second isolated
    // host to prove registration, feature handling, and disposal survive reload.
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

    cases.push(makeCase(
      "host_shell",
      hostShell.description,
      hostShell.run,
      behaviorAssertions("host_shell", {
        ...hostShell.run,
        expectedVersion: sdkVersions["@earendil-works/pi-coding-agent"],
      }),
    ));

    const report = {
      schema_version: 1,
      verification_contract: VERIFICATION_CONTRACT,
      sdk_versions: sdkVersions,
      platform: process.platform,
      model_inference: "none; deterministic slash-command feature path in the actual Pi RPC host",
      mocked_boundary: "Pi host, extension loader/lifecycle, and /takt:mode feature are real; only provider inference is omitted. The project registry, PTY broker endpoint and TAKT CLI are managed fixtures under a test-owned root.",
      environment_isolation: "APPDATA/XDG_CONFIG_HOME, TEMP/TMP/TMPDIR, PI_CODING_AGENT_DIR, TAKT_CONFIG_DIR and TAKT_COMMAND are redirected into a throwaway root; no user-level registry, live broker or TAKT process is read, attached or started.",
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
    await isolatedEndpoint?.close();
    await baitEndpoint?.close();
    await controlEndpoint?.close();
    isolation.cleanup();
  }
}

await main();
