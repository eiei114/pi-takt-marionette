import assert from "node:assert/strict";
import test from "node:test";

const {
  DEFAULT_MAX_QUEUE_CONTINUATIONS,
  decideQueueContinuation,
  resolveMaxQueueContinuations,
} = await import("../lib/takt-queue-continuation.ts");

const base = {
  queueRunActive: true,
  continuationInFlight: false,
  runnerRunning: false,
  exitCode: 0,
  stage: "completed",
  pending: 3,
  continuationCount: 0,
  maxContinuations: 5,
};

test("queue continuation cap defaults, honors 0, and rejects malformed values", () => {
  assert.equal(resolveMaxQueueContinuations(undefined), DEFAULT_MAX_QUEUE_CONTINUATIONS);
  assert.equal(resolveMaxQueueContinuations(""), DEFAULT_MAX_QUEUE_CONTINUATIONS);
  assert.equal(resolveMaxQueueContinuations("7"), 7);
  assert.equal(resolveMaxQueueContinuations("0"), 0);
  assert.equal(resolveMaxQueueContinuations(" 7 "), 7);
  assert.equal(resolveMaxQueueContinuations("-3"), DEFAULT_MAX_QUEUE_CONTINUATIONS);
  assert.equal(resolveMaxQueueContinuations("many"), DEFAULT_MAX_QUEUE_CONTINUATIONS);
  assert.equal(resolveMaxQueueContinuations("7tasks"), DEFAULT_MAX_QUEUE_CONTINUATIONS);
  assert.equal(resolveMaxQueueContinuations("1e2"), DEFAULT_MAX_QUEUE_CONTINUATIONS);
  assert.equal(resolveMaxQueueContinuations("2.5"), DEFAULT_MAX_QUEUE_CONTINUATIONS);
});

test("a finished queue run with pending tasks continues", () => {
  assert.deepEqual(decideQueueContinuation({ ...base }), {
    continue: true,
    reason: "pending-tasks-remain",
  });
});

test("continuation stops for non-queue runs, live runners, and failures", () => {
  assert.equal(decideQueueContinuation({ ...base, queueRunActive: false }).reason, "not-a-queue-run");
  assert.equal(decideQueueContinuation({ ...base, continuationInFlight: true }).reason, "continuation-in-flight");
  assert.equal(decideQueueContinuation({ ...base, runnerRunning: true }).reason, "runner-still-running");
  assert.equal(decideQueueContinuation({ ...base, exitCode: 1 }).reason, "previous-run-did-not-succeed");
  assert.equal(
    decideQueueContinuation({ ...base, exitCode: undefined }).reason,
    "previous-run-did-not-succeed",
  );
  assert.equal(decideQueueContinuation({ ...base, stage: "stopped" }).reason, "stage-not-completed");
  assert.equal(decideQueueContinuation({ ...base, stage: "failed" }).reason, "stage-not-completed");
});

test("continuation stops when the queue drains or the budget is spent", () => {
  assert.equal(decideQueueContinuation({ ...base, pending: 0 }).reason, "no-pending-tasks");
  assert.equal(
    decideQueueContinuation({ ...base, continuationCount: 5, maxContinuations: 5 }).reason,
    "continuation-limit-reached",
  );
  assert.equal(
    decideQueueContinuation({ ...base, maxContinuations: 0 }).reason,
    "continuation-limit-reached",
  );
  assert.equal(
    decideQueueContinuation({ ...base, continuationCount: 4, maxContinuations: 5 }).continue,
    true,
  );
});
