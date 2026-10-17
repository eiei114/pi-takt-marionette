const blockedPatterns = [
  ["manual workflow dispatch", /^\s*workflow_dispatch\s*:/m],
  ["write-capable workflow token", /^\s*(?:actions|contents|deployments|id-token|packages):\s*write\s*$/m],
  ["write-all workflow token", /^\s*permissions:\s*write-all\s*$/m],
  ["npm publication", /\bnpm\s+publish\b/i],
  ["GitHub release creation", /\bgh\s+release\s+create\b/i],
  ["tag creation", /\bgit\s+tag\b/i],
  ["workflow dispatch", /\bgh\s+workflow\s+run\b/i],
];

export function assertNoPrivilegedPublicationWorkflows(workflows) {
  for (const { path, content } of workflows) {
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
