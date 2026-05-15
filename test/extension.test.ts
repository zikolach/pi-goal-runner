import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import goalRunnerExtension, { buildDaemonSuggestionMessage, runSerializedSchedulerTick, shouldSuggestDaemon, splitCompletionPrefix } from "../src/extension.js";
import { defaultSchedule } from "../src/policy.js";
import { createGoalStore } from "../src/state/store.js";

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
  assert.match(buildDaemonSuggestionMessage(1), /npm run goal -- daemon/);
});

test("extension shutdown reminds for stored daemon-eligible goals only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-extension-"));
  const previousStateDir = process.env.PI_GOAL_STATE_DIR;
  const originalStderrWrite = process.stderr.write;
  const notifications: Array<{ message: string; type?: string }> = [];
  const stderrWrites: string[] = [];
  const handlers: Record<string, (event: unknown, ctx: { cwd: string; ui: { notify(message: string, type?: "info" | "success" | "warning" | "error"): void } }) => Promise<void> | void> = {};
  try {
    process.env.PI_GOAL_STATE_DIR = dir;
    process.stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      stderrWrites.push(String(chunk));
      if (typeof encoding === "function") encoding();
      if (typeof callback === "function") callback();
      return true;
    }) as typeof process.stderr.write;

    const store = createGoalStore(dir);
    await store.create({ id: "paused", type: "github_pr_review", state: "paused", summary: "paused", schedule: defaultSchedule() });
    await store.create({
      id: "decision",
      type: "github_pr_review",
      state: "needs_decision",
      summary: "decision",
      schedule: defaultSchedule(),
      pendingDecisions: [{ id: "d", goalId: "decision", prompt: "Choose", options: [{ id: "x", label: "X" }], createdAt: "", status: "pending", required: true }],
    });

    goalRunnerExtension({
      registerCommand() {},
      on(event, handler) {
        handlers[event] = handler;
      },
    });
    const ctx = { cwd: process.cwd(), ui: { notify: (message: string, type?: "info" | "success" | "warning" | "error") => notifications.push({ message, type }) } };
    assert.ok(handlers.session_shutdown);

    await handlers.session_shutdown({}, ctx);
    assert.deepEqual(notifications, []);
    assert.deepEqual(stderrWrites, []);

    await store.create({ id: "active", type: "github_pr_review", state: "active", summary: "active", schedule: defaultSchedule() });
    await handlers.session_shutdown({}, ctx);

    assert.equal(notifications.length, 1);
    const notification = notifications[0] as { message: string; type?: string };
    assert.equal(notification.type, "info");
    assert.match(notification.message, /1 active goal\)/);
    assert.equal(stderrWrites.length, 1);
    assert.match(stderrWrites[0] ?? "", /npm run goal -- daemon/);
  } finally {
    process.stderr.write = originalStderrWrite;
    if (previousStateDir === undefined) delete process.env.PI_GOAL_STATE_DIR;
    else process.env.PI_GOAL_STATE_DIR = previousStateDir;
    await rm(dir, { recursive: true, force: true });
  }
});
