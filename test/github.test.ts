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
  assert.deepEqual(parseRepo("git@github.com:owner/my.repo.git"), { owner: "owner", repo: "my.repo", url: "https://github.com/owner/my.repo" });
  assert.equal(parsePr("ignored/repo", "https://github.com/owner/my.repo/pull/5").repository.repo, "my.repo");
  assert.equal(parsePr("ignored/repo", "https://github.com/zikolach/pi-goal-runner/pull/5").prNumber, 5);
  assert.equal(parsePr("zikolach/pi-goal-runner", " 123 ").prNumber, 123);
  assert.throws(() => parseRepo("https://evilgithub.com/owner/repo"), /owner\/repo or a GitHub URL/);
  assert.throws(() => parseRepo("https://github.com.evil.com/owner/repo"), /owner\/repo or a GitHub URL/);
  assert.throws(() => parseRepo("https://api.github.com/owner/repo"), /owner\/repo or a GitHub URL/);
  assert.throws(() => parsePr("zikolach/pi-goal-runner", "https://evilgithub.com/owner/repo/pull/5"), /integer PR number/);
  assert.throws(() => parsePr("zikolach/pi-goal-runner", "https://github.com.evil.com/owner/repo/pull/5"), /integer PR number/);
  assert.throws(() => parsePr("zikolach/pi-goal-runner", "https://api.github.com/owner/repo/pull/5"), /integer PR number/);
  assert.throws(() => parsePr("zikolach/pi-goal-runner", "https://github.com/owner/repo/pull/5abc"), /integer PR number/);
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

test("redacts validation commands before persisting PR goals", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-github-"));
  try {
    const store = createGoalStore(dir);
    const gh: GhExecutor = {
      run: async (args) => {
        if (args[0] === "auth") return "";
        return JSON.stringify({ url: "u", headRefName: "feature", baseRefName: "main", headRepositoryOwner: { login: "owner" } });
      },
    };
    const goal = await createGithubPrGoal(store, gh, "owner/repo", "1", { validationCommands: ["TOKEN=ghp_abcdefghijklmnopqrstuvwxyz npm test", "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz'"] });
    assert.deepEqual(goal.github?.validationCommands, ["TOKEN=[REDACTED] npm test", "curl -H 'Authorization: Bearer [REDACTED]'"]);
    assert.deepEqual((await store.get(goal.id)).github?.validationCommands, goal.github?.validationCommands);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validates schedule overrides when creating a goal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-github-"));
  try {
    const store = createGoalStore(dir);
    const gh: GhExecutor = { run: async () => { throw new Error("gh should not be called for invalid schedule options"); } };
    await assert.rejects(() => createGithubPrGoal(store, gh, "owner/repo", "1", { quietWindowMs: Number.NaN }), /quietWindowMs must be a finite non-negative number/);
    await assert.rejects(() => createGithubPrGoal(store, gh, "owner/repo", "1", { initialBackoffMs: -1 }), /initialBackoffMs must be a finite non-negative number/);
    await assert.rejects(() => createGithubPrGoal(store, gh, "owner/repo", "1", { maxBackoffMs: 30_000 }), /maxBackoffMs must be greater than or equal to initialBackoffMs/);
    await assert.rejects(() => createGithubPrGoal(store, gh, "owner/repo", "1", { initialBackoffMs: 120_000, maxBackoffMs: 60_000 }), /maxBackoffMs must be greater than or equal to initialBackoffMs/);
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
  const observation = await observeGithubPr(gh, config, { now: new Date("2026-01-01T01:02:03.000Z") });
  const actionable = findActionable(config, observation);
  assert.equal(observation.observedAt, "2026-01-01T01:02:03.000Z");
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

test("observes all review thread and comment pages", async () => {
  const apiCalls: string[][] = [];
  const gh: GhExecutor = {
    run: async (args) => {
      if (args[0] !== "api") return JSON.stringify({ url: "u", headRefName: "b", headRefOid: "sha", statusCheckRollup: [] });
      apiCalls.push(args);
      const query = args.join(" ");
      if (query.includes("node(id:$threadId)")) {
        return JSON.stringify({ data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "c2", body: "second comment", author: { login: "bot" }, updatedAt: "2026-01-01T00:01:00Z" }] } } } });
      }
      if (query.includes("threadsCursor=thread-page-1")) {
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "t2", isResolved: false, isOutdated: false, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "c3", body: "other thread", author: { login: "bot" }, updatedAt: "2026-01-01T00:02:00Z" }] } }] } } } } });
      }
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "thread-page-1" }, nodes: [{ id: "t1", isResolved: false, isOutdated: false, comments: { pageInfo: { hasNextPage: true, endCursor: "comment-page-1" }, nodes: [{ id: "c1", body: "first comment", author: { login: "bot" }, updatedAt: "2026-01-01T00:00:00Z" }] } }] } } } } });
    },
  };
  const observation = await observeGithubPr(gh, config);
  assert.deepEqual(observation.reviewThreads.map((thread) => thread.id), ["t1", "t2"]);
  assert.deepEqual(observation.reviewThreads[0].comments.map((comment) => comment.id), ["c1", "c2"]);
  assert.equal(apiCalls.length, 3);
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
  assert.equal(
    findActionable(
      { ...config, lastHandledAt: "2026-01-02T00:00:00Z", handledThreadIds: ["t1"] },
      { ...observation, reviewThreads: [{ ...observation.reviewThreads[0], updatedAt: "2026-01-03T00:00:00Z", comments: [{ id: "c2", body: "new fix", updatedAt: "2026-01-03T00:00:00Z" }] }] },
    ).actionable,
    true,
  );
});
