import assert from "node:assert/strict";
import test from "node:test";

const {
  assertValidTaktTaskExecutionPolicy,
  formatTaktTaskExecutionPolicy,
  toTaktTaskFileOptions,
} = await import("../lib/takt-task-policy.ts");

test("task policy maps no PR to explicit task-file options", () => {
  assert.deepEqual(toTaktTaskFileOptions({ worktree: true, prMode: "none" }), {
    worktree: true,
    autoPr: false,
    draftPr: false,
  });
});

test("task policy maps regular and draft PR modes", () => {
  assert.deepEqual(toTaktTaskFileOptions({ worktree: true, prMode: "regular" }), {
    worktree: true,
    autoPr: true,
    draftPr: false,
  });
  assert.deepEqual(toTaktTaskFileOptions({ worktree: true, prMode: "draft" }), {
    worktree: true,
    autoPr: true,
    draftPr: true,
  });
  assert.equal(
    formatTaktTaskExecutionPolicy({ worktree: true, prMode: "draft" }),
    "worktree: yes; PR: draft PR",
  );
});

test("task policy rejects PR delivery without an isolated worktree", () => {
  assert.throws(
    () => assertValidTaktTaskExecutionPolicy({ worktree: false, prMode: "regular" }),
    /PR requires worktree: true/i,
  );
});

test("task policy rejects an omitted or unknown selection", () => {
  assert.throws(
    () => assertValidTaktTaskExecutionPolicy(undefined),
    /selected explicitly/i,
  );
  assert.throws(
    () => assertValidTaktTaskExecutionPolicy({ worktree: true, prMode: "future" }),
    /selected explicitly/i,
  );
});
