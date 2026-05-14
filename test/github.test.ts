import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGithubPrGoal } from "../src/github/create.js";
import { parsePr, parseRepo, type GhExecutor } from "../src/github/gh.js";
import { createGoalStore } from "../src/state/store.js";
import { findActionable, observeGithubPr } from "../src/github/observe.js";
import { replyAndResolveAddressedThreads } from "../src/github/update.js";
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
  assert.deepEqual(parseRepo("https://github.com/owner/my.repo.git"), { owner: "owner", repo: "my.repo", url: "https://github.com/owner/my.repo" });
  assert.equal(parsePr("ignored/repo", "https://github.com/owner/my.repo/pull/5").repository.repo, "my.repo");
  assert.equal(parsePr("ignored/repo", "https://github.com/zikolach/pi-goal-runner/pull/5").prNumber, 5);
  assert.equal(parsePr("zikolach/pi-goal-runner", " 123 ").prNumber, 123);
  assert.throws(() => parsePr("zikolach/pi-goal-runner", "release-123"), /integer PR number/);
  assert.throws(() => parsePr("zikolach/pi-goal-runner", "v2"), /integer PR number/);
});

test("rejects fork PRs when creating a goal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-github-"));
  try {
    const store = createGoalStore(dir);
    const gh: GhExecutor = {
      run: async (args) => {
        if (args[0] === "auth") return "";
        return JSON.stringify({ url: "u", headRefName: "feature", baseRefName: "main", headRepositoryOwner: { login: "contributor" } });
      },
    };
    await assert.rejects(() => createGithubPrGoal(store, gh, "owner/repo", "1"), /Pull requests from forks are not currently supported/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("auto reply requires valid commit sha evidence", async () => {
  const calls: string[][] = [];
  const gh: GhExecutor = { run: async (args) => { calls.push(args); return "{}"; } };
  await assert.rejects(
    () => replyAndResolveAddressedThreads(gh, { ...config, autoReplyAndResolve: true }, { type: "complete", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", status: "success", summary: "done", commitSha: "not-a-sha", addressedThreadIds: ["t1"] }),
    /valid pushed commit evidence/,
  );
  assert.deepEqual(calls, []);
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
