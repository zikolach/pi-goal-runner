import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireGoalLock } from "../src/state/lock.js";
import { createGoalStore } from "../src/state/store.js";
import { defaultSchedule } from "../src/policy.js";
import { cancelGoal, getGoalActionAvailability, pauseGoal, resumeGoal } from "../src/goal-operations.js";

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-manager-ops-"));
  return { store: createGoalStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("goal action availability reflects lifecycle and decision constraints", () => {
  const baseGoal = {
    schemaVersion: 1 as const,
    id: "g",
    type: "github_pr_review" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    summary: "goal",
    schedule: defaultSchedule(new Date("2026-01-01T00:00:00.000Z")),
    runHistory: [],
    pendingDecisions: [],
  };

  assert.deepEqual(getGoalActionAvailability({ ...baseGoal, state: "active" }), { canPause: true, canResume: false, canCancel: true, canRunNow: true });
  assert.deepEqual(getGoalActionAvailability({ ...baseGoal, state: "paused" }), { canPause: false, canResume: true, canCancel: true, canRunNow: false });
  assert.deepEqual(getGoalActionAvailability({ ...baseGoal, state: "running" }), { canPause: false, canResume: false, canCancel: false, canRunNow: false });
  assert.deepEqual(getGoalActionAvailability({ ...baseGoal, state: "completed" }), { canPause: false, canResume: false, canCancel: false, canRunNow: false });
  assert.deepEqual(getGoalActionAvailability({ ...baseGoal, state: "dormant" }), { canPause: false, canResume: false, canCancel: false, canRunNow: false });
  assert.deepEqual(getGoalActionAvailability({ ...baseGoal, state: "cancelled" }), { canPause: false, canResume: false, canCancel: false, canRunNow: false });
  assert.deepEqual(getGoalActionAvailability({ ...baseGoal, state: "failed" }), { canPause: true, canResume: false, canCancel: true, canRunNow: true });
  assert.deepEqual(
    getGoalActionAvailability({
      ...baseGoal,
      state: "needs_decision",
      pendingDecisions: [{ id: "d", goalId: "g", prompt: "x", options: [], createdAt: "", status: "pending", required: true }],
    }),
    { canPause: true, canResume: false, canCancel: true, canRunNow: false },
  );
});

test("pause/resume/cancel helpers update state under lock", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g1", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await t.store.create({ id: "g2", type: "github_pr_review", state: "paused", summary: "g", schedule: defaultSchedule() });
    await t.store.create({ id: "g3", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });

    const paused = await pauseGoal(t.store, "g1");
    assert.equal(paused.ok, true);
    assert.equal((await t.store.get("g1")).state, "paused");

    const resumed = await resumeGoal(t.store, "g1");
    assert.equal(resumed.ok, true);
    assert.equal((await t.store.get("g1")).state, "active");

    const cancelled = await cancelGoal(t.store, "g2");
    assert.equal(cancelled.ok, true);
    assert.equal((await t.store.get("g2")).state, "cancelled");

    const lock = await acquireGoalLock(t.store.paths, "g1");
    assert(lock !== undefined, "expected goal lock");
    try {
      const blocked = await pauseGoal(t.store, "g1");
      assert.equal(blocked.ok, false);
      assert.equal(blocked.busy, true);
      assert.equal(blocked.reason, "goal is busy; try again later");
      assert.equal((await t.store.get("g1")).state, "active");
    } finally {
      await lock.release();
    }
  } finally {
    await t.cleanup();
  }
});

// No explicit state transition guards in shared helpers yet; lock semantics are the safety layer.
