import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  brokerDescriptorPath,
  brokerRuntimeDirectory,
  bypassControlAssertion,
  createSmokeIsolation,
  fakeBrokerSocketName,
  fakeBrokerSocketPath,
  fileFingerprint,
  isolationAssertions,
  probeChildEnvironment,
  seedProjectRegistry,
  smokeEnvironment,
  UNIX_SOCKET_PATH_LIMIT_BYTES,
} from "../scripts/pi-sdk-smoke-isolation.mjs";

function insideRoot(root, value) {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  const normalizedValue = String(value).replaceAll("\\", "/").toLowerCase();
  return normalizedValue === normalizedRoot || normalizedValue.startsWith(`${normalizedRoot}/`);
}

const cleanEndpointCounts = {
  connections: 5,
  requests: ["snapshot", "shutdown"],
  snapshot_requests: 5,
  stop_requests: 0,
  shutdown_requests: 5,
  sessionRunning: false,
};

const untouchedEndpointCounts = {
  connections: 0,
  requests: [],
  snapshot_requests: 0,
  stop_requests: 0,
  shutdown_requests: 0,
  sessionRunning: true,
};

function isolatedChildProbe(root) {
  return {
    exit_code: 0,
    resolved: {
      tmpdir: join(root, "temp"),
      registryRoot: join(root, "config"),
      piAgentDir: join(root, "agent"),
      taktConfigDir: join(root, "takt"),
      taktCommand: join(root, "bin", "takt"),
    },
  };
}

test("smoke environment redirects every user-level root and drops inherited Pi/secret variables", () => {
  const isolation = createSmokeIsolation({ rootPrefix: "pi-takt-smoke-env" });
  try {
    const env = smokeEnvironment({
      ...process.env,
      PI_CUSTOM_SECRET_DIR: "operator/pi",
      GITHUB_TOKEN: "gho_should_not_leak",
      OPENAI_API_KEY: "sk-should-not-leak",
      AWS_PROFILE: "should-not-leak",
      AZURE_TENANT_ID: "should-not-leak",
    }, isolation.paths);

    assert.equal(env.PI_CODING_AGENT_DIR, isolation.paths.agent);
    assert.equal(env.PI_OFFLINE, "1");
    assert.equal(env.TAKT_CONFIG_DIR, isolation.paths.takt);
    assert.equal(env.TAKT_COMMAND, isolation.paths.taktCommand);
    assert.equal(env.TEMP, isolation.paths.temp);
    assert.equal(env.TMP, isolation.paths.temp);
    assert.equal(env.TMPDIR, isolation.paths.temp);
    if (process.platform === "win32") {
      assert.equal(env.APPDATA, isolation.paths.config);
    } else {
      assert.equal(env.XDG_CONFIG_HOME, isolation.paths.config);
      assert.equal(env.HOME, isolation.paths.home);
    }
    for (const dropped of ["PI_CUSTOM_SECRET_DIR", "GITHUB_TOKEN", "OPENAI_API_KEY", "AWS_PROFILE", "AZURE_TENANT_ID"]) {
      assert.equal(env[dropped], undefined, `${dropped} must not reach the host`);
    }

    // The negative-control layout must not share the isolated roots.
    const bait = isolation.baitEnvironment();
    assert.equal(process.platform === "win32" ? bait.APPDATA : bait.XDG_CONFIG_HOME, isolation.bait.config);
    assert.equal(bait.TEMP, isolation.bait.temp);
    assert.equal(bait.TAKT_CONFIG_DIR, isolation.bait.takt);
    assert.notEqual(bait.TEMP, env.TEMP);
  } finally {
    isolation.cleanup();
  }
});

test("child processes inherit the isolated temp, registry and TAKT roots", () => {
  const isolation = createSmokeIsolation({ rootPrefix: "pi-takt-smoke-child" });
  try {
    const probe = probeChildEnvironment(isolation.env);
    assert.equal(probe.exit_code, 0);
    for (const value of [
      probe.resolved.tmpdir,
      probe.resolved.registryRoot,
      probe.resolved.piAgentDir,
      probe.resolved.taktConfigDir,
      probe.resolved.taktCommand,
    ]) {
      assert.ok(insideRoot(isolation.root, value), `${value} must stay inside ${isolation.root}`);
    }
  } finally {
    isolation.cleanup();
  }
});

