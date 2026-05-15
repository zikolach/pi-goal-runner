import assert from "node:assert/strict";
import test from "node:test";
import { buildDaemonSuggestionMessage, runSerializedSchedulerTick, shouldSuggestDaemon, splitCompletionPrefix } from "../src/extension.js";

test("extension completion tokenizer preserves trailing empty argument", () => {
  assert.deepEqual(splitCompletionPrefix("status "), ["status", ""]);
  assert.deepEqual(splitCompletionPrefix("  status   "), ["status", ""]);
  assert.deepEqual(splitCompletionPrefix("  "), [""]);
  assert.deepEqual(splitCompletionPrefix("status goal-123"), ["status", "goal-123"]);
});

test("extension scheduler error handler failures are contained", async () => {
  const state = { inFlight: false };
  let handled = 0;
  const started = runSerializedSchedulerTick(
    state,
    async () => {
      throw new Error("tick failed");
    },
    () => {
      handled++;
      throw new Error("notify failed");
    },
  );

  assert.equal(started, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handled, 1);
  assert.equal(state.inFlight, false);
});

test("extension scheduler ticks are serialized", async () => {
  const state = { inFlight: false };
  const errors: unknown[] = [];
  let starts = 0;
  let finishFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });

  const firstStarted = runSerializedSchedulerTick(
    state,
    async () => {
      starts++;
      await firstDone;
    },
    (error) => errors.push(error),
  );
  const secondStarted = runSerializedSchedulerTick(
    state,
    async () => {
      starts++;
    },
    (error) => errors.push(error),
  );

  assert.equal(firstStarted, true);
  assert.equal(secondStarted, false);
  assert.equal(starts, 0);
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.equal(state.inFlight, true);

  finishFirst();
  await firstDone;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.inFlight, false);

  const thirdStarted = runSerializedSchedulerTick(
    state,
    async () => {
      starts++;
    },
    (error) => errors.push(error),
  );
  assert.equal(thirdStarted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  assert.deepEqual(errors, []);
});

test("daemon suggestion helper only recommends for goals the daemon can check", () => {
  assert.equal(shouldSuggestDaemon([]), false);
  assert.equal(
    shouldSuggestDaemon([
      { schemaVersion: 1, id: "a", type: "github_pr_review", state: "completed", createdAt: "", updatedAt: "", summary: "", schedule: { nextCheckAt: "", backoff: { initialMs: 1, maxMs: 1, multiplier: 1, currentMs: 1 }, quietWindow: { durationMs: 1, onExpire: "completed" } }, runHistory: [], pendingDecisions: [] },
      { schemaVersion: 1, id: "b", type: "github_pr_review", state: "paused", createdAt: "", updatedAt: "", summary: "", schedule: { nextCheckAt: "", backoff: { initialMs: 1, maxMs: 1, multiplier: 1, currentMs: 1 }, quietWindow: { durationMs: 1, onExpire: "completed" } }, runHistory: [], pendingDecisions: [] },
      { schemaVersion: 1, id: "d", type: "github_pr_review", state: "needs_decision", createdAt: "", updatedAt: "", summary: "", schedule: { nextCheckAt: "", backoff: { initialMs: 1, maxMs: 1, multiplier: 1, currentMs: 1 }, quietWindow: { durationMs: 1, onExpire: "completed" } }, runHistory: [], pendingDecisions: [] },
      { schemaVersion: 1, id: "e", type: "github_pr_review", state: "active", createdAt: "", updatedAt: "", summary: "", schedule: { nextCheckAt: "", backoff: { initialMs: 1, maxMs: 1, multiplier: 1, currentMs: 1 }, quietWindow: { durationMs: 1, onExpire: "completed" } }, runHistory: [], pendingDecisions: [{ id: "decision", goalId: "e", prompt: "?", options: [], createdAt: "", status: "pending", required: true }], },
    ]),
    false,
  );
  assert.equal(
    shouldSuggestDaemon([
      { schemaVersion: 1, id: "c", type: "github_pr_review", state: "active", createdAt: "", updatedAt: "", summary: "", schedule: { nextCheckAt: "", backoff: { initialMs: 1, maxMs: 1, multiplier: 1, currentMs: 1 }, quietWindow: { durationMs: 1, onExpire: "completed" } }, runHistory: [], pendingDecisions: [] },
    ]),
    true,
  );
  assert.match(buildDaemonSuggestionMessage(2), /2 active goals/);
  assert.match(buildDaemonSuggestionMessage(1), /1 active goal\)/);
});
