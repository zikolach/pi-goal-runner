import assert from "node:assert/strict";
import test from "node:test";
import { defaultSchedule } from "../src/policy.js";
import type { GoalRecord } from "../src/types.js";
import { GoalManagerDialog } from "../src/goal-management-ui.js";
import type { GoalManagerCallbacks } from "../src/goal-management-ui.js";

function makeGoal(overrides: Partial<GoalRecord>): GoalRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "goal-1",
    type: "github_pr_review",
    state: "active",
    createdAt: now,
    updatedAt: now,
    summary: "Long summary for a PR review goal",
    schedule: defaultSchedule(new Date(now)),
    runHistory: [],
    pendingDecisions: [],
    ...overrides,
  };
}

function createCallbacks(log: {
  refreshGoals?: () => void;
  refreshGoal?: () => void;
  pause?: () => void;
  resume?: () => void;
  cancel?: () => void;
  runNow?: () => void;
} = {}): {
  goalCalls: {
    list: number;
    detail: number;
    pause: number;
    resume: number;
    cancel: number;
    runNow: number;
  };
  callbacks: GoalManagerCallbacks;
} {
  const calls = { list: 0, detail: 0, pause: 0, resume: 0, cancel: 0, runNow: 0 };
  return {
    goalCalls: calls,
    callbacks: {
      loadGoals: async () => {
        calls.list++;
        log.refreshGoals?.();
        return [makeGoal({ id: "goal-1", state: "active" }), makeGoal({ id: "goal-2", state: "paused" })];
      },
      loadGoal: async () => {
        calls.detail++;
        log.refreshGoal?.();
        return makeGoal({ id: "goal-1", state: "active" });
      },
      pauseGoal: async () => {
        calls.pause++;
        log.pause?.();
        return { ok: true };
      },
      resumeGoal: async () => {
        calls.resume++;
        log.resume?.();
        return { ok: true };
      },
      cancelGoal: async () => {
        calls.cancel++;
        log.cancel?.();
        return { ok: true };
      },
      runGoalNow: async () => {
        calls.runNow++;
        log.runNow?.();
        return { ok: true };
      },
      notify: () => {},
    },
  };
}

test("goal manager renders empty list view with close hint", () => {
  const callbacks = createCallbacks().callbacks;
  callbacks.loadGoals = async () => [];
  callbacks.loadGoal = async () => undefined;
  const dialog = new GoalManagerDialog([], callbacks, () => {}, () => {});
  const lines = dialog.render(40);
  assert.equal(lines.some((line) => line.includes("No goals found.")), true);
  assert.equal(lines.some((line) => line.includes("Press r to refresh, q/esc to close.")), true);
  assert.equal(lines.every((line) => line.length <= 40), true);
  assert.equal(lines[0].startsWith("╭") && lines[0].endsWith("╮"), true);
});

test("goal manager recognizes escape input variants as back/close", () => {
  let closed = 0;
  const dialog = new GoalManagerDialog([makeGoal({ id: "goal-1", state: "active" })], createCallbacks().callbacks, () => {}, () => {
    closed += 1;
  });
  dialog.handleInput("\u001b");
  assert.equal(closed, 1);

  const dialogKitty = new GoalManagerDialog([makeGoal({ id: "goal-1", state: "active" })], createCallbacks().callbacks, () => {}, () => {
    closed += 1;
  });
  dialogKitty.handleInput("\u001b[27;1u");
  assert.equal(closed, 2);

  const dialogAlt = new GoalManagerDialog([makeGoal({ id: "goal-1", state: "active" })], createCallbacks().callbacks, () => {}, () => {
    closed += 1;
  });
  dialogAlt.handleInput("Esc");
  dialogAlt.handleInput("ctrl+c");
  dialogAlt.handleInput("escape");
  assert.equal(closed, 5);

  let detailClosed = 0;
  const dialogWithDetail = new GoalManagerDialog([makeGoal({ id: "goal-1", state: "active" })], createCallbacks().callbacks, () => {}, () => {
    detailClosed += 1;
  });
  dialogWithDetail.handleInput("enter");
  dialogWithDetail.handleInput("\u001b");
  const detailLines = dialogWithDetail.render(40);
  assert.equal(detailClosed, 0);
  assert.equal(detailLines.some((line) => line.includes("Goal manager")), true);
});

test("goal manager wraps long table cells instead of only ellipsizing", () => {
  const longSummary = Array.from({ length: 40 }, (_, index) => `cell-${String(index).padStart(2, "0")}`).join(" ");
  const dialog = new GoalManagerDialog(
    [
      makeGoal({
        id: "very-long-goal-id-that-would-force-wrap-0001",
        state: "active",
        summary: longSummary,
        pendingDecisions: [],
      }),
    ],
    createCallbacks().callbacks,
    () => {},
    () => {},
  );

  const lines = dialog.render(60);
  assert.equal(lines.some((line) => line.includes("Summary") || line.includes("Target") || line.includes("Actions")), true);

  dialog.handleInput("enter");
  const detailLines = dialog.render(60);
  const bodyLines = lines.slice(3);
  const wrappedLines = detailLines.slice(3).filter((line) => /\|/.test(line) && !/Property \| Value/.test(line) && !/─┼─/.test(line));
  assert.equal(wrappedLines.length >= 4, true);
});

