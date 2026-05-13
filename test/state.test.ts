import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoalStore } from "../src/state/store.js";
import { appendGoalEvent, parseWorkerEventLine } from "../src/state/events.js";
import { acquireGoalLock } from "../src/state/lock.js";
import { applyNoActionPolicy, defaultSchedule, increaseBackoff, quietWindowExpired } from "../src/policy.js";

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-"));
  return { dir, store: createGoalStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("creates, lists, gets, and updates goals", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe", schedule: defaultSchedule() });
    assert.equal(goal.id, "goal-1");
    assert.equal((await t.store.list()).length, 1);
    await t.store.setState("goal-1", "paused");
    assert.equal((await t.store.get("goal-1")).state, "paused");
  } finally {
    await t.cleanup();
  }
});

test("append event log redacts secrets and parses malformed events safely", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe", schedule: defaultSchedule() });
    const event = parseWorkerEventLine("goal-1", "run-1", "not json ghp_1234567890123456789012345");
    assert.equal(event.type, "diagnostic");
    await appendGoalEvent(t.store.paths, event);
  } finally {
    await t.cleanup();
  }
});

test("per-goal locks exclude concurrent holders", async () => {
  const t = await tempStore();
  try {
    await t.store.init();
    const first = await acquireGoalLock(t.store.paths, "goal-1");
    assert.ok(first);
    const second = await acquireGoalLock(t.store.paths, "goal-1");
    assert.equal(second, undefined);
    await first.release();
    assert.ok(await acquireGoalLock(t.store.paths, "goal-1"));
  } finally {
    await t.cleanup();
  }
});

test("backoff grows and quiet window expires", async () => {
  const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
  const backoff = increaseBackoff(schedule.backoff);
  assert.equal(backoff.currentMs, 120_000);
  schedule.quietWindow.quietSince = "2026-01-01T00:00:00Z";
  assert.equal(quietWindowExpired(schedule.quietWindow, new Date("2026-01-01T03:00:00Z")), true);
  const updated = applyNoActionPolicy({ schemaVersion: 1, id: "g", type: "github_pr_review", state: "active", createdAt: "", updatedAt: "", summary: "", schedule, runHistory: [], pendingDecisions: [] }, "2026-01-01T00:00:00Z", new Date("2026-01-01T03:00:00Z"));
  assert.equal(updated.state, "completed");
});
