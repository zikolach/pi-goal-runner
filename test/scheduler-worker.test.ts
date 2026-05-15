import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoalStore } from "../src/state/store.js";
import { defaultSchedule } from "../src/policy.js";
import { MAX_HANDLED_CHECK_NAMES, MAX_HANDLED_THREAD_IDS } from "../src/github/handled.js";
import { handleSuccessfulWorkerComplete, selectDueGoals, schedulerTick } from "../src/scheduler.js";
import { ingestWorkerEvent, launchWorker, MAX_WORKER_STDOUT_BUFFER_CHARS, startWorker } from "../src/worker/subprocess.js";
import { CommandNotificationSink, createDefaultNotificationSink, notifyNonFatal } from "../src/notifications.js";

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-scheduler-"));
  return { store: createGoalStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for promise")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(file: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await readFile(file);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function waitForRunStatus(store: ReturnType<typeof createGoalStore>, goalId: string, runId: string, status: string, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const goal = await store.get(goalId);
    const run = goal.runHistory.find((candidate) => candidate.id === runId);
    if (run?.status === status) return goal;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for run ${runId} to reach ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type CapturedWorkerTimeout = {
  delay?: number;
  cleared: boolean;
  fire: () => void;
  unref: () => CapturedWorkerTimeout;
};

function captureWorkerTimeouts(workerTimeoutMs: number) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const capturedWorkerTimeouts: CapturedWorkerTimeout[] = [];

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== workerTimeoutMs) return realSetTimeout(callback, delay, ...args) as ReturnType<typeof globalThis.setTimeout>;
    const handle: CapturedWorkerTimeout = {
      delay,
      cleared: false,
      fire: () => {
        if (!handle.cleared) callback(...args);
      },
      unref: () => handle,
    };
    capturedWorkerTimeouts.push(handle);
    return handle as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof globalThis.setTimeout>) => {
    const captured = handle as unknown as CapturedWorkerTimeout | undefined;
    if (captured && typeof captured === "object" && "cleared" in captured) {
      captured.cleared = true;
      return;
    }
    return realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
  }) as unknown as typeof globalThis.clearTimeout;

  return {
    capturedWorkerTimeouts,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

test("due selection skips paused/cancelled/waiting goals", async () => {
  const t = await tempStore();
  try {
    const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
    await t.store.create({ id: "a", type: "github_pr_review", state: "active", summary: "a", schedule });
    await t.store.create({ id: "p", type: "github_pr_review", state: "paused", summary: "p", schedule });
    await t.store.create({ id: "c", type: "github_pr_review", state: "cancelled", summary: "c", schedule });
    await t.store.create({ id: "d", type: "github_pr_review", state: "needs_decision", summary: "d", schedule, pendingDecisions: [{ id: "d1", goalId: "d", prompt: "?", options: [{ id: "x", label: "X" }], createdAt: "", status: "pending", required: true }] });
    await t.store.create({ id: "n", type: "github_pr_review", state: "active", summary: "n", schedule, pendingDecisions: [{ id: "n1", goalId: "n", prompt: "?", options: [{ id: "x", label: "X" }], createdAt: "", status: "pending", required: false }] });
    assert.deepEqual((await selectDueGoals(t.store, new Date("2026-01-01T00:00:01Z"))).map((g) => g.id), ["a", "n"]);
  } finally {
    await t.cleanup();
  }
});

test("scheduler no-op applies quiet completion without launching worker", async () => {
  const t = await tempStore();
  try {
    const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
    schedule.quietWindow.quietSince = "2026-01-01T00:00:00Z";
    await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule, cwd: process.cwd(), github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] } });
    const gh = { run: async () => JSON.stringify({ reviewThreads: [], statusCheckRollup: [] }) };
    await schedulerTick(t.store, { gh, now: new Date("2026-01-01T03:00:00Z"), worker: { dryRun: true } });
    assert.equal((await t.store.get("g")).state, "completed");
  } finally {
    await t.cleanup();
  }
});

test("scheduler uses injected time for quiet policy updates", async () => {
  const t = await tempStore();
  try {
    const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
    await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule, cwd: process.cwd(), github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] } });
    const gh = { run: async (args: string[]) => args[0] === "api" ? JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) : JSON.stringify({ statusCheckRollup: [] }) };
    await schedulerTick(t.store, { gh, now: new Date("2026-01-01T01:00:00Z"), worker: { dryRun: true } });
    const updated = await t.store.get("g");
    assert.equal(updated.schedule.quietWindow.quietSince, "2026-01-01T01:00:00.000Z");
    assert.equal(updated.schedule.nextCheckAt, "2026-01-01T01:02:00.000Z");
    assert.equal(updated.updatedAt, "2026-01-01T01:00:00.000Z");
  } finally {
    await t.cleanup();
  }
});

test("scheduler uses injected time when persisting GitHub observation metadata", async () => {
  const t = await tempStore();
  try {
    const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
    await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule, cwd: process.cwd(), updatedAt: "2025-01-01T00:00:00.000Z", github: { repository: { owner: "o", repo: "r", branch: "old-branch" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] } });
    const gh = {
      run: async (args: string[]) =>
        args[0] === "api"
          ? JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } })
          : JSON.stringify({ url: "u", headRefName: "observed-branch", headRefOid: "sha", statusCheckRollup: [] }),
    };
    const originalUpdate = t.store.update;
    let updateCalls = 0;
    t.store.update = (async (goalId, updater, options) => {
      updateCalls++;
      if (updateCalls > 1) throw new Error("stop after observation metadata update");
      return originalUpdate.call(t.store, goalId, updater, options);
    }) as typeof t.store.update;

    await assert.rejects(() => schedulerTick(t.store, { gh, now: new Date("2026-01-01T01:00:00Z"), worker: { dryRun: true } }), /stop after observation/);
    const updated = await t.store.get("g");
    assert.equal(updated.github?.repository.branch, "observed-branch");
    assert.equal(updated.updatedAt, "2026-01-01T01:00:00.000Z");
  } finally {
    await t.cleanup();
  }
});

