export const TAKT_PR_MODES = ["none", "regular", "draft"] as const;

export type TaktPrMode = (typeof TAKT_PR_MODES)[number];

export interface TaktTaskExecutionPolicy {
  worktree: boolean;
  prMode: TaktPrMode;
}

export interface TaktTaskFileOptions {
  worktree: boolean;
  autoPr: boolean;
  draftPr: boolean;
}

export function assertValidTaktTaskExecutionPolicy(
  policy: TaktTaskExecutionPolicy | undefined,
): asserts policy is TaktTaskExecutionPolicy {
  if (!policy || typeof policy.worktree !== "boolean" || !isTaktPrMode(policy.prMode)) {
    throw new Error("TAKT task execution policy must be selected explicitly: worktree and PR mode are required");
  }
  if (!policy.worktree && policy.prMode !== "none") {
    throw new Error("Regular or draft PR requires worktree: true; choose no PR for project-checkout execution");
  }
}

export function isTaktPrMode(value: unknown): value is TaktPrMode {
  return typeof value === "string" && (TAKT_PR_MODES as readonly string[]).includes(value);
}

export function toTaktTaskFileOptions(policy: TaktTaskExecutionPolicy): TaktTaskFileOptions {
  assertValidTaktTaskExecutionPolicy(policy);
  return {
    worktree: policy.worktree,
    autoPr: policy.prMode !== "none",
    draftPr: policy.prMode === "draft",
  };
}

export function formatTaktPrMode(mode: TaktPrMode): string {
  switch (mode) {
    case "none":
      return "no PR";
    case "regular":
      return "regular PR";
    case "draft":
      return "draft PR";
  }
}

export function formatTaktTaskExecutionPolicy(policy: TaktTaskExecutionPolicy): string {
  return `worktree: ${policy.worktree ? "yes" : "no"}; PR: ${formatTaktPrMode(policy.prMode)}`;
}
