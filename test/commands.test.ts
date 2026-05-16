import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { handleGoalCommand, handleGoalCommandArgs, splitArgs } from "../src/commands.js";
import { createGoalStore } from "../src/state/store.js";
import { acquireGoalLock } from "../src/state/lock.js";
import { defaultSchedule } from "../src/policy.js";

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-cmd-"));
  return { store: createGoalStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("splitArgs handles quotes", () => {
  assert.deepEqual(splitArgs('watch-pr owner/repo 1 --validation "npm test"'), ["watch-pr", "owner/repo", "1", "--validation", "npm test"]);
  assert.deepEqual(splitArgs("--foo 'two words' --bar"), ["--foo", "two words", "--bar"]);
});

test("list/status/pause/resume/cancel commands produce safe output", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g1", type: "github_pr_review", state: "active", summary: "Watch PR", schedule: defaultSchedule() });
    assert.match(await handleGoalCommand(t.store, "list"), /g1/);
    assert.match(await handleGoalCommand(t.store, "status g1"), /State: active/);
    assert.match(await handleGoalCommand(t.store, "pause g1"), /paused/);
    assert.match(await handleGoalCommand(t.store, "resume g1"), /active/);
    assert.match(await handleGoalCommand(t.store, "cancel g1"), /cancelled/);
  } finally {
    await t.cleanup();
  }
});

test("decisions and answers validate choices", async () => {
  const t = await tempStore();
  try {
    await t.store.create({
      id: "g1",
      type: "github_pr_review",
      state: "needs_decision",
      summary: "Watch PR",
      schedule: defaultSchedule(),
      pendingDecisions: [{ id: "d1", goalId: "g1", prompt: "Pick", options: [{ id: "yes", label: "Yes" }], createdAt: new Date().toISOString(), status: "pending", required: true }],
    });
    assert.match(await handleGoalCommand(t.store, "decisions"), /d1/);
    await assert.rejects(() => handleGoalCommand(t.store, "answer d1 no"), /Invalid choice/);
    assert.match(await handleGoalCommand(t.store, "answer d1 yes"), /Answered/);
    assert.match(await handleGoalCommand(t.store, "decisions"), /No pending/);
  } finally {
    await t.cleanup();
  }
});

test("ui command has a non-interactive fallback for CLI callers", async () => {
  const t = await tempStore();
  try {
    assert.match(await handleGoalCommand(t.store, "ui"), /requires an interactive Pi session/);
    assert.match(await handleGoalCommandArgs(t.store, ["ui"]), /\/goals inside Pi/);
  } finally {
    await t.cleanup();
  }
});

test("state-mutating commands respect active goal locks", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g1", type: "github_pr_review", state: "active", summary: "Watch PR", schedule: defaultSchedule() });
    const lock = await acquireGoalLock(t.store.paths, "g1");
    assert.ok(lock);
    try {
      assert.match(await handleGoalCommand(t.store, "pause g1"), /goal is busy/);
      assert.equal((await t.store.get("g1")).state, "active");
    } finally {
      await lock.release();
    }
    assert.match(await handleGoalCommand(t.store, "pause g1"), /paused/);
  } finally {
    await t.cleanup();
  }
});

test("state-mutating commands do not create unknown goal directories", async () => {
  const t = await tempStore();
  try {
    await t.store.init();
    await assert.rejects(() => handleGoalCommand(t.store, "pause missing-goal"), /Unknown goal: missing-goal/);
    await assert.rejects(() => stat(t.store.paths.goalDir("missing-goal")), /ENOENT/);
  } finally {
    await t.cleanup();
  }
});

test("answer command respects active goal locks", async () => {
  const t = await tempStore();
  try {
    await t.store.create({
      id: "g1",
      type: "github_pr_review",
      state: "needs_decision",
      summary: "Watch PR",
      schedule: defaultSchedule(),
      pendingDecisions: [{ id: "d1", goalId: "g1", prompt: "Pick", options: [{ id: "yes", label: "Yes" }], createdAt: new Date().toISOString(), status: "pending", required: true }],
    });
    const lock = await acquireGoalLock(t.store.paths, "g1");
    assert.ok(lock);
    try {
      await assert.rejects(() => handleGoalCommand(t.store, "answer d1 yes"), /busy/);
      assert.equal((await t.store.get("g1")).pendingDecisions[0]?.status, "pending");
    } finally {
      await lock.release();
    }
    assert.match(await handleGoalCommand(t.store, "answer d1 yes"), /Answered/);
  } finally {
    await t.cleanup();
  }
});

test("watch-pr validates quiet window option before creating goals", async () => {
  const t = await tempStore();
  try {
    await assert.rejects(() => handleGoalCommand(t.store, "watch-pr owner/repo 1 --quiet-ms nope"), /quiet ms must be a finite non-negative number/);
    await assert.rejects(() => handleGoalCommand(t.store, "watch-pr owner/repo 1 --quiet-ms -1"), /quiet ms must be a finite non-negative number/);
  } finally {
    await t.cleanup();
  }
});

test("watch-pr preserves zero quiet window option", async () => {
  const t = await tempStore();
  try {
    const gh = { run: async (args: string[]) => (args[0] === "auth" ? "" : JSON.stringify({ url: "https://github.com/owner/repo/pull/1", headRefName: "branch", baseRefName: "main" })) };
    const output = await handleGoalCommand(t.store, "watch-pr owner/repo 1 --quiet-ms 0", { gh });
    const goalId = output.match(/Created (\S+):/)?.[1];
    assert.ok(goalId);
    assert.equal((await t.store.get(goalId)).schedule.quietWindow.durationMs, 0);
  } finally {
    await t.cleanup();
  }
});

test("watch-pr args entrypoint preserves shell-quoted argv token boundaries", async () => {
  const t = await tempStore();
  try {
    const gh = { run: async (args: string[]) => (args[0] === "auth" ? "" : JSON.stringify({ url: "https://github.com/owner/repo/pull/1", headRefName: "branch", baseRefName: "main" })) };
    const output = await handleGoalCommandArgs(t.store, ["watch-pr", "owner/repo", "1", "--validation", "npm test"], { gh });
    const goalId = output.match(/Created (\S+):/)?.[1];
    assert.ok(goalId);
    assert.deepEqual((await t.store.get(goalId)).github?.validationCommands, ["npm test"]);
  } finally {
    await t.cleanup();
  }
});
