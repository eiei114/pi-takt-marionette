function triggerBlock(content) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "on:");
  if (start < 0) throw new Error("Expected explicit multiline on: trigger mapping");
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(" ") && !line.startsWith("#")) break;
    if (line.trim() && !line.trimStart().startsWith("#")) block.push(line);
  }
  return block;
}

function activeLines(content) {
  return content
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

export function assertReleaseTriggerContract(release, publish) {
  release = activeLines(release);
  publish = activeLines(publish);
  const manual = triggerBlock(release);
  if (manual.join("\n") !== "  workflow_dispatch:") {
    throw new Error("Release must be explicit workflow_dispatch only");
  }
  if (!release.includes("if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'")) {
    throw new Error("Manual release must be restricted to selected main");
  }
  if (release.includes("push:") || release.includes("paths:") || release.includes("branches:")) {
    throw new Error("Release must not trigger from ordinary main merge or package.json push");
  }
  if (!release.includes('gh workflow run publish.yml --ref "$RELEASE_TAG"')) {
    throw new Error("Publish handoff must dispatch publish.yml at the release tag ref");
  }
  if (release.includes("-f ref=") || release.includes("--field ref=")) {
    throw new Error("Publish handoff must not pass undeclared workflow_dispatch inputs");
  }

  const publishTriggers = triggerBlock(publish);
  const events = publishTriggers.filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim());
  if (JSON.stringify(events) !== JSON.stringify(["push:", "workflow_dispatch:"])) {
    throw new Error("Publish may only use version-tag push or explicit dispatch");
  }
  const push = publishTriggers.slice(1, publishTriggers.findIndex((line) => line === "  workflow_dispatch:"));
  if (JSON.stringify(push) !== JSON.stringify(["    tags:", '      - "v*.*.*"'])) {
    throw new Error("Publish push must contain only version tags, never main branches or paths");
  }
}
