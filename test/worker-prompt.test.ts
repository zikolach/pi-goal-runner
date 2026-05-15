import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerPrompt } from "../src/worker/prompt.js";
import { defaultSchedule } from "../src/policy.js";
import type { ActionableObservation, GithubObservation, GoalRecord, RepositoryRef } from "../src/types.js";

function createPromptGoal(overrides: Partial<RepositoryRef> = {}): GoalRecord {
  return {
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
      repository: { owner: "o", repo: "r", branch: "feature", ...overrides },
      prNumber: 1,
      validationCommands: ["TOKEN=ghp_abcdefghijklmnopqrstuvwxyz npm test"],
      autoReplyAndResolve: false,
      handledThreadIds: [],
      handledCheckNames: [],
    },
  };
}

const observation: GithubObservation = { observedAt: "2026-01-01T00:00:00.000Z", headSha: "abc123", reviewThreads: [], checks: [] };
const actionable: ActionableObservation = { actionable: true, observedAt: observation.observedAt, threads: [], checks: [], reason: "test" };

test("worker prompt redacts validation command secrets", () => {
  const prompt = buildWorkerPrompt(createPromptGoal(), observation, actionable);
  assert.match(prompt, /Validation commands: TOKEN=\[REDACTED\] npm test/);
  assert.doesNotMatch(prompt, /ghp_abcdefghijklmnopqrstuvwxyz/);
});

test("worker prompt explains detached worktree push target", () => {
  const prompt = buildWorkerPrompt(createPromptGoal({ worktreePath: "/tmp/wt", worktreeMode: "isolated", worktreeHeadSha: "def456", pushRemote: "origin", pushBranch: "feature" }), observation, actionable);

  assert.match(prompt, /Worker checkout: isolated detached worktree/);
  assert.match(prompt, /Checked-out worktree HEAD: def456/);
  assert.match(prompt, /Push destination: origin HEAD:feature/);
  assert.match(prompt, /git push origin HEAD:feature/);
  assert.match(prompt, /without force by default/);
  assert.match(prompt, /commitSha/);
});

test("worker prompt labels explicit same-path mode", () => {
  const prompt = buildWorkerPrompt(createPromptGoal({ worktreePath: "/tmp/repo", worktreeMode: "same_path", pushRemote: "origin", pushBranch: "feature" }), observation, actionable);

  assert.match(prompt, /Worker checkout: user checkout \(explicit same-path mode\)/);
  assert.match(prompt, /Checked-out worktree HEAD: abc123/);
  assert.match(prompt, /explicit same-path mode/);
  assert.match(prompt, /git push origin HEAD:feature/);
  assert.match(prompt, /git push origin feature/);
  assert.doesNotMatch(prompt, /If this is an isolated detached worktree/);
});
