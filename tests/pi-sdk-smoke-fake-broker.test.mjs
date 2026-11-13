import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeBrokerEndpoint } from "../scripts/pi-sdk-smoke-isolation.mjs";
import { TaktRunController } from "../lib/takt-run-controller.ts";

// The controller derives its broker runtime directory from `os.tmpdir()` of the
// current process, so the fake endpoint must be seeded there. Redirect the temp
// root for the duration of this test so the shared `.pm-<identity>` directory
// (which a live Pi session may be using) is never written to.
test("fake PTY broker speaks the descriptor protocol the real controller uses", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-takt-fake-broker-temp-"));
  const cwd = mkdtempSync(join(tempRoot, "project-"));
  const savedTemp = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.TEMP = tempRoot;
  process.env.TMP = tempRoot;
  process.env.TMPDIR = tempRoot;
  const endpoint = await startFakeBrokerEndpoint({
    projectCwd: cwd,
    tempRoot,
    running: true,
    label: "controller-protocol",
  });
  const controller = new TaktRunController({
    cwd,
    command: process.execPath,
    cols: 40,
    rows: 4,
  });
  let shutDown = false;
  try {
    // Attach must reuse the existing endpoint instead of starting a PTY.
    await controller.attach();
    assert.equal(controller.isRunning, true);
    assert.equal(controller.hasSession, true);
    const attached = endpoint.counts();
    assert.equal(attached.connections, 1);
    assert.deepEqual(attached.requests, ["snapshot"]);
    assert.equal(attached.sessionRunning, true);

    // Shutdown must deliver the shutdown request that a real broker answers by
    // stopping its PTY. This is exactly the call an un-isolated smoke emitted
    // against the operator's live broker.
    await controller.shutdown();
    shutDown = true;
    const stopped = endpoint.counts();
    assert.deepEqual(stopped.requests, ["snapshot", "shutdown"]);
    assert.equal(stopped.shutdown_requests, 1);
    assert.equal(stopped.sessionRunning, false);
    assert.equal(stopped.stop_requests, 0);
    assert.equal(stopped.unauthorized, 0);
  } finally {
    if (!shutDown) await controller.shutdown().catch(() => {});
    await endpoint.close();
    for (const [name, value] of Object.entries(savedTemp)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