test("goal manager preserves multiline field text in wrapped detail rows", () => {
  const dialog = new GoalManagerDialog(
    [
      makeGoal({
        id: "goal-newline",
        state: "active",
        latestProgress: "Latest progress line one\nline two has detail\nline three has more details",
      }),
    ],
    createCallbacks().callbacks,
    () => {},
    () => {},
  );

  dialog.handleInput("enter");
  const lines = dialog.render(80);
  const body = lines.join("\n");
  assert.equal(body.includes("Latest progress line one"), true);
  assert.equal(body.includes("line two has detail"), true);
  assert.equal(body.includes("line three has more details"), true);

  const hasRawNewlineInRow = lines.some((line) => line.includes("\n"));
  assert.equal(hasRawNewlineInRow, false);
});

test("goal manager supports empty-line width-safe rendering for long values", () => {
  const goals = [
    makeGoal({
      id: "very-long-goal-id-that-would-overflow",
      summary: "This is an extremely long summary text that must be truncated for narrow rendering contexts",
      state: "active",
      pendingDecisions: [],
    }),
  ];
  const dialog = new GoalManagerDialog(goals, createCallbacks().callbacks, () => {}, () => {});
  dialog.handleInput("enter");
  const lines = dialog.render(16);
  assert.equal(lines.every((line) => line.length <= 16), true);
});

test("goal manager renders list and detail views with expected fields and actions", () => {
  const dialog = new GoalManagerDialog([makeGoal({ id: "goal-active", state: "active" })], createCallbacks().callbacks, () => {}, () => {});
  const listLines = dialog.render(120);
  assert.equal(listLines.some((line) => line.includes("goal-active")), true);
  dialog.handleInput("enter");
  const detailLines = dialog.render(120);
  assert.equal(detailLines.some((line) => line.includes("State") && line.includes("active")), true);
  assert.equal(detailLines.some((line) => line.includes("Latest progress")), true);
  assert.equal(detailLines.some((line) => line.includes("Actions")), true);
});

test("goal manager uses table layout for list and detail", () => {
  const dialog = new GoalManagerDialog([makeGoal({ id: "goal-1", state: "active" })], createCallbacks().callbacks, () => {}, () => {});
  const listLines = dialog.render(120);
  assert.equal(listLines.some((line) => line.includes("Sel") && line.includes("Target") && line.includes("|") && line.includes("Actions")), true);

  dialog.handleInput("enter");
  const detailLines = dialog.render(120);
  assert.equal(detailLines.some((line) => line.includes("Property") && line.includes("Value") && line.includes("|")), true);
});

test("goal manager refresh actions do not call action callbacks", async () => {
  const log = {
    refreshGoals: () => {},
  };
  const { goalCalls, callbacks } = createCallbacks(log);
  const dialog = new GoalManagerDialog([makeGoal({ id: "goal-1", state: "active" })], callbacks, () => {}, () => {});
  dialog.handleInput("r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(goalCalls.list, 1);
  assert.equal(goalCalls.runNow, 0);

  dialog.handleInput("enter");
  dialog.handleInput("r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(goalCalls.detail, 1);
  assert.equal(goalCalls.runNow, 0);
});

test("goal manager shows and handles cancellation confirmation and abort without state changes", async () => {
  const counters = { cancel: 0 };
  const { callbacks } = createCallbacks({
    cancel: () => {
      counters.cancel += 1;
    },
  });
  const dialog = new GoalManagerDialog([makeGoal({ id: "goal-1", state: "active", pendingDecisions: [] })], callbacks, () => {}, () => {});
  dialog.handleInput("enter");
  dialog.handleInput("c");
  assert.equal(dialog.render(80).some((line) => line.includes("Cancel goal-1?")), true);

  dialog.handleInput("n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(counters.cancel, 0);
  assert.equal(dialog.render(80).some((line) => line.includes("State") && line.includes("active")), true);

  dialog.handleInput("c");
  dialog.handleInput("enter");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(counters.cancel, 1);
});

for (const [state, expected] of [
  ["active", "p:pause"],
  ["paused", "p:resume"],
  ["running", "(none)"],
  ["completed", "(none)"],
  ["failed", "p:pause"],
  ["dormant", "(none)"],
  ["cancelled", "(none)"],
] as const) {
  test(`goal manager detail hides invalid actions for ${state}`, () => {
    const dialog = new GoalManagerDialog([makeGoal({ id: `goal-${state}`, state })], createCallbacks().callbacks, () => {}, () => {});
    dialog.handleInput("enter");
    const lines = dialog.render(120);
    const actions = lines.find((line) => line.includes("Actions")) ?? "";
    assert.ok(actions.includes(expected), `${state} actions mismatch: ${actions}`);
  });
}

test("goal manager keeps list height stable after leaving detail view", () => {
  const dialog = new GoalManagerDialog([makeGoal({ id: "goal-1", state: "active" })], createCallbacks().callbacks, () => {}, () => {});
  const listLines = dialog.render(80);
  dialog.handleInput("enter");
  const detailLines = dialog.render(80);
  dialog.handleInput("b");
  const backToListLines = dialog.render(80);

  assert.equal(detailLines.length > listLines.length, true);
  assert.equal(backToListLines.length, detailLines.length);
});
