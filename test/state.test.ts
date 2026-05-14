import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoalId, createGoalStore } from "../src/state/store.js";
import { appendGoalEvent, parseWorkerEventLine } from "../src/state/events.js";
import { acquireGoalLock, DEFAULT_GOAL_LOCK_STALE_MS } from "../src/state/lock.js";
import { replaceFile, writeJsonAtomic } from "../src/state/json.js";
import { defaultStateRoot, sanitizeGoalId } from "../src/state/paths.js";
import { applyNoActionPolicy, defaultSchedule, increaseBackoff, quietWindowExpired } from "../src/policy.js";
import { DEFAULT_WORKER_TIMEOUT_MS } from "../src/worker/subprocess.js";
import { redactText } from "../src/redaction.js";

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-"));
  return { dir, store: createGoalStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("blank state root env falls back to the home state directory", () => {
  const original = process.env.PI_GOAL_STATE_DIR;
  try {
    delete process.env.PI_GOAL_STATE_DIR;
    const fallback = path.join(homedir(), ".pi", "agent", "goals");
    assert.equal(defaultStateRoot(), fallback);
    process.env.PI_GOAL_STATE_DIR = "";
    assert.equal(defaultStateRoot(), fallback);
    process.env.PI_GOAL_STATE_DIR = "   \t";
    assert.equal(defaultStateRoot(), fallback);
    process.env.PI_GOAL_STATE_DIR = "/tmp/pi-goals";
    assert.equal(defaultStateRoot(), "/tmp/pi-goals");
  } finally {
    if (original === undefined) delete process.env.PI_GOAL_STATE_DIR;
    else process.env.PI_GOAL_STATE_DIR = original;
  }
});

test("generated goal ids use random UUIDs", () => {
  const id = createGoalId("pr");
  assert.match(id, /^pr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.notEqual(createGoalId("pr"), createGoalId("pr"));
});

test("creating a goal never overwrites an existing goal directory", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe" });
    await assert.rejects(() => t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "collision" }), /Goal already exists: goal-1/);
    assert.equal((await t.store.get("goal-1")).summary, "safe");
  } finally {
    await t.cleanup();
  }
});

test("creates, lists, gets, and updates goals", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe" });
    assert.equal(goal.id, "goal-1");
    assert.ok(goal.schedule.nextCheckAt);
    assert.equal((await t.store.list()).length, 1);
    await t.store.setState("goal-1", "paused");
    assert.equal((await t.store.get("goal-1")).state, "paused");
  } finally {
    await t.cleanup();
  }
});

test("list ignores goals with incomplete required fields", async () => {
  const t = await tempStore();
  try {
    const valid = await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe", schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")) });
    await writeJsonAtomic(t.store.paths.stateFile("missing-created-at"), {
      schemaVersion: 1,
      id: "missing-created-at",
      type: "github_pr_review",
      state: "active",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summary: "incomplete",
      schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")),
      runHistory: [],
      pendingDecisions: [],
    });
    await writeJsonAtomic(t.store.paths.stateFile("invalid-created-at"), {
      schemaVersion: 1,
      id: "invalid-created-at",
      type: "github_pr_review",
      state: "active",
      createdAt: 123,
      updatedAt: "2026-01-01T00:00:00.000Z",
      summary: "incomplete",
      schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")),
      runHistory: [],
      pendingDecisions: [],
    });

    assert.deepEqual((await t.store.list()).map((goal) => goal.id), [valid.id]);
  } finally {
    await t.cleanup();
  }
});

test("state directories are created with restrictive permissions", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe", schedule: defaultSchedule() });
    if (process.platform !== "win32") {
      assert.equal((await stat(t.store.paths.worktreesDir)).mode & 0o777, 0o700);
      assert.equal((await stat(t.store.paths.goalDir("goal-1"))).mode & 0o777, 0o700);
    }
  } finally {
    await t.cleanup();
  }
});