test("scheduler catch block applies retry backoff with injected time", async () => {
  const t = await tempStore();
  try {
    await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")),
      cwd: process.cwd(),
      github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });
    const gh = { run: async () => { throw new Error("scheduler boom"); } };
    const result = await schedulerTick(t.store, { gh, now: new Date("2026-01-01T00:00:00Z"), worker: { dryRun: true } });
    const updated = await t.store.get("g");
    assert.equal(result.failures, 1);
    assert.equal(updated.state, "failed");
    assert.equal(updated.updatedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(updated.schedule.backoff.currentMs, 120_000);
    assert.equal(updated.schedule.nextCheckAt, "2026-01-01T00:02:00.000Z");
  } finally {
    await t.cleanup();
  }
});

test("scheduler dry-run launch defers next check to avoid repeated launch intents", async () => {
  const t = await tempStore();
  try {
    const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
    await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule,
      cwd: process.cwd(),
      github: { repository: { owner: "o", repo: "r", localPath: process.cwd(), worktreePath: process.cwd() }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });
    const gh = {
      run: async (args: string[]) =>
        args[0] === "api"
          ? JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "t1", isResolved: false, isOutdated: false, comments: { nodes: [{ id: "c1", body: "fix", updatedAt: "2026-01-01T00:00:00Z" }] } }] } } } } })
          : JSON.stringify({ url: "u", statusCheckRollup: [] }),
    };
    const now = new Date("2026-01-01T00:00:00Z");
    const result = await schedulerTick(t.store, { gh, now, worker: { dryRun: true } });
    const updated = await t.store.get("g");
    assert.equal(result.launched, 1);
    assert.equal(updated.state, "active");
    assert.equal(updated.updatedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(updated.schedule.nextCheckAt, "2026-01-01T00:01:00.000Z");
    assert.match(updated.latestProgress ?? "", /Launching worker/);

    const repeatResult = await schedulerTick(t.store, { gh, now, worker: { dryRun: true } });
    assert.equal(repeatResult.launched, 0);
  } finally {
    await t.cleanup();
  }
});

test("scheduler reloads and rechecks goal state after acquiring lock", async () => {
  const t = await tempStore();
  try {
    const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
    await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule,
      cwd: process.cwd(),
      github: { repository: { owner: "o", repo: "r", localPath: process.cwd(), worktreePath: process.cwd() }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });
    const originalList = t.store.list;
    t.store.list = (async () => {
      const goals = await originalList.call(t.store);
      await t.store.setState("g", "paused");
      return goals;
    }) as typeof t.store.list;
    let ghCalls = 0;
    const gh = {
      run: async (args: string[]) => {
        ghCalls++;
        return args[0] === "api"
          ? JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "t1", isResolved: false, isOutdated: false, comments: { nodes: [{ id: "c1", body: "fix", updatedAt: "2026-01-01T00:00:00Z" }] } }] } } } } })
          : JSON.stringify({ url: "u", statusCheckRollup: [] });
      },
    };

    const result = await schedulerTick(t.store, { gh, now: new Date("2026-01-01T00:00:00Z"), worker: { dryRun: true } });

    assert.equal(result.launched, 0);
    assert.equal(result.skipped, 1);
    assert.equal(ghCalls, 0);
    assert.equal((await t.store.get("g")).state, "paused");
    await assert.rejects(() => readFile(path.join(t.store.paths.lockDir("g"), "owner.json"), "utf8"), /ENOENT/);
  } finally {
    await t.cleanup();
  }
});

test("scheduler recovers running goals when worker lock is missing", async () => {
  const t = await tempStore();
  try {
    const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
    await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "running",
      summary: "g",
      schedule,
      runHistory: [{ id: "r", startedAt: "2026-01-01T00:00:00.000Z", status: "running" }],
      github: { repository: { owner: "o", repo: "r", localPath: process.cwd(), worktreePath: process.cwd() }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });
    let ghCalls = 0;
    const gh = { run: async () => { ghCalls++; return "{}"; } };
    const result = await schedulerTick(t.store, { gh, now: new Date("2026-01-01T00:01:00Z"), worker: { dryRun: true } });
    const updated = await t.store.get("g");
    assert.equal(result.failures, 1);
    assert.equal(result.launched, 0);
    assert.equal(ghCalls, 0);
    assert.equal(updated.state, "failed");
    assert.equal(updated.runHistory.at(-1)?.status, "failed");
    assert.equal(updated.runHistory.at(-1)?.completedAt, "2026-01-01T00:01:00.000Z");
    assert.equal(updated.schedule.nextCheckAt, "2026-01-01T00:03:00.000Z");
  } finally {
    await t.cleanup();
  }
});

test("scheduler lock staleness follows configured worker timeout", async () => {
  const t = await tempStore();
  try {
    const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
    await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule,
      cwd: process.cwd(),
      github: { repository: { owner: "o", repo: "r", localPath: process.cwd(), worktreePath: process.cwd() }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });
    const lockDir = t.store.paths.lockDir("g");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 999999999, createdAt: new Date(Date.now() - 60 * 60_000).toISOString() }), "utf8");
    let ghCalls = 0;
    const gh = { run: async () => { ghCalls++; return "{}"; } };
    const result = await schedulerTick(t.store, { gh, now: new Date(), worker: { dryRun: true, timeoutMs: 2 * 60 * 60_000 } });
    assert.equal(result.launched, 0);
    assert.equal(result.skipped, 1);
    assert.equal(ghCalls, 0);
  } finally {
    await t.cleanup();
  }
});

