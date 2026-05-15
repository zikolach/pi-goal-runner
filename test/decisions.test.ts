import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { addPendingDecision, answerDecision } from "../src/decisions.js";
import { defaultSchedule } from "../src/policy.js";
import { createGoalStore } from "../src/state/store.js";
import type { DecisionRecord, GoalRecord } from "../src/types.js";

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-decisions-"));
  return { store: createGoalStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function goal(state: GoalRecord["state"] = "running"): GoalRecord {
  return {
    schemaVersion: 1,
    id: "g",
    type: "github_pr_review",
    state,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    summary: "g",
    schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")),
    runHistory: [],
    pendingDecisions: [],
  };
}

function decision(id: string, required: boolean): DecisionRecord {
  return {
    id,
    goalId: "g",
    prompt: "Choose",
    options: [{ id: "yes", label: "Yes" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "pending",
    required,
  };
}

test("optional pending decisions do not move goals into needs_decision", () => {
  const optional = addPendingDecision(goal(), decision("optional", false));
  assert.equal(optional.state, "active");
  assert.equal(optional.pendingDecisions[0]?.required, false);

  const required = addPendingDecision(goal(), decision("required", true));
  assert.equal(required.state, "needs_decision");
});

test("answering one required decision leaves goals blocked until all required decisions are answered", async () => {
  const t = await tempStore();
  try {
    await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "needs_decision",
      summary: "g",
      schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")),
      pendingDecisions: [decision("one", true), decision("two", true)],
    });

    await answerDecision(t.store, "one", "yes");
    assert.equal((await t.store.get("g")).state, "needs_decision");

    await answerDecision(t.store, "two", "yes");
    assert.equal((await t.store.get("g")).state, "active");
  } finally {
    await t.cleanup();
  }
});
