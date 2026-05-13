import assert from "node:assert/strict";
import test from "node:test";
import { parsePr, parseRepo, type GhExecutor } from "../src/github/gh.js";
import { findActionable, observeGithubPr } from "../src/github/observe.js";
import type { GithubPrGoalConfig } from "../src/types.js";

const config: GithubPrGoalConfig = {
  repository: { owner: "zikolach", repo: "pi-goal-runner", branch: "main" },
  prNumber: 1,
  validationCommands: ["npm test"],
  autoReplyAndResolve: false,
  handledThreadIds: [],
  handledCheckNames: [],
};

test("parses repositories and PRs", () => {
  assert.deepEqual(parseRepo("zikolach/pi-goal-runner").owner, "zikolach");
  assert.equal(parsePr("ignored/repo", "https://github.com/zikolach/pi-goal-runner/pull/5").prNumber, 5);
});

test("observes mocked gh output and detects no-op", async () => {
  const calls: string[][] = [];
  const gh: GhExecutor = {
    run: async (args) => {
      calls.push(args);
      if (args[0] === "api") return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      return JSON.stringify({ url: "u", headRefName: "b", headRefOid: "sha", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }] });
    },
  };
  const observation = await observeGithubPr(gh, config);
  const actionable = findActionable(config, observation);
  assert.equal(actionable.actionable, false);
  assert.equal(calls.length, 2);
});

test("observes review threads through GraphQL", async () => {
  const gh: GhExecutor = {
    run: async (args) => {
      if (args[0] === "api") return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "t1", isResolved: false, isOutdated: false, path: "file.ts", comments: { nodes: [{ id: "c1", body: "fix", author: { login: "bot" }, updatedAt: "2026-01-01T00:00:00Z" }] } }] } } } } });
      return JSON.stringify({ url: "u", headRefName: "b", headRefOid: "sha", statusCheckRollup: [] });
    },
  };
  const observation = await observeGithubPr(gh, config);
  assert.equal(observation.reviewThreads[0].id, "t1");
  assert.equal(findActionable(config, observation).actionable, true);
});

test("detects new review and failing checks, ignores stale handled comments", () => {
  const observation = {
    observedAt: "2026-01-01T00:00:00Z",
    reviewThreads: [{ id: "t1", resolved: false, outdated: false, updatedAt: "2026-01-01T00:00:00Z", comments: [{ id: "c1", body: "fix", updatedAt: "2026-01-01T00:00:00Z" }] }],
    checks: [{ name: "ci", status: "failing" as const, completedAt: "2026-01-01T00:00:00Z" }],
  };
  assert.equal(findActionable(config, observation).actionable, true);
  assert.equal(findActionable({ ...config, lastHandledAt: "2026-01-02T00:00:00Z", handledThreadIds: ["t1"], handledCheckNames: ["ci"] }, observation).actionable, false);
});
