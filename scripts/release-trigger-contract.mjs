import { parse } from "yaml";

const blockedPatterns = [
  ["npm publication", /\bnpm\s+publish\b/i],
  ["GitHub release creation", /\bgh\s+release\s+create\b/i],
  ["tag creation", /\bgit\s+tag\b/i],
  ["workflow dispatch", /\bgh\s+workflow\s+run\b/i],
];

const releasePublishingActions = new Set([
  "actions/create-release",
  "google-github-actions/release-please-action",
  "marvinpinto/action-automatic-releases",
  "ncipollo/release-action",
  "softprops/action-gh-release",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasManualDispatchTrigger(trigger) {
  const isDispatch = (value) => typeof value === "string" && value.trim().toLowerCase() === "workflow_dispatch";
  if (isDispatch(trigger)) return true;
  if (Array.isArray(trigger)) return trigger.some(isDispatch);
  return isRecord(trigger) && Object.keys(trigger).some(isDispatch);
}

function hasWritePermissions(permissions) {
  if (typeof permissions === "string") return permissions.trim().toLowerCase() === "write-all";
  return isRecord(permissions) && Object.values(permissions).some(
    (permission) => typeof permission === "string" && permission.trim().toLowerCase() === "write",
  );
}

function hasReleasePublishingAction(value, visited = new Set()) {
  if (Array.isArray(value)) return value.some((entry) => hasReleasePublishingAction(entry, visited));
  if (!isRecord(value) || visited.has(value)) return false;
  visited.add(value);

  if (typeof value.uses === "string") {
    const action = value.uses.toLowerCase().split("@", 1)[0];
    if (releasePublishingActions.has(action)) return true;
  }
  return Object.values(value).some((entry) => hasReleasePublishingAction(entry, visited));
}

function assertNoWorkflowPublicationMetadata(path, content) {
  const workflow = parse(content, { uniqueKeys: true });
  if (!isRecord(workflow)) return;

  const triggers = Object.entries(workflow).find(([key]) => key.toLowerCase() === "on")?.[1];
  if (hasManualDispatchTrigger(triggers)) {
    throw new Error(`${path} contains manual workflow dispatch; publication is disabled until a trusted external authorization boundary exists`);
  }

  const jobs = isRecord(workflow.jobs) ? Object.values(workflow.jobs) : [];
  if (hasWritePermissions(workflow.permissions) || jobs.some((job) => isRecord(job) && hasWritePermissions(job.permissions))) {
    throw new Error(`${path} contains write-capable workflow token; publication is disabled until a trusted external authorization boundary exists`);
  }

  if (hasReleasePublishingAction(workflow)) {
    throw new Error(`${path} uses a GitHub release-publishing action; publication is disabled until a trusted external authorization boundary exists`);
  }
}

export function assertNoPrivilegedPublicationWorkflows(workflows) {
  for (const { path, content } of workflows) {
    assertNoWorkflowPublicationMetadata(path, content);
    const activeContent = content
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    for (const [label, pattern] of blockedPatterns) {
      if (pattern.test(activeContent)) {
        throw new Error(`${path} contains ${label}; publication is disabled until a trusted external authorization boundary exists`);
      }
    }
  }
}
