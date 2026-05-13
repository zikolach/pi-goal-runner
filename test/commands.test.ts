import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { handleGoalCommand, splitArgs } from "../src/commands.js";
import { createGoalStore } from "../src/state/store.js";
import { defaultSchedule } from "../src/policy.js";

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-cmd-"));
  return { store: createGoalStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("splitArgs handles quotes", () => {
  assert.deepEqual(splitArgs('watch-pr owner/repo 1 --validation "npm test"'), ["watch-pr", "owner/repo", "1", "--validation", "npm test"]);
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

test("watch-pr validates quiet window option before creating goals", async () => {
  const t = await tempStore();
  try {
    await assert.rejects(() => handleGoalCommand(t.store, "watch-pr owner/repo 1 --quiet-ms nope"), /quiet ms must be a finite non-negative number/);
    await assert.rejects(() => handleGoalCommand(t.store, "watch-pr owner/repo 1 --quiet-ms -1"), /quiet ms must be a finite non-negative number/);
  } finally {
    await t.cleanup();
  }
});