test("scheduler launches workers in background and continues checking due goals", async () => {
  const t = await tempStore();
  try {
    const schedule = defaultSchedule(new Date("2026-01-01T00:00:00Z"));
    const github = { repository: { owner: "o", repo: "r", localPath: process.cwd(), worktreePath: process.cwd() }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] };
    await t.store.create({ id: "g1", type: "github_pr_review", state: "active", summary: "g1", schedule, cwd: process.cwd(), github });
    await t.store.create({ id: "g2", type: "github_pr_review", state: "active", summary: "g2", schedule, cwd: process.cwd(), github });
    const gh = {
      run: async (args: string[]) =>
        args[0] === "api"
          ? JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "t1", isResolved: false, isOutdated: false, comments: { nodes: [{ id: "c1", body: "fix", updatedAt: "2026-01-01T00:00:00Z" }] } }] } } } } })
          : JSON.stringify({ url: "u", statusCheckRollup: [] }),
    };
    const result = await schedulerTick(t.store, {
      gh,
      now: new Date("2026-01-01T00:00:00Z"),
      worker: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log(JSON.stringify({type:'complete', status:'success', summary:'done'})), 1500);"],
        timeoutMs: 5_000,
      },
    });
    assert.equal(result.launched, 2);
    assert.equal((await t.store.get("g1")).state, "running");
    assert.equal((await t.store.get("g2")).state, "running");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal((await t.store.get("g1")).lastRunSummary, "done");
    assert.equal((await t.store.get("g2")).lastRunSummary, "done");
  } finally {
    await t.cleanup();
  }
});

test("worker event ingestion records decisions, completion, failures", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "decision", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    const decisionAt = "2026-01-01T00:00:00Z";
    await ingestWorkerEvent(t.store, "decision", "r", { type: "decision", goalId: "decision", runId: "r", timestamp: decisionAt, decision: { id: "d", goalId: "decision", runId: "r", prompt: "Choose", options: [{ id: "x", label: "X" }], createdAt: "", status: "pending", required: true } });
    const decisionGoal = await t.store.get("decision");
    assert.equal(decisionGoal.state, "needs_decision");
    assert.equal(decisionGoal.runHistory.at(-1)?.completedAt, decisionAt);

    await t.store.create({ id: "complete", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    await ingestWorkerEvent(t.store, "complete", "r", { type: "complete", goalId: "complete", runId: "r", timestamp: new Date().toISOString(), status: "success", summary: "done", commitSha: "abc" });
    assert.equal((await t.store.get("complete")).lastRunSummary, "done");

    await t.store.create({ id: "quiet", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    await ingestWorkerEvent(t.store, "quiet", "r", { type: "complete", goalId: "quiet", runId: "r", timestamp: new Date().toISOString(), status: "quiet", summary: "quiet" });
    assert.equal((await t.store.get("quiet")).state, "completed");
  } finally {
    await t.cleanup();
  }
});

test("worker decision ids are redacted and length-limited before persisting", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    const unsafeId = `decision-ghp_${"a".repeat(24)}-${"x".repeat(200)}`;
    await ingestWorkerEvent(t.store, "g", "r", { type: "decision", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", decision: { id: unsafeId, goalId: "g", runId: "r", prompt: "Choose", options: [{ id: "x", label: "X" }], createdAt: "", status: "pending", required: true } });
    const decisionId = (await t.store.get("g")).pendingDecisions[0]?.id ?? "";
    assert.doesNotMatch(decisionId, /ghp_/);
    assert.match(decisionId, /\[REDACTED\]/);
    assert.ok(decisionId.length <= 133);
  } finally {
    await t.cleanup();
  }
});

test("late worker failure does not override terminal success", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", status: "success", summary: "done", commitSha: "abc1234" });
    const afterComplete = await t.store.get("g");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ingestWorkerEvent(t.store, "g", "r", { type: "failure", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:01Z", message: "late process exit", retryable: true });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "active");
    assert.equal(updated.runHistory.at(-1)?.status, "success");
    assert.equal(updated.latestProgress, "done");
    assert.equal(updated.updatedAt, afterComplete.updatedAt);
  } finally {
    await t.cleanup();
  }
});

test("late worker non-terminal events do not override terminal success", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", status: "success", summary: "done", commitSha: "abc1234" });
    const afterComplete = await t.store.get("g");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ingestWorkerEvent(t.store, "g", "r", { type: "progress", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:01Z", message: "late progress" });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "active");
    assert.equal(updated.runHistory.at(-1)?.status, "success");
    assert.equal(updated.latestProgress, "done");
    assert.equal(updated.updatedAt, afterComplete.updatedAt);
  } finally {
    await t.cleanup();
  }
});

test("late worker terminal events do not override the first terminal outcome", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "failure-first", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    await ingestWorkerEvent(t.store, "failure-first", "r", { type: "failure", goalId: "failure-first", runId: "r", timestamp: "2026-01-01T00:00:00Z", message: "first failure", retryable: true });
    await ingestWorkerEvent(t.store, "failure-first", "r", { type: "complete", goalId: "failure-first", runId: "r", timestamp: "2026-01-01T00:00:01Z", status: "success", summary: "late success" });
    const failureFirst = await t.store.get("failure-first");
    assert.equal(failureFirst.state, "failed");
    assert.equal(failureFirst.runHistory.at(-1)?.status, "failed");
    assert.notEqual(failureFirst.lastRunSummary, "late success");

    await t.store.create({ id: "complete-first", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    await ingestWorkerEvent(t.store, "complete-first", "r", { type: "complete", goalId: "complete-first", runId: "r", timestamp: "2026-01-01T00:00:00Z", status: "success", summary: "done" });
    const afterComplete = await t.store.get("complete-first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ingestWorkerEvent(t.store, "complete-first", "r", { type: "decision", goalId: "complete-first", runId: "r", timestamp: "2026-01-01T00:00:01Z", decision: { id: "late-decision", goalId: "complete-first", runId: "r", prompt: "Late decision", options: [{ id: "x", label: "X" }], createdAt: "", status: "pending", required: true } });
    const completeFirst = await t.store.get("complete-first");
    assert.equal(completeFirst.state, "active");
    assert.equal(completeFirst.runHistory.at(-1)?.status, "success");
    assert.equal(completeFirst.pendingDecisions.some((decision) => decision.id === "late-decision"), false);
    assert.equal(completeFirst.updatedAt, afterComplete.updatedAt);
  } finally {
    await t.cleanup();
  }
});

test("worker failure events apply retry backoff", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    await ingestWorkerEvent(t.store, "g", "r", { type: "failure", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", message: "failed", retryable: true });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "failed");
    assert.equal(updated.schedule.nextCheckAt, "2026-01-01T00:02:00.000Z");
  } finally {
    await t.cleanup();
  }
});

test("stale worker completions apply retry backoff", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(new Date("2026-01-01T00:00:00Z")), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", status: "stale", summary: "Observation was stale" });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "failed");
    assert.equal(updated.runHistory.at(-1)?.status, "failed");
    assert.equal(updated.schedule.backoff.currentMs, 120_000);
    assert.equal(updated.schedule.nextCheckAt, "2026-01-01T00:02:00.000Z");
    assert.equal(updated.lastRunSummary, "Observation was stale");
  } finally {
    await t.cleanup();
  }
});

test("worker success completion invokes completion callback", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    let completed = false;
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({type:'complete', status:'success', summary:'done', commitSha:'abc'}));"],
      onComplete: async () => {
        completed = true;
      },
    });
    assert.equal(completed, true);
  } finally {
    await t.cleanup();
  }
});

