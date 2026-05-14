import assert from "node:assert/strict";
import test from "node:test";
import { runSerializedSchedulerTick, splitCompletionPrefix } from "../src/extension.js";

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
