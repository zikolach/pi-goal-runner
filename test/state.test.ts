import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoalStore } from "../src/state/store.js";
import { appendGoalEvent, parseWorkerEventLine } from "../src/state/events.js";
import { acquireGoalLock } from "../src/state/lock.js";
import { writeJsonAtomic } from "../src/state/json.js";
import { sanitizeGoalId } from "../src/state/paths.js";
import { applyNoActionPolicy, defaultSchedule, increaseBackoff, quietWindowExpired } from "../src/policy.js";
import { redactText } from "../src/redaction.js";

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

test("create defaults are not clobbered by undefined option fields", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({
      id: "goal-1",
      type: "github_pr_review",
      state: "active",
      summary: "safe",
      createdAt: undefined,
      updatedAt: undefined,
      runHistory: undefined,
      pendingDecisions: undefined,
      schedule: undefined,
    } as any);
    assert.equal(typeof goal.createdAt, "string");
    assert.equal(typeof goal.updatedAt, "string");
    assert.deepEqual(goal.runHistory, []);
    assert.deepEqual(goal.pendingDecisions, []);
    assert.ok(goal.schedule.nextCheckAt);
  } finally {
    await t.cleanup();
  }
});

test("atomic json writes can replace an existing file", async () => {
  const t = await tempStore();
  try {
    const file = path.join(t.dir, "state.json");
    await writeJsonAtomic(file, { value: 1 });
    await writeJsonAtomic(file, { value: 2 });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { value: 2 });
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

test("malformed decision options are normalized safely", () => {
  const event = parseWorkerEventLine("goal-1", "run-1", JSON.stringify({ type: "decision", decision: { id: "d", prompt: "Pick", options: [null, "bad", { id: "ok", label: "Okay" }] } }));
  assert.equal(event.type, "decision");
  if (event.type === "decision") {
    assert.deepEqual(event.decision.options, [
      { id: "option-1", label: "" },
      { id: "option-2", label: "" },
      { id: "ok", label: "Okay" },
    ]);
  }
});

test("goal ids reject traversal segments", () => {
  assert.equal(sanitizeGoalId("goal-1"), "goal-1");
  assert.throws(() => sanitizeGoalId("."), /Invalid goal id/);
  assert.throws(() => sanitizeGoalId(".."), /Invalid goal id/);
  assert.throws(() => sanitizeGoalId("goal..1"), /Invalid goal id/);
  assert.throws(() => sanitizeGoalId("/absolute"), /Invalid goal id/);
  assert.throws(() => sanitizeGoalId("worktrees"), /Invalid goal id/);
  assert.throws(() => sanitizeGoalId("Worktrees"), /Invalid goal id/);
});

test("goal updates preserve explicit updatedAt from updater", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe", schedule: defaultSchedule(), updatedAt: "2026-01-01T00:00:00.000Z" });
    await t.store.update("goal-1", (goal) => ({ ...goal, summary: "changed", updatedAt: "2026-02-01T00:00:00.000Z" }));
    assert.equal((await t.store.get("goal-1")).updatedAt, "2026-02-01T00:00:00.000Z");
  } finally {
    await t.cleanup();
  }
});

test("redaction does not leak regex offsets for token patterns", () => {
  assert.equal(redactText("token ghp_1234567890123456789012345"), "token [REDACTED]");
  assert.equal(redactText("API_TOKEN=secret-value"), "API_TOKEN=[REDACTED]");
});

test("redaction tolerates values that JSON cannot serialize", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(redactText(1n), "1");
  assert.equal(redactText(circular), "[object Object]");
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

test("stale locks recover when owner metadata is missing", async () => {
  const t = await tempStore();
  try {
    await mkdir(t.store.paths.lockDir("goal-1"), { recursive: true });
    const recovered = await acquireGoalLock(t.store.paths, "goal-1", 0);
    assert.ok(recovered);
    await recovered.release();
  } finally {
    await t.cleanup();
  }
});

test("stale locks recover when owner metadata has an invalid createdAt", async () => {
  const t = await tempStore();
  try {
    const lockDir = t.store.paths.lockDir("goal-1");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 123, createdAt: "not-a-date" }), "utf8");
    const recovered = await acquireGoalLock(t.store.paths, "goal-1", 0);
    assert.ok(recovered);
    await recovered.release();
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