test("worker event queue continues after one ingestion failure", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    const realUpdate = t.store.update.bind(t.store);
    let updateCount = 0;
    t.store.update = async (goalId, updater) => {
      updateCount++;
      if (updateCount === 2) throw new Error("transient update failure");
      return realUpdate(goalId, updater);
    };
    await launchWorker(t.store, goal, "secret prompt", {
      command: process.execPath,
      args: [
        "-e",
        [
          "if (process.env.PI_GOAL_PROMPT) process.exit(2);",
          "console.log(JSON.stringify({type:'progress', message:'one'}));",
          "console.log(JSON.stringify({type:'complete', status:'success', summary:'done'}));",
        ].join(""),
      ],
      env: { PI_GOAL_PROMPT: "do not forward" },
    });
    const updated = await t.store.get("g");
    assert.equal(updated.lastRunSummary, "done");
  } finally {
    await t.cleanup();
  }
});

test("worker stdout events are serialized in emission order", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "secret prompt", {
      command: process.execPath,
      args: [
        "-e",
        [
          "console.log(JSON.stringify({type:'progress', message:'one'}));",
          "console.log(JSON.stringify({type:'progress', message:'two'}));",
          "console.log(JSON.stringify({type:'complete', status:'success', summary:'done'}));",
        ].join(""),
      ],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.lastRunSummary, "done");
    const events = (await readFile(t.store.paths.eventsFile("g"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type?: string; message?: string; summary?: string });
    assert.deepEqual(events.map((event) => event.message ?? event.summary), ["one", "two", "done"]);
  } finally {
    await t.cleanup();
  }
});

test("worker final stdout line strips trailing carriage return", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({type:'complete', status:'success', summary:'done'}) + '\\r');"],
    });
    const updated = await t.store.get("g");
    const events = await readFile(t.store.paths.eventsFile("g"), "utf8");
    assert.equal(updated.lastRunSummary, "done");
    assert.doesNotMatch(events, /Malformed worker event/);
  } finally {
    await t.cleanup();
  }
});

test("worker stdout without newlines is bounded and records failure", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: ["-e", `process.stdout.write("x".repeat(${MAX_WORKER_STDOUT_BUFFER_CHARS + 1})); setTimeout(() => {}, 1000);`],
      timeoutMs: 5_000,
    });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "failed");
    assert.match(updated.latestProgress ?? "", /stdout line exceeded/);
  } finally {
    await t.cleanup();
  }
});

test("worker clears pending SIGKILL escalation when a timed-out child exits", async () => {
  const t = await tempStore();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  type CapturedTimeout = {
    delay?: number;
    cleared: boolean;
    fire: () => void;
    unref: () => CapturedTimeout;
  };
  const capturedTimeouts: CapturedTimeout[] = [];
  try {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle: CapturedTimeout = {
        delay,
        cleared: false,
        fire: () => {
          if (!handle.cleared) callback(...args);
        },
        unref: () => handle,
      };
      capturedTimeouts.push(handle);
      if (delay !== 5_000) realSetTimeout(() => handle.fire(), 0);
      return handle as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof globalThis.setTimeout>) => {
      const captured = handle as unknown as CapturedTimeout | undefined;
      if (captured && typeof captured === "object" && "cleared" in captured) {
        captured.cleared = true;
        return;
      }
      return realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
    }) as unknown as typeof globalThis.clearTimeout;

    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 50); setInterval(() => {}, 1000);"],
      timeoutMs: 1,
    });
    const sigkillTimer = capturedTimeouts.find((handle) => handle.delay === 5_000);
    assert.ok(sigkillTimer);
    assert.equal(sigkillTimer.cleared, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    await t.cleanup();
  }
});

test("worker args from env are split with quote awareness", async () => {
  const t = await tempStore();
  const previous = process.env.PI_GOAL_WORKER_ARGS;
  try {
    process.env.PI_GOAL_WORKER_ARGS = "-e 'console.log(JSON.stringify({type:\"complete\",status:\"success\",summary:\"two words\"}));'";
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", { command: process.execPath });
    assert.equal((await t.store.get("g")).lastRunSummary, "two words");
  } finally {
    if (previous === undefined) delete process.env.PI_GOAL_WORKER_ARGS;
    else process.env.PI_GOAL_WORKER_ARGS = previous;
    await t.cleanup();
  }
});