test("existing state directories are tightened to restrictive permissions", async () => {
  if (process.platform === "win32") return;
  const t = await tempStore();
  try {
    await mkdir(t.store.paths.worktreesDir, { recursive: true });
    await chmod(t.store.paths.worktreesDir, 0o755);
    await t.store.init();
    assert.equal((await stat(t.store.paths.worktreesDir)).mode & 0o777, 0o700);
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

test("windows file replacement restores the previous file on rename failure", async () => {
  const t = await tempStore();
  try {
    const file = path.join(t.dir, "state.json");
    const temp = path.join(t.dir, ".state.json.tmp");
    await writeFile(file, "old", "utf8");
    await writeFile(temp, "new", "utf8");
    await assert.rejects(
      () => replaceFile(temp, file, {
        windows: true,
        ops: {
          rename: async (source, destination) => {
            if (source === temp && destination === file) {
              throw Object.assign(new Error("simulated rename failure"), { code: "EPERM" });
            }
            await rename(source, destination);
          },
          rm,
        },
      }),
      /simulated rename failure/,
    );
    assert.equal(await readFile(file, "utf8"), "old");
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

test("append event log tightens existing file permissions", async () => {
  if (process.platform === "win32") return;
  const t = await tempStore();
  try {
    await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe", schedule: defaultSchedule() });
    await writeFile(t.store.paths.eventsFile("goal-1"), "", "utf8");
    await chmod(t.store.paths.eventsFile("goal-1"), 0o644);
    await appendGoalEvent(t.store.paths, { type: "progress", goalId: "goal-1", timestamp: new Date().toISOString(), message: "hi" });
    assert.equal((await stat(t.store.paths.eventsFile("goal-1"))).mode & 0o777, 0o600);
  } finally {
    await t.cleanup();
  }
});

test("worker validation results are bounded and field-limited", () => {
  const results = Array.from({ length: 25 }, (_, index) => ({
    command: `npm test ${index} ghp_1234567890123456789012345 ${"x".repeat(600)}`,
    status: index === 0 ? "failed" : "passed",
    output: `token sk-abcdefghijklmnopqrstuvwxyz ${"y".repeat(3_000)}`,
  }));
  const event = parseWorkerEventLine("goal-1", "run-1", JSON.stringify({ type: "complete", validationResults: results }));
  assert.equal(event.type, "complete");
  if (event.type === "complete") {
    assert.equal(event.validationResults?.length, 20);
    assert.equal(event.validationResults?.[0]?.status, "failed");
    assert.ok((event.validationResults?.[0]?.command.length ?? 0) <= 513);
    assert.ok((event.validationResults?.[0]?.output?.length ?? 0) <= 2_013);
    assert.doesNotMatch(event.validationResults?.[0]?.command ?? "", /ghp_/);
    assert.doesNotMatch(event.validationResults?.[0]?.output ?? "", /sk-/);
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

test("goal updates can preserve an explicit unchanged updatedAt", async () => {
  const t = await tempStore();
  try {
    const updatedAt = "2026-01-01T00:00:00.000Z";
    await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe", schedule: defaultSchedule(), updatedAt });
    await t.store.update("goal-1", (goal) => ({ ...goal, summary: "changed", updatedAt }), { updatedAt });
    assert.equal((await t.store.get("goal-1")).updatedAt, updatedAt);
  } finally {
    await t.cleanup();
  }
});

test("redaction does not leak regex offsets for token patterns", () => {
  assert.equal(redactText("token ghp_1234567890123456789012345"), "token [REDACTED]");
  assert.equal(redactText("API_TOKEN=secret-value"), "API_TOKEN=[REDACTED]");
  assert.equal(redactText("curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz'"), "curl -H 'Authorization: Bearer [REDACTED]'");
});

test("redaction tolerates values that JSON cannot serialize", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(redactText(1n), "1");
  assert.equal(redactText(circular), "[object Object]");
});

test("default lock staleness exceeds the default worker timeout", () => {
  assert.ok(DEFAULT_GOAL_LOCK_STALE_MS > DEFAULT_WORKER_TIMEOUT_MS);
});

test("per-goal locks exclude concurrent holders", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "goal-1", type: "github_pr_review", state: "active", summary: "safe", schedule: defaultSchedule() });
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

test("acquiring a lock for an unknown goal does not create a goal directory", async () => {
  const t = await tempStore();
  try {
    await t.store.init();
    await assert.rejects(() => acquireGoalLock(t.store.paths, "missing-goal"), /Unknown goal: missing-goal/);
    await assert.rejects(() => stat(t.store.paths.goalDir("missing-goal")), /ENOENT/);
  } finally {
    await t.cleanup();
  }
});

test("locks owned by a live pid are not treated as stale", async () => {
  const t = await tempStore();
  try {
    const lockDir = t.store.paths.lockDir("goal-1");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: "1970-01-01T00:00:00.000Z" }), "utf8");
    const recovered = await acquireGoalLock(t.store.paths, "goal-1", 0);
    assert.equal(recovered, undefined);
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
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 999999999, createdAt: "not-a-date" }), "utf8");
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
