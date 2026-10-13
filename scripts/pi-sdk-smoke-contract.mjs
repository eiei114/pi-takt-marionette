export const VERIFICATION_CONTRACT = "pi-sdk-behavior-v2";
export const SDK_NAMES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

export const UNHANDLED_ERROR_PATTERN =
  /UnhandledPromiseRejection|uncaught exception|shutdown error|shutdown failed|Error during session_shutdown/i;
export const EXTENSION_LOAD_ERROR_PATTERN =
  /Failed to load extension|Error loading extension|Failed loading extension|extension load error/i;

export function parseJsonLines(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function assertion(id, expected, observed, passed) {
  return { id, expected, observed, passed: passed === true };
}

function getCommandsResponse(responses) {
  return responses.find((row) => row?.type === "response" && row.command === "get_commands" && row.success === true);
}

function getFeatureResponse(responses) {
  return responses.find((row) => row?.type === "response" && row.command === "prompt");
}

function getModeNotification(responses) {
  return responses.find((row) => row?.type === "extension_ui_request"
    && row.method === "notify"
    && typeof row.message === "string"
    && row.message.startsWith("TAKT input mode: pi"));
}

function hasBridgeModeCommand(responses) {
  const response = getCommandsResponse(responses);
  return response?.data?.commands?.some((command) => command.name === "takt:mode" && command.source === "extension") === true;
}

export function behaviorAssertions(name, {
  responses,
  exit_code,
  fullOutput,
  expectedVersion,
  firstReloadResponses = [],
  reloadResponses = [],
  reloadExitCodes = [],
  reloadOutput = "",
}) {
  if (name === "extension_load") {
    const commands = getCommandsResponse(responses);
    return [assertion(
      "extension_registered",
      "The actual Pi RPC host lists /takt:mode as an extension command",
      commands?.data?.commands?.find((command) => command.name === "takt:mode") ?? null,
      hasBridgeModeCommand(responses),
    )];
  }

  if (name === "happy_path") {
    const prompt = getFeatureResponse(responses);
    const notification = getModeNotification(responses);
    return [assertion(
      "feature_response",
      "The actual /takt:mode pi feature returns handled and notifies the selected mode",
      { prompt: prompt ?? null, notification: notification ?? null },
      prompt?.success === true && prompt.data?.disposition === "handled" && notification !== undefined,
    )];
  }

  if (name === "error_path") {
    const parse = responses.find((row) => row?.type === "response" && row.command === "parse");
    return [assertion(
      "handled_error",
      "Malformed RPC JSON is returned as a structured parse error without crashing the Pi host",
      parse ?? null,
      parse?.success === false && typeof parse.error === "string" && parse.error.length > 0 && exit_code === 0,
    )];
  }

  if (name === "reload_cleanup") {
    const firstHostCommands = getCommandsResponse(firstReloadResponses);
    const commands = getCommandsResponse(reloadResponses);
    const prompt = getFeatureResponse(reloadResponses);
    const notification = getModeNotification(reloadResponses);
    const secondHostHandled = prompt?.success === true
      && prompt.data?.disposition === "handled"
      && notification !== undefined;
    return [
      assertion(
        "first_reload_host_registered",
        "The first actual Pi host in the reload sequence registers /takt:mode before shutdown",
        firstHostCommands?.data?.commands?.find((command) => command.name === "takt:mode") ?? null,
        hasBridgeModeCommand(firstReloadResponses),
      ),
      assertion(
        "reloaded_extension_registered",
        "A second actual Pi host after the first host's shutdown registers /takt:mode",
        commands?.data?.commands?.find((command) => command.name === "takt:mode") ?? null,
        hasBridgeModeCommand(reloadResponses),
      ),
      assertion(
        "reloaded_feature_response",
        "The second actual Pi host handles /takt:mode pi and emits the package feature notification",
        { prompt: prompt ?? null, notification: notification ?? null },
        secondHostHandled,
      ),
      assertion(
        "clean_shutdown",
        "Both Pi host processes exit zero without unhandled or shutdown errors",
        {
          exit_codes: [exit_code, ...reloadExitCodes],
          shutdown_errors: UNHANDLED_ERROR_PATTERN.test(`${fullOutput}\n${reloadOutput}`),
        },
        exit_code === 0 && reloadExitCodes.every((code) => code === 0)
          && !UNHANDLED_ERROR_PATTERN.test(`${fullOutput}\n${reloadOutput}`),
      ),
    ];
  }

  if (name === "host_shell") {
    return [assertion(
      "native_shell_boundary",
      "The native host shell launches this checkout's pinned Pi CLI and prints exactly its version",
      { exit_code, output: fullOutput.trim(), expectedVersion },
      exit_code === 0 && fullOutput.trim() === expectedVersion,
    )];
  }

  throw new Error(`Unknown Pi SDK smoke case: ${name}`);
}