test("worker args from env preserve quoted empty arguments", async () => {
  const t = await tempStore();
  const previous = process.env.PI_GOAL_WORKER_ARGS;
  try {
    process.env.PI_GOAL_WORKER_ARGS = `-e 'if (process.argv[1] !== "") process.exit(2); console.log(JSON.stringify({type:"complete",status:"success",summary:"empty arg preserved"}));' ""`;
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", { command: process.execPath });
    assert.equal((await t.store.get("g")).lastRunSummary, "empty arg preserved");
  } finally {
    if (previous === undefined) delete process.env.PI_GOAL_WORKER_ARGS;
    else process.env.PI_GOAL_WORKER_ARGS = previous;
    await t.cleanup();
  }
});

test("worker decision terminal event is not overridden by non-zero exit", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdout.write(JSON.stringify({type:'decision', decision:{id:'d', prompt:'Pick', options:[{id:'x', label:'X'}]}}) + '\\n', () => process.exit(7));",
        ].join(""),
      ],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "needs_decision");
    assert.equal(updated.runHistory.at(-1)?.status, "needs_decision");
    assert.equal(updated.pendingDecisions.some((decision) => decision.id === "d" && decision.status === "pending"), true);
    const events = await readFile(t.store.paths.eventsFile("g"), "utf8");
    assert.match(events, /Worker process exited with code 7 after terminal decision event/);
  } finally {
    await t.cleanup();
  }
});

test("worker complete terminal event is not overridden by non-zero exit and records diagnostic", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({type:'complete', status:'success', summary:'done'}) + '\\n', () => process.exit(9));"],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "active");
    assert.equal(updated.runHistory.at(-1)?.status, "success");
    assert.equal(updated.lastRunSummary, "done");
    const events = await readFile(t.store.paths.eventsFile("g"), "utf8");
    assert.match(events, /Worker process exited with code 9 after terminal complete event/);
  } finally {
    await t.cleanup();
  }
});

test("late terminal-looking failure does not change authoritative diagnostic type", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: [
        "-e",
        [
          "const events = [",
          "{type:'complete', status:'success', summary:'done'},",
          "{type:'failure', message:'late protocol failure', retryable:true},",
          "];",
          "process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n', () => process.exit(9));",
        ].join(""),
      ],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "active");
    assert.equal(updated.runHistory.at(-1)?.status, "success");
    const events = await readFile(t.store.paths.eventsFile("g"), "utf8");
    assert.match(events, /Worker process exited with code 9 after terminal complete event/);
    assert.doesNotMatch(events, /after terminal failure event/);
  } finally {
    await t.cleanup();
  }
});

test("worker terminal outcome survives diagnostic write failure", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({type:'complete', status:'success', summary:'done'}) + '\\n', () => process.exit(9));"],
      onComplete: async () => {
        const eventsFile = t.store.paths.eventsFile("g");
        await rm(eventsFile, { force: true });
        await mkdir(eventsFile, { recursive: true });
      },
    });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "active");
    assert.equal(updated.runHistory.at(-1)?.status, "success");
    assert.equal(updated.lastRunSummary, "done");
  } finally {
    await t.cleanup();
  }
});

test("worker timeout after terminal event records only diagnostic", async () => {
  const t = await tempStore();
  const workerTimeoutMs = 60_000;
  const { capturedWorkerTimeouts, restore } = captureWorkerTimeouts(workerTimeoutMs);
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    const run = await startWorker(t.store, goal, "", {
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({type:'complete', status:'success', summary:'done'}) + '\\n', () => setInterval(() => {}, 1000));"],
      timeoutMs: workerTimeoutMs,
    });
    await waitForRunStatus(t.store, "g", run.runId, "success", 5_000);
    assert.equal(capturedWorkerTimeouts.length, 1);
    capturedWorkerTimeouts[0]?.fire();
    const updated = await run.done;
    assert.equal(updated.state, "active");
    assert.equal(updated.runHistory.at(-1)?.status, "success");
    assert.equal(updated.lastRunSummary, "done");
    const events = (await readFile(t.store.paths.eventsFile("g"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type?: string; runId?: string; message?: string });
    const runEvents = events.filter((event) => event.runId === updated.runHistory.at(-1)?.id);
    assert.equal(runEvents.some((event) => event.type === "failure"), false);
    assert.equal(runEvents.some((event) => event.type === "diagnostic" && /timed out after terminal complete event/.test(event.message ?? "")), true);
  } finally {
    restore();
    await t.cleanup();
  }
});

test("worker emitted failure remains authoritative when process exits zero", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({type:'failure', message:'emitted failure', retryable:true}) + '\\n', () => process.exit(0));"],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "failed");
    assert.equal(updated.runHistory.at(-1)?.status, "failed");
    assert.match(updated.latestProgress ?? "", /emitted failure/);
  } finally {
    await t.cleanup();
  }
});

test("worker exit without terminal event records failure", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({type:'progress', message:'only progress'}));"],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "failed");
    assert.match(updated.latestProgress ?? "", /without emitting a terminal event/);
  } finally {
    await t.cleanup();
  }
});

test("worker non-zero exit without terminal event remains failure", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", { command: process.execPath, args: ["-e", "process.stderr.write('boom'); process.exit(2);"] });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "failed");
    assert.equal(updated.runHistory.at(-1)?.status, "failed");
    assert.match(updated.latestProgress ?? "", /Worker exited with code 2/);
  } finally {
    await t.cleanup();
  }
});

test("worker timeout without terminal event remains failure", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000);"], timeoutMs: 20 });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "failed");
    assert.equal(updated.runHistory.at(-1)?.status, "timeout");
    assert.match(updated.latestProgress ?? "", /Worker timed out/);
  } finally {
    await t.cleanup();
  }
});