test("fake broker socket path drops the nested broker directory that overflows the Unix socket limit", () => {
  const token = "1".repeat(64);
  const socketName = fakeBrokerSocketName("isolated", token);
  // Hosted macOS runner `TMPDIR` is ~55 bytes, so `tempRoot/.pm-<identity>/
  // <socket>` reaches 109-122 bytes while a socket directly in `tempRoot`
  // still fits. Size this test root the same way, whatever `tmpdir()` is.
  const prefix = join(tmpdir(), "pi-takt-long-");
  const separator = 1; // the path separator before the name
  const padLength = UNIX_SOCKET_PATH_LIMIT_BYTES - separator
    - Buffer.byteLength(prefix) - Buffer.byteLength(socketName);
  assert.ok(padLength >= 0, "the platform temp root must be short enough to build on");
  const longTempRoot = `${prefix}${"x".repeat(padLength)}`;
  const shortBase = mkdtempSync(join(tmpdir(), "pi-takt-short-"));
  try {
    mkdirSync(longTempRoot, { recursive: true });

    // Case 1 (the CI failure): the nested broker directory overflows, but the
    // socket may stay in the run's own temp root once the `.pm-<identity>`
    // segment and the longer name are gone.
    const nested = join(longTempRoot, ".pm-1a2b3c", socketName);
    assert.ok(
      Buffer.byteLength(nested) > UNIX_SOCKET_PATH_LIMIT_BYTES,
      `the fixture must exercise a path that is genuinely too long: ${nested} (${Buffer.byteLength(nested)} bytes)`,
    );
    const inRoot = fakeBrokerSocketPath(longTempRoot, "isolated", token, {
      platform: "linux",
      bases: [longTempRoot, shortBase],
    });
    assert.equal(inRoot, join(longTempRoot, socketName));
    assert.ok(insideRoot(longTempRoot, inRoot));
    assert.ok(Buffer.byteLength(inRoot) <= UNIX_SOCKET_PATH_LIMIT_BYTES);

    // Case 2: a temp root that cannot hold a socket at all falls back to the
    // next named base (`/tmp` in production).
    const tooLongRoot = `${prefix}${"x".repeat(padLength + 8)}`;
    mkdirSync(tooLongRoot, { recursive: true });
    const fallback = fakeBrokerSocketPath(tooLongRoot, "isolated", token, {
      platform: "linux",
      bases: [tooLongRoot, shortBase],
    });
    assert.equal(fallback, join(shortBase, socketName));
    assert.ok(insideRoot(shortBase, fallback), "the socket must stay inside a named base");
    assert.ok(Buffer.byteLength(fallback) <= UNIX_SOCKET_PATH_LIMIT_BYTES);

    // Windows keeps the named pipe, and no fallback is needed for a short root.
    assert.equal(
      fakeBrokerSocketPath(tooLongRoot, "isolated", token, { platform: "win32", bases: [tooLongRoot, shortBase] }),
      `\\\\.\\pipe\\pi-takt-smoke-isolated-${token.slice(0, 16)}`,
    );
    assert.ok(insideRoot(shortBase, fakeBrokerSocketPath(shortBase, "isolated", token, {
      platform: "linux",
      bases: [shortBase],
    })));

    // Fail closed with the measured length when no base is short enough.
    const onlyCandidate = join(tooLongRoot, socketName);
    assert.throws(
      () => fakeBrokerSocketPath(tooLongRoot, "isolated", token, { platform: "linux", bases: [tooLongRoot] }),
      (error) => error.message.includes(String(UNIX_SOCKET_PATH_LIMIT_BYTES))
        && error.message.includes(String(Buffer.byteLength(onlyCandidate))),
    );
  } finally {
    rmSync(shortBase, { recursive: true, force: true });
    rmSync(longTempRoot, { recursive: true, force: true });
    rmSync(`${prefix}${"x".repeat(padLength + 8)}`, { recursive: true, force: true });
  }
});

