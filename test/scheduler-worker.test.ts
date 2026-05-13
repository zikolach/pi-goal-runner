import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoalStore } from "../src/state/store.js";
import { defaultSchedule } from "../src/policy.js";
import { selectDueGoals, schedulerTick } from "../src/scheduler.js";
import { ingestWorkerEvent, launchWorker } from "../src/worker/subprocess.js";
import { createDefaultNotificationSink, notifyNonFatal } from "../src/notifications.js";

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

test("worker event ingestion records decisions, completion, failures", async () => {
  const t = await tempStore();
  try {
    await t.store.create({ id: "g", type: "github_pr_review", state: "running", summary: "g", schedule: defaultSchedule(), runHistory: [{ id: "r", startedAt: "", status: "running" }] });
    await ingestWorkerEvent(t.store, "g", "r", { type: "decision", goalId: "g", runId: "r", timestamp: new Date().toISOString(), decision: { id: "d", goalId: "g", runId: "r", prompt: "Choose", options: [{ id: "x", label: "X" }], createdAt: "", status: "pending", required: true } });
    assert.equal((await t.store.get("g")).state, "needs_decision");
    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: new Date().toISOString(), status: "success", summary: "done", commitSha: "abc" });
    assert.equal((await t.store.get("g")).lastRunSummary, "done");
    await ingestWorkerEvent(t.store, "g", "r", { type: "complete", goalId: "g", runId: "r", timestamp: new Date().toISOString(), status: "quiet", summary: "quiet" });
    assert.equal((await t.store.get("g")).state, "completed");
  } finally {
    await t.cleanup();
  }
});

test("worker stdout events are serialized in emission order", async () => {
  const t = await tempStore();
  try {
    const goal = await t.store.create({ id: "g", type: "github_pr_review", state: "active", summary: "g", schedule: defaultSchedule() });
    await launchWorker(t.store, goal, "", {
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
