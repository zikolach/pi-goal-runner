import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getGoalAdapter, getGoalDisplayMetadata } from "../src/adapters/registry.js";
import { defaultSchedule } from "../src/policy.js";
import { schedulerTick } from "../src/scheduler.js";
import { createGoalStore } from "../src/state/store.js";

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-adapter-"));
  return { store: createGoalStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("adapter registry exposes the built-in GitHub PR adapter", () => {
  const adapter = getGoalAdapter("github_pr_review");
  assert.equal(adapter?.type, "github_pr_review");
  assert.equal(typeof adapter?.observe, "function");
  assert.equal(typeof adapter?.analyze, "function");
  assert.equal(typeof adapter?.prepareWorker, "function");
  assert.equal(typeof adapter?.handleSuccessfulCompletion, "function");
});

test("unsupported goal adapter failures are recorded without crashing the scheduler", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g", type: "unknown_goal" as never, state: "active", summary: "g", schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")) });
    const result = await schedulerTick(t.store, { now: new Date("2026-01-01T00:00:00Z"), worker: { dryRun: true } });
    const goal = await t.store.get("g");
    const events = await readFile(t.store.paths.eventsFile("g"), "utf8");
    assert.equal(result.checked, 1);
    assert.equal(result.failures, 1);
    assert.equal(goal.state, "failed");
    assert.match(goal.latestProgress ?? "", /Unsupported goal type: unknown_goal/);
    assert.match(events, /Unsupported goal type: unknown_goal/);
  } finally {
    await t.cleanup();
  }
});

test("display metadata falls back safely when no adapter exists", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "unknown_goal" as never, state: "active", summary: "g" });
    assert.deepEqual(getGoalDisplayMetadata(goal), {});
  } finally {
    await t.cleanup();
  }
});

test("GitHub PR adapter display metadata exposes target and workspace", () => {
  const metadata = getGoalDisplayMetadata({
    schemaVersion: 1,
    id: "g",
    type: "github_pr_review",
    state: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    summary: "g",
    schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")),
    runHistory: [],
    pendingDecisions: [],
    github: {
      repository: { owner: "o", repo: "r", branch: "feature", worktreePath: "/tmp/wt" },
      prNumber: 7,
      validationCommands: [],
      autoReplyAndResolve: false,
      handledThreadIds: [],
      handledCheckNames: [],
    },
  });
  assert.equal(metadata.target, "o/r#7");
  assert.equal(metadata.workspace, "/tmp/wt");
  assert.deepEqual(metadata.details?.map((detail) => detail.label), ["Repository", "PR", "Branch"]);
});