test("seed registry and broker descriptor live in the roots the bridge resolves", () => {
  const isolation = createSmokeIsolation({ rootPrefix: "pi-takt-smoke-roots" });
  try {
    const registryPath = seedProjectRegistry(isolation.paths.config, [isolation.paths.project]);
    assert.ok(insideRoot(isolation.root, registryPath));
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.deepEqual(registry.projects, [isolation.paths.project]);

    // Same derivation as brokerPaths() in lib/takt-run-controller.ts: `os.tmpdir()`
    // (redirected through TEMP/TMPDIR for the host) plus the user identity hash.
    const identity = typeof process.getuid === "function"
      ? String(process.getuid())
      : userInfo().username;
    const expectedDirectory = join(tmpdir(), `.pm-${createHash("sha256").update(identity).digest("hex").slice(0, 6)}`);
    assert.equal(brokerRuntimeDirectory(tmpdir()), expectedDirectory);
    const descriptorPath = brokerDescriptorPath(isolation.paths.temp, isolation.paths.project);
    assert.equal(
      descriptorPath,
      join(expectedDirectory.replace(tmpdir(), isolation.paths.temp), `${createHash("sha256").update(isolation.paths.project).digest("hex").slice(0, 20)}.json`),
    );
    assert.ok(insideRoot(isolation.root, descriptorPath));
    assert.equal(fileFingerprint(descriptorPath), "missing");
  } finally {
    isolation.cleanup();
  }
});

test("isolation assertions pass only when the isolated fixture was used and the bait was untouched", () => {
  const root = "/isolated/root";
  const assertions = isolationAssertions({
    root,
    isolatedCounts: cleanEndpointCounts,
    baitCounts: untouchedEndpointCounts,
    baitRegistry: { before: "a", after: "a" },
    childProbe: isolatedChildProbe(root),
    taktInvocations: [{ argv: ["list", "--non-interactive", "--format", "json"] }],
  });
  assert.deepEqual(assertions.map((item) => item.id), [
    "smoke_config_isolated",
    "child_process_env_isolated",
    "no_mutating_takt_command",
  ]);
  assert.equal(assertions.every((item) => item.passed), true);
});

test("isolation assertions fail closed when the isolated fixture was never used", () => {
  const root = tmpdir();
  const assertions = isolationAssertions({
    root,
    isolatedCounts: untouchedEndpointCounts,
    baitCounts: untouchedEndpointCounts,
    baitRegistry: { before: "same", after: "same" },
    childProbe: {
      exit_code: 0,
      resolved: {
        tmpdir: "/somewhere/else",
        registryRoot: "/somewhere/else",
        piAgentDir: "/somewhere/else",
        taktConfigDir: "/somewhere/else",
        taktCommand: "/somewhere/else/takt",
      },
    },
    taktInvocations: [],
  });
  assert.equal(assertions[0].passed, false, "no host reached the isolated endpoint");
  assert.equal(assertions[1].passed, false, "child roots are outside the test root");
});

test("isolation assertions fail closed when the bait layout or a mutating TAKT command is observed", () => {
  const root = "/isolated/root";
  const touchedBait = {
    connections: 1,
    requests: ["snapshot", "shutdown"],
    snapshot_requests: 1,
    stop_requests: 0,
    shutdown_requests: 1,
    sessionRunning: false,
  };
  const leaked = isolationAssertions({
    root,
    isolatedCounts: cleanEndpointCounts,
    baitCounts: touchedBait,
    baitRegistry: { before: "a", after: "b" },
    childProbe: isolatedChildProbe(root),
    taktInvocations: [{ argv: ["list"] }, { argv: ["run"] }],
  });
  assert.equal(leaked[0].passed, false, "a bait attach/shutdown must fail the run");
  assert.equal(leaked[2].passed, false, "a mutating TAKT command must fail the run");

  const registryDrift = isolationAssertions({
    root,
    isolatedCounts: cleanEndpointCounts,
    baitCounts: untouchedEndpointCounts,
    baitRegistry: { before: "a", after: "b" },
    childProbe: isolatedChildProbe(root),
    taktInvocations: [],
  });
  assert.equal(registryDrift[0].passed, false, "a changed bait registry must fail the run");
});

test("bypass control fails when no host reached the control endpoint", () => {
  const notDetected = bypassControlAssertion({ controlCounts: { connections: 0, requests: [] } });
  assert.equal(notDetected[0].passed, false);
  const detected = bypassControlAssertion({
    controlCounts: {
      connections: 1,
      requests: ["snapshot", "shutdown"],
      snapshot_requests: 1,
      shutdown_requests: 1,
      sessionRunning: false,
    },
  });
  assert.equal(detected[0].passed, true);
});