test("terminal event emitted after timeout does not override timeout", async () => {
  const t = await tempStore();
  const workerTimeoutMs = 60_000;
  const { capturedWorkerTimeouts, restore } = captureWorkerTimeouts(workerTimeoutMs);
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    const readyFile = path.join(t.store.paths.root, "worker-ready");
    const observedSignalFile = path.join(t.store.paths.root, "worker-sigterm-observed");
    const run = await startWorker(t.store, goal, "", {
      command: process.execPath,
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          `const readyFile = ${JSON.stringify(readyFile)};`,
          `const observedSignalFile = ${JSON.stringify(observedSignalFile)};`,
          "process.on('SIGTERM', () => {",
          "fs.writeFileSync(observedSignalFile, 'yes');",
          "process.stdout.write(JSON.stringify({type:'complete', status:'success', summary:'late success'}) + '\\n', () => setTimeout(() => process.exit(0), 50));",
          "});",
          "fs.writeFileSync(readyFile, 'yes');",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      timeoutMs: workerTimeoutMs,
    });
    await waitForFile(readyFile, 5_000);
    assert.equal(capturedWorkerTimeouts.length, 1);
    capturedWorkerTimeouts[0]?.fire();
    const updated = await run.done;
    assert.equal(await readFile(observedSignalFile, "utf8"), "yes");
    assert.equal(updated.state, "failed");
    assert.equal(updated.runHistory.at(-1)?.status, "timeout");
    assert.match(updated.latestProgress ?? "", /Worker timed out/);
    assert.notEqual(updated.lastRunSummary, "late success");
  } finally {
    restore();
    await t.cleanup();
  }
});

test("stale-context-like stderr after completion is recorded only as diagnostic", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdout.write(JSON.stringify({type:'complete', status:'success', summary:'done'}) + '\\n', () => {",
          "process.stderr.write('Error: This extension ctx is stale after session replacement\\n', () => process.exit(1));",
          "});",
        ].join(""),
      ],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.runHistory.at(-1)?.status, "success");
    assert.equal(updated.lastRunSummary, "done");
    const events = (await readFile(t.store.paths.eventsFile("g"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type?: string; runId?: string; message?: string });
    const runEvents = events.filter((event) => event.runId === updated.runHistory.at(-1)?.id);
    assert.equal(runEvents.some((event) => event.type === "failure"), false);
    assert.equal(runEvents.some((event) => event.type === "diagnostic" && /stale after session replacement/.test(event.message ?? "")), true);
  } finally {
    await t.cleanup();
  }
});

test("worker spawn errors record failure and resolve", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: path.join(t.store.paths.root, "missing-worker-binary"),
      args: [],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "failed");
    assert.match(updated.latestProgress ?? "", /failed to start/i);
  } finally {
    await t.cleanup();
  }
});

test("worker spawn error fallback resolves even when state writes and reads fail", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    const realUpdate = t.store.update.bind(t.store);
    const realGet = t.store.get.bind(t.store);
    let updateCount = 0;
    let getFails = false;
    t.store.update = (async (goalId, updater, options) => {
      updateCount++;
      if (updateCount > 1) throw new Error("read-only state");
      const updated = await realUpdate(goalId, updater, options);
      getFails = true;
      return updated;
    }) as typeof t.store.update;
    t.store.get = (async (goalId) => {
      if (getFails) throw new Error("cannot read state");
      return realGet(goalId);
    }) as typeof t.store.get;
    const updated = await withTimeout(launchWorker(t.store, goal, "", { command: path.join(t.store.paths.root, "missing-worker-binary"), args: [] }));
    assert.equal(updated.state, "failed");
    assert.match(updated.latestProgress ?? "", /cannot read state/);
  } finally {
    await t.cleanup();
  }
});

test("worker close fallback resolves even when state writes and reads fail", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    const realUpdate = t.store.update.bind(t.store);
    const realGet = t.store.get.bind(t.store);
    let updateCount = 0;
    let getFails = false;
    t.store.update = (async (goalId, updater, options) => {
      updateCount++;
      if (updateCount > 1) throw new Error("read-only state");
      const updated = await realUpdate(goalId, updater, options);
      getFails = true;
      return updated;
    }) as typeof t.store.update;
    t.store.get = (async (goalId) => {
      if (getFails) throw new Error("cannot read state");
      return realGet(goalId);
    }) as typeof t.store.get;
    const updated = await withTimeout(launchWorker(t.store, goal, "", { command: process.execPath, args: ["-e", "process.exit(1);"] }));
    assert.equal(updated.state, "failed");
    assert.match(updated.latestProgress ?? "", /cannot read state/);
  } finally {
    await t.cleanup();
  }
});

test("stale completion does not advance handled timestamps", async () => {
  const t = await tempStore();
  try {
    const github = { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] };
    await t.store.create({ id: "stale", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }], github });
    await ingestWorkerEvent(t.store, "stale", "r", { type: "complete", goalId: "stale", runId: "r", timestamp: "2026-01-01T00:00:00Z", status: "stale", summary: "stale", addressedThreadIds: ["t1"] });
    assert.equal((await t.store.get("stale")).github?.lastHandledAt, undefined);

    await t.store.create({ id: "success", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }], github });
    await ingestWorkerEvent(t.store, "success", "r", { type: "complete", goalId: "success", runId: "r", timestamp: "2026-01-01T00:00:01Z", status: "success", summary: "done", addressedThreadIds: ["t1"] });
    const updated = await t.store.get("success");
    assert.equal(updated.github?.lastHandledAt, "2026-01-01T00:00:01Z");
    assert.deepEqual(updated.github?.handledThreadIds, ["t1"]);
  } finally {
    await t.cleanup();
  }
});

