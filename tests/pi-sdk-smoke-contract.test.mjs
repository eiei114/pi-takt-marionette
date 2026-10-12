import assert from "node:assert/strict";
import test from "node:test";
import { behaviorAssertions, parseJsonLines } from "../scripts/pi-sdk-smoke-contract.mjs";

const commandResponse = {
  type: "response",
  command: "get_commands",
  success: true,
  data: { commands: [{ name: "takt:mode", source: "extension" }] },
};
const promptResponse = {
  id: "feature-1",
  type: "response",
  command: "prompt",
  success: true,
  data: { disposition: "handled" },
};
const modeNotification = {
  type: "extension_ui_request",
  id: "notify-1",
  method: "notify",
  message: "TAKT input mode: pi — Pi is in control.",
};

test("Pi SDK smoke parses JSONL records and ignores diagnostics", () => {
  assert.deepEqual(parseJsonLines('{"type":"response"}\nnot-json\n'), [{ type: "response" }]);
});

test("Pi SDK smoke accepts the real extension command and feature response contracts", () => {
  const load = behaviorAssertions("extension_load", { responses: [commandResponse] });
  const happy = behaviorAssertions("happy_path", { responses: [promptResponse, modeNotification] });
  assert.deepEqual(load.map((item) => item.id), ["extension_registered"]);
  assert.equal(load[0].passed, true);
  assert.deepEqual(happy.map((item) => item.id), ["feature_response"]);
  assert.equal(happy[0].passed, true);
});

test("Pi SDK smoke fails closed when the extension or feature response is missing", () => {
  const missingRegistration = behaviorAssertions("extension_load", { responses: [] });
  const missingFeature = behaviorAssertions("happy_path", { responses: [promptResponse] });
  assert.equal(missingRegistration[0].passed, false);
  assert.equal(missingFeature[0].passed, false);
});

test("Pi SDK smoke requires every second-host reload assertion and clean process exit", () => {
  const reload = behaviorAssertions("reload_cleanup", {
    responses: [],
    exit_code: 0,
    fullOutput: "",
    reloadResponses: [commandResponse, promptResponse, modeNotification],
    reloadExitCodes: [0],
    reloadOutput: "",
  });
  assert.deepEqual(reload.map((item) => item.id), [
    "reloaded_extension_registered",
    "reloaded_feature_response",
    "clean_shutdown",
  ]);
  assert.equal(reload.every((item) => item.passed), true);

  const missingSecondFeature = behaviorAssertions("reload_cleanup", {
    responses: [],
    exit_code: 0,
    fullOutput: "",
    reloadResponses: [commandResponse],
    reloadExitCodes: [0],
    reloadOutput: "",
  });
  assert.equal(missingSecondFeature[0].passed, true);
  assert.equal(missingSecondFeature[1].passed, false);

  const failedShutdown = behaviorAssertions("reload_cleanup", {
    responses: [],
    exit_code: 0,
    fullOutput: "shutdown error",
    reloadResponses: [commandResponse, promptResponse, modeNotification],
    reloadExitCodes: [1],
    reloadOutput: "",
  });
  assert.equal(failedShutdown[2].passed, false);
});

test("Pi SDK smoke validates exact native-shell version output", () => {
  const valid = behaviorAssertions("host_shell", { exit_code: 0, fullOutput: "1.1.0\n", expectedVersion: "1.1.0" });
  const missingOutput = behaviorAssertions("host_shell", { exit_code: 0, fullOutput: "", expectedVersion: "1.1.0" });
  assert.equal(valid[0].passed, true);
  assert.equal(missingOutput[0].passed, false);
});
