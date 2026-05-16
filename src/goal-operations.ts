import type { GoalRecord, GoalState } from "./types.js";
import type { GoalStore } from "./state/store.js";
import { isTerminal } from "./policy.js";
import { withGoalLock } from "./state/lock.js";

export interface GoalActionAvailability {
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canRunNow: boolean;
}

export interface GoalLifecycleResultSuccess {
  ok: true;
  goal: GoalRecord;
  busy: false;
  reason?: string;
}

export interface GoalLifecycleResultBusy {
  ok: false;
  goal?: undefined;
  busy: true;
  reason?: string;
}

export type GoalLifecycleResult = GoalLifecycleResultSuccess | GoalLifecycleResultBusy;

export function getGoalActionAvailability(goal: GoalRecord): GoalActionAvailability {
  const terminal = isTerminal(goal.state);
  const blockedByRequiredDecision = goal.pendingDecisions.some((decision) => decision.status === "pending" && decision.required);
  return {
    canPause: !terminal && goal.state !== "paused" && goal.state !== "running",
    canResume: goal.state === "paused",
    canCancel: !terminal && goal.state !== "running",
    canRunNow: !terminal && goal.state !== "paused" && goal.state !== "running" && !blockedByRequiredDecision,
  };
}

export async function pauseGoal(store: GoalStore, goalId: string): Promise<GoalLifecycleResult> {
  return setGoalState(store, goalId, "paused");
}

export async function resumeGoal(store: GoalStore, goalId: string): Promise<GoalLifecycleResult> {
  return setGoalState(store, goalId, "active");
}

export async function cancelGoal(store: GoalStore, goalId: string): Promise<GoalLifecycleResult> {
  return setGoalState(store, goalId, "cancelled");
}

export async function setGoalState(store: GoalStore, goalId: string, state: GoalState): Promise<GoalLifecycleResult> {
  const result = await withGoalLock(store.paths, goalId, async () => {
    const next = await store.setState(goalId, state);
    return { ok: true as const, goal: next, busy: false as const };
  });
  if (!result) return { ok: false, busy: true, reason: "goal is busy; try again later" };
  return result;
}

export function describeGoalActionAvailability(goal: GoalRecord): string[] {
  const availability = getGoalActionAvailability(goal);
  const actions: string[] = [];
  if (availability.canPause) actions.push("pause");
  if (availability.canResume) actions.push("resume");
  if (availability.canRunNow) actions.push("run-now");
  if (availability.canCancel) actions.push("cancel");
  return actions;
}
