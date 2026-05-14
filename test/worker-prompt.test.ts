import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerPrompt } from "../src/worker/prompt.js";
import { defaultSchedule } from "../src/policy.js";
import type { ActionableObservation, GithubObservation, GoalRecord } from "../src/types.js";

test("worker prompt redacts validation command secrets", () => {
  const goal: GoalRecord = {
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
      repository: { owner: "o", repo: "r", branch: "feature" },
      prNumber: 1,
      validationCommands: ["TOKEN=ghp_abcdefghijklmnopqrstuvwxyz npm test"],
      autoReplyAndResolve: false,
      handledThreadIds: [],
      handledCheckNames: [],
    },
  };
  const observation: GithubObservation = { observedAt: "2026-01-01T00:00:00.000Z", reviewThreads: [], checks: [] };
  const actionable: ActionableObservation = { actionable: true, observedAt: observation.observedAt, threads: [], checks: [], reason: "test" };
  const prompt = buildWorkerPrompt(goal, observation, actionable);
  assert.match(prompt, /Validation commands: TOKEN=\[REDACTED\] npm test/);
  assert.doesNotMatch(prompt, /ghp_abcdefghijklmnopqrstuvwxyz/);
});