test("successful worker completion caps handled thread IDs to recent values", async () => {
  const t = await tempStore();
  try {
    const existing = Array.from({ length: MAX_HANDLED_THREAD_IDS }, (_, index) => `old-${index}`);
    const addressed = Array.from({ length: 10 }, (_, index) => `new-${index}`);
    await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "running",
      summary: "g",
      schedule: defaultSchedule(),
      runHistory: [{ id: "r", startedAt: "", status: "running" }],
      github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: existing, handledCheckNames: [] },
    });

    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", status: "success", summary: "done", addressedThreadIds: addressed });

    const updated = await t.store.get("g");
    assert.equal(updated.github?.handledThreadIds.length, MAX_HANDLED_THREAD_IDS);
    assert.deepEqual(updated.github?.handledThreadIds.slice(-addressed.length), addressed);
    assert.equal(updated.github?.handledThreadIds.includes("old-0"), false);
  } finally {
    await t.cleanup();
  }
});

test("successful worker completion records handled check names", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      updatedAt: "2025-01-01T00:00:00.000Z",
      github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });
    const gh = { run: async (_args: string[]) => "{}" };
    const completedAt = "2026-01-01T00:00:00.000Z";
    await handleSuccessfulWorkerComplete(t.store, gh, goal, { type: "complete", goalId: "g", runId: "r", timestamp: completedAt, status: "success", summary: "done", commitSha: "abc" }, ["ci", "lint"]);
    const updated = await t.store.get("g");
    assert.deepEqual(updated.github?.handledCheckNames, ["ci", "lint"]);
    assert.equal(updated.updatedAt, completedAt);
  } finally {
    await t.cleanup();
  }
});

test("successful worker completion caps handled check names to recent values", async () => {
  const t = await tempStore();
  try {
    const existing = Array.from({ length: MAX_HANDLED_CHECK_NAMES }, (_, index) => `old-${index}`);
    const observed = Array.from({ length: 10 }, (_, index) => `new-${index}`);
    const goal = await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: existing },
    });
    const gh = { run: async (_args: string[]) => "{}" };

    await handleSuccessfulWorkerComplete(t.store, gh, goal, { type: "complete", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:00.000Z", status: "success", summary: "done" }, observed);

    const updated = await t.store.get("g");
    assert.equal(updated.github?.handledCheckNames.length, MAX_HANDLED_CHECK_NAMES);
    assert.deepEqual(updated.github?.handledCheckNames.slice(-observed.length), observed);
    assert.equal(updated.github?.handledCheckNames.includes("old-0"), false);
  } finally {
    await t.cleanup();
  }
});

test("successful worker completion auto replies and resolves when enabled", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: true, handledThreadIds: [], handledCheckNames: [] },
    });
    const calls: string[][] = [];
    const gh = { run: async (args: string[]) => { calls.push(args); return "{}"; } };
    const completedAt = "2026-01-01T00:00:00.000Z";
    await handleSuccessfulWorkerComplete(t.store, gh, goal, { type: "complete", goalId: "g", runId: "r", timestamp: completedAt, status: "success", summary: "done", commitSha: "abc1234", addressedThreadIds: ["t1"] });
    assert.equal(calls.some((args) => args.join(" ").includes("addPullRequestReviewThreadReply")), true);
    assert.equal(calls.some((args) => args.join(" ").includes("resolveReviewThread")), true);
    const events = await readFile(t.store.paths.eventsFile("g"), "utf8");
    assert.match(events, new RegExp(`"timestamp":"${completedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  } finally {
    await t.cleanup();
  }
});

test("auto reply and resolve failures are nonfatal events", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: true, handledThreadIds: [], handledCheckNames: [] },
    });
    const gh = { run: async () => { throw new Error("boom"); } };
    const completedAt = "2026-01-01T00:00:00.000Z";
    await handleSuccessfulWorkerComplete(t.store, gh, goal, { type: "complete", goalId: "g", runId: "r", timestamp: completedAt, status: "success", summary: "done", commitSha: "abc1234", addressedThreadIds: ["t1"] });
    const events = await readFile(t.store.paths.eventsFile("g"), "utf8");
    assert.match(events, /Auto-reply\/resolve failed/);
    assert.match(events, new RegExp(`"timestamp":"${completedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.equal((await t.store.get("g")).state, "active");
  } finally {
    await t.cleanup();
  }
});

test("notification failure is nonfatal", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await notifyNonFatal(t.store, { name: "bad", notify: async () => { throw new Error("boom"); } }, goal, { type: "progress", goalId: "g", timestamp: new Date().toISOString(), message: "hi" });
    assert.equal((await t.store.get("g")).state, "active");
    assert.equal(createDefaultNotificationSink().name, "noop");
  } finally {
    await t.cleanup();
  }
});

test("notification event logging failures are nonfatal", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await mkdir(t.store.paths.eventsFile("g"));
    const event = { type: "progress" as const, goalId: "g", timestamp: new Date().toISOString(), message: "hi" };
    await notifyNonFatal(t.store, { name: "ok", notify: async () => {} }, goal, event);
    await notifyNonFatal(t.store, { name: "bad", notify: async () => { throw new Error("boom"); } }, goal, event);
    assert.equal((await t.store.get("g")).state, "active");
  } finally {
    await t.cleanup();
  }
});

test("notification events use triggering event timestamp", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    const eventAt = "2026-01-01T12:34:56.000Z";
    await notifyNonFatal(t.store, { name: "ok", notify: async () => {} }, goal, { type: "progress", goalId: "g", runId: "r", timestamp: eventAt, message: "hi" });
    await notifyNonFatal(t.store, { name: "bad", notify: async () => { throw new Error("boom"); } }, goal, { type: "progress", goalId: "g", runId: "r", timestamp: eventAt, message: "hi" });
    const events = (await readFile(t.store.paths.eventsFile("g"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { timestamp: string });
    assert.deepEqual(events.map((event) => event.timestamp), [eventAt, eventAt]);
  } finally {
    await t.cleanup();
  }
});

test("notification command timeout is recorded as nonfatal failure", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await notifyNonFatal(
      t.store,
      new CommandNotificationSink(process.execPath, ["-e", "setTimeout(() => {}, 10000);"], "slow", 50),
      goal,
      { type: "progress", goalId: "g", timestamp: new Date().toISOString(), message: "hi" },
    );
    const events = await readFile(t.store.paths.eventsFile("g"), "utf8");
    assert.match(events, /"status":"failed"/);
    assert.equal((await t.store.get("g")).state, "active");
  } finally {
    await t.cleanup();
  }
});

