import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoalStore } from "../src/state/store.js";
import { defaultSchedule } from "../src/policy.js";
import { handleSuccessfulWorkerComplete, selectDueGoals, schedulerTick } from "../src/scheduler.js";
import { ingestWorkerEvent, launchWorker, MAX_WORKER_STDOUT_BUFFER_CHARS } from "../src/worker/subprocess.js";
import { CommandNotificationSink, createDefaultNotificationSink, notifyNonFatal } from "../src/notifications.js";

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-runner-scheduler-"));
  return { store: createGoalStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
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
    assert.deepEqual((await selectDueGoals(t.store, new Date("2026-01-01T00:00:01Z"))).map((g) => g.id), ["a"]);
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
    assert.equal(updated.schedule.nextCheckAt, "2026-01-01T01:02:00.000Z");
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
    assert.equal(updated.schedule.backoff.currentMs, 120_000);
    assert.equal(updated.schedule.nextCheckAt, "2026-01-01T00:02:00.000Z");
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
    await t.store.create({ id: "g", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    const decisionAt = "2026-01-01T00:00:00Z";
    await ingestWorkerEvent(t.store, "g", "r", { type: "decision", goalId: "g", runId: "r", timestamp: decisionAt, decision: { id: "d", goalId: "g", runId: "r", prompt: "Choose", options: [{ id: "x", label: "X" }], createdAt: "", status: "pending", required: true } });
    const decisionGoal = await t.store.get("g");
    assert.equal(decisionGoal.state, "needs_decision");
    assert.equal(decisionGoal.runHistory.at(-1)?.completedAt, decisionAt);
    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: new Date().toISOString(), status: "success", summary: "done", commitSha: "abc" });
    assert.equal((await t.store.get("g")).lastRunSummary, "done");
    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: new Date().toISOString(), status: "quiet", summary: "quiet" });
    assert.equal((await t.store.get("g")).state, "completed");
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
    await ingestWorkerEvent(t.store, "g", "r", { type: "failure", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:01Z", message: "late process exit", retryable: true });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "active");
    assert.equal(updated.runHistory.at(-1)?.status, "success");
    assert.equal(updated.latestProgress, "done");
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
          "console.log(JSON.stringify({type:'decision', decision:{id:'d', prompt:'Pick', options:[{id:'x', label:'X'}]}}));",
          "console.log(JSON.stringify({type:'complete', status:'success', summary:'done'}));",
        ].join(""),
      ],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.pendingDecisions.some((decision) => decision.id === "d"), true);
    assert.equal(updated.lastRunSummary, "done");
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

test("worker decision terminal event is not overridden by non-zero exit", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
      command: process.execPath,
      args: [
        "-e",
        [
          "console.log(JSON.stringify({type:'decision', decision:{id:'d', prompt:'Pick', options:[{id:'x', label:'X'}]}}));",
          "process.exit(7);",
        ].join(""),
      ],
    });
    const updated = await t.store.get("g");
    assert.equal(updated.state, "needs_decision");
    assert.equal(updated.runHistory.at(-1)?.status, "needs_decision");
    assert.equal(updated.pendingDecisions.some((decision) => decision.id === "d" && decision.status === "pending"), true);
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

test("stale completion does not advance handled timestamps", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }], github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] } });
    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", status: "stale", summary: "stale", addressedThreadIds: ["t1"] });
    assert.equal((await t.store.get("g")).github?.lastHandledAt, undefined);
    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: "2026-01-01T00:00:01Z", status: "success", summary: "done", addressedThreadIds: ["t1"] });
    const updated = await t.store.get("g");
    assert.equal(updated.github?.lastHandledAt, "2026-01-01T00:00:01Z");
    assert.deepEqual(updated.github?.handledThreadIds, ["t1"]);
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
      github: { repository: { owner: "o", repo: "r" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });
    const gh = { run: async (_args: string[]) => "{}" };
    await handleSuccessfulWorkerComplete(t.store, gh, goal, { type: "complete", goalId: "g", runId: "r", timestamp: new Date().toISOString(), status: "success", summary: "done", commitSha: "abc" }, ["ci", "lint"]);
    assert.deepEqual((await t.store.get("g")).github?.handledCheckNames, ["ci", "lint"]);
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
