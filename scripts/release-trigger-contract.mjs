import { parse } from "yaml";

// ---------------------------------------------------------------------------
// Protected release contract
//
// Publication must never be a merge side effect, and a `github.ref` condition in
// branch-editable workflow code is not a security boundary. The contract below
// requires three independent barriers on the release workflow, plus OIDC-only
// publishing. Removing any single barrier fails closed.
// ---------------------------------------------------------------------------

const releasePublishingActions = new Set([
  "actions/create-release",
  "google-github-actions/release-please-action",
  "marvinpinto/action-automatic-releases",
  "ncipollo/release-action",
  "softprops/action-gh-release",
]);

const PROTECTED_ENVIRONMENT = "release";
const AUTHORIZATION_INPUT = "release_authorized";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalize(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function triggerKeys(workflow) {
  const triggers = Object.entries(workflow).find(([key]) => key.toLowerCase() === "on")?.[1];
  if (typeof triggers === "string") return [normalize(triggers)];
  if (Array.isArray(triggers)) return triggers.map(normalize);
  if (isRecord(triggers)) return Object.keys(triggers).map(normalize);
  return [];
}

function dispatchInputs(workflow) {
  const triggers = Object.entries(workflow).find(([key]) => key.toLowerCase() === "on")?.[1];
  if (!isRecord(triggers)) return {};
  const dispatch = Object.entries(triggers).find(([key]) => normalize(key) === "workflow_dispatch")?.[1];
  if (!isRecord(dispatch)) return {};
  return isRecord(dispatch.inputs) ? dispatch.inputs : {};
}

function hasWritePermissions(permissions) {
  if (typeof permissions === "string") return permissions.trim().toLowerCase() === "write-all";
  return (
    isRecord(permissions) &&
    Object.values(permissions).some((permission) => normalize(permission) === "write")
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

function activeLines(content) {
  return content
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

export function assertProtectedReleaseWorkflow(path, content) {
  const workflow = parse(content, { uniqueKeys: true });
  if (!isRecord(workflow)) throw new Error(`${path} is not a workflow mapping`);

  // Barrier 1: dispatch-only. A push or release trigger publishes on merge.
  const triggers = triggerKeys(workflow);
  if (triggers.length !== 1 || triggers[0] !== "workflow_dispatch") {
    throw new Error(`${path} must be dispatch-only; found triggers: ${triggers.join(", ") || "none"}`);
  }

  // Barrier 2: the authorization input is required and defaults to false.
  const inputs = dispatchInputs(workflow);
  const authorization = Object.entries(inputs).find(([key]) => normalize(key) === AUTHORIZATION_INPUT)?.[1];
  if (!isRecord(authorization)) {
    throw new Error(`${path} must require the ${AUTHORIZATION_INPUT} input`);
  }
  if (authorization.required !== true || authorization.default !== false) {
    throw new Error(`${path} ${AUTHORIZATION_INPUT} must be required and default to false`);
  }

  // Barrier 3: the release job is gated on the input, the default branch, and a
  // protected environment. The environment is what a workflow-file condition
  // cannot provide, so it is required unconditionally.
  const jobs = isRecord(workflow.jobs) ? Object.entries(workflow.jobs) : [];
  const releaseJob = jobs.find(([, job]) => isRecord(job) && isRecord(job.environment));
  if (!releaseJob) {
    throw new Error(`${path} must bind the release job to the protected ${PROTECTED_ENVIRONMENT} environment`);
  }
  const [jobName, job] = releaseJob;
  if (normalize(job.environment.name) !== PROTECTED_ENVIRONMENT) {
    throw new Error(`${path} job ${jobName} must use the ${PROTECTED_ENVIRONMENT} environment`);
  }
  const guard = typeof job.if === "string" ? job.if : "";
  if (!guard.includes(`${AUTHORIZATION_INPUT} == true`)) {
    throw new Error(`${path} job ${jobName} must require ${AUTHORIZATION_INPUT}`);
  }
  if (!/refs\/heads\/main/.test(guard)) {
    throw new Error(`${path} job ${jobName} must require the default branch`);
  }

  // The release job needs write tokens; that is expected here and nowhere else.
  if (!hasWritePermissions(workflow.permissions) && !hasWritePermissions(job.permissions)) {
    throw new Error(`${path} release job needs contents: write to create the tag and release`);
  }
  if (hasReleasePublishingAction(workflow)) {
    throw new Error(`${path} must create the release with gh, not a third-party publishing action`);
  }

  return true;
}

export function assertProtectedPublishWorkflow(path, content) {
  const workflow = parse(content, { uniqueKeys: true });
  if (!isRecord(workflow)) throw new Error(`${path} is not a workflow mapping`);

  const triggers = triggerKeys(workflow);
  const triggersObject = Object.entries(workflow).find(([key]) => key.toLowerCase() === "on")?.[1];
  if (isRecord(triggersObject)) {
    const push = Object.entries(triggersObject).find(([key]) => normalize(key) === "push")?.[1];
    if (isRecord(push) && push.branches) {
      throw new Error(`${path} must not publish on a branch push`);
    }
  }
  if (!triggers.includes("workflow_dispatch") && !triggers.includes("push") && !triggers.includes("release")) {
    throw new Error(`${path} must have a tag, release, or dispatch trigger`);
  }

  const permissions = isRecord(workflow.permissions) ? workflow.permissions : {};
  if (normalize(permissions["id-token"]) !== "write") {
    throw new Error(`${path} must request id-token: write for Trusted Publishing`);
  }

  const body = activeLines(content);
  if (!/\bnpm\s+publish\b/.test(body)) {
    throw new Error(`${path} must publish the package`);
  }

  return true;
}

export function assertNoPrivilegedPublicationWorkflows(workflows) {
  for (const { path, content } of workflows) {
    if (path === "auto-release.yml") {
      assertProtectedReleaseWorkflow(path, content);
      continue;
    }
    if (path === "publish.yml") {
      assertProtectedPublishWorkflow(path, content);
      continue;
    }
    const body = activeLines(content);
    for (const [label, pattern] of [
      ["npm publication", /\bnpm\s+publish\b/i],
      ["semantic-release publisher", /\bsemantic-release\b/i],
      ["GitHub release creation", /\bgh\s+release\s+create\b/i],
      ["tag creation", /\bgit\s+tag\b/i],
      ["workflow dispatch", /\bgh\s+workflow\s+run\b/i],
    ]) {
      if (pattern.test(body)) {
        throw new Error(`${path} contains ${label}; only the protected release workflow may do that`);
      }
    }
    const workflow = parse(content, { uniqueKeys: true });
    if (isRecord(workflow) && hasReleasePublishingAction(workflow)) {
      throw new Error(`${path} uses a GitHub release-publishing action`);
    }
  }
}