test("notification command receives payload by temp file instead of environment", async () => {
  const t = await tempStore();
  try {
    const outputFile = path.join(t.store.paths.root, "notification-output.txt");
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await notifyNonFatal(
      t.store,
      new CommandNotificationSink(
        process.execPath,
        [
          "-e",
          [
            "const fs = require('fs');",
            "if (process.env.PI_GOAL_NOTIFICATION) process.exit(3);",
            "const payload = JSON.parse(fs.readFileSync(process.env.PI_GOAL_NOTIFICATION_FILE, 'utf8'));",
            "fs.writeFileSync(process.argv[1], `${payload.goalId}:${payload.event.message}:${fs.existsSync(process.env.PI_GOAL_NOTIFICATION_FILE)}`);",
          ].join(""),
          outputFile,
        ],
        "file",
      ),
      goal,
      { type: "progress", goalId: "g", timestamp: new Date().toISOString(), message: "hi" },
    );
    assert.equal(await readFile(outputFile, "utf8"), "g:hi:true");
  } finally {
    await t.cleanup();
  }
});

test("notification command payload file uses restrictive permissions", async () => {
  if (process.platform === "win32") return;
  const t = await tempStore();
  try {
    const outputFile = path.join(t.store.paths.root, "notification-mode.txt");
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await notifyNonFatal(
      t.store,
      new CommandNotificationSink(
        process.execPath,
        [
          "-e",
          "require('fs').writeFileSync(process.argv[1], String(require('fs').statSync(process.env.PI_GOAL_NOTIFICATION_FILE).mode & 0o777));",
          outputFile,
        ],
        "file",
      ),
      goal,
      { type: "progress", goalId: "g", timestamp: new Date().toISOString(), message: "hi" },
    );
    assert.equal(await readFile(outputFile, "utf8"), String(0o600));
  } finally {
    await t.cleanup();
  }
});

test("notification args from env preserve quoted empty arguments", async () => {
  const t = await tempStore();
  const previousCommand = process.env.PI_GOAL_NOTIFY_COMMAND;
  const previousArgs = process.env.PI_GOAL_NOTIFY_ARGS;
  const previousRelayCommand = process.env.PIRELAY_NOTIFY_COMMAND;
  const previousRelayArgs = process.env.PIRELAY_NOTIFY_ARGS;
  try {
    const outputFile = path.join(t.store.paths.root, "notify-empty-arg.txt");
    process.env.PI_GOAL_NOTIFY_COMMAND = process.execPath;
    process.env.PI_GOAL_NOTIFY_ARGS = `-e 'if (process.argv[1] !== "") process.exit(2); require("fs").writeFileSync(process.argv[2], "ok")' "" ${outputFile}`;
    delete process.env.PIRELAY_NOTIFY_COMMAND;
    delete process.env.PIRELAY_NOTIFY_ARGS;
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await notifyNonFatal(t.store, createDefaultNotificationSink(), goal, { type: "progress", goalId: "g", timestamp: new Date().toISOString(), message: "hi" });
    assert.equal(await readFile(outputFile, "utf8"), "ok");
  } finally {
    if (previousCommand === undefined) delete process.env.PI_GOAL_NOTIFY_COMMAND;
    else process.env.PI_GOAL_NOTIFY_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.PI_GOAL_NOTIFY_ARGS;
    else process.env.PI_GOAL_NOTIFY_ARGS = previousArgs;
    if (previousRelayCommand === undefined) delete process.env.PIRELAY_NOTIFY_COMMAND;
    else process.env.PIRELAY_NOTIFY_COMMAND = previousRelayCommand;
    if (previousRelayArgs === undefined) delete process.env.PIRELAY_NOTIFY_ARGS;
    else process.env.PIRELAY_NOTIFY_ARGS = previousRelayArgs;
    await t.cleanup();
  }
});

test("notification args from env are split with quote awareness", async () => {
  const t = await tempStore();
  const previousCommand = process.env.PI_GOAL_NOTIFY_COMMAND;
  const previousArgs = process.env.PI_GOAL_NOTIFY_ARGS;
  const previousRelayCommand = process.env.PIRELAY_NOTIFY_COMMAND;
  const previousRelayArgs = process.env.PIRELAY_NOTIFY_ARGS;
  try {
    const outputFile = path.join(t.store.paths.root, "notify-args.txt");
    process.env.PI_GOAL_NOTIFY_COMMAND = process.execPath;
    process.env.PI_GOAL_NOTIFY_ARGS = `-e 'require("fs").writeFileSync(process.argv[1], process.argv[2])' ${outputFile} "two words"`;
    delete process.env.PIRELAY_NOTIFY_COMMAND;
    delete process.env.PIRELAY_NOTIFY_ARGS;
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await notifyNonFatal(t.store, createDefaultNotificationSink(), goal, { type: "progress", goalId: "g", timestamp: new Date().toISOString(), message: "hi" });
    assert.equal(await readFile(outputFile, "utf8"), "two words");
  } finally {
    if (previousCommand === undefined) delete process.env.PI_GOAL_NOTIFY_COMMAND;
    else process.env.PI_GOAL_NOTIFY_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.PI_GOAL_NOTIFY_ARGS;
    else process.env.PI_GOAL_NOTIFY_ARGS = previousArgs;
    if (previousRelayCommand === undefined) delete process.env.PIRELAY_NOTIFY_COMMAND;
    else process.env.PIRELAY_NOTIFY_COMMAND = previousRelayCommand;
    if (previousRelayArgs === undefined) delete process.env.PIRELAY_NOTIFY_ARGS;
    else process.env.PIRELAY_NOTIFY_ARGS = previousRelayArgs;
    await t.cleanup();
  }
});
