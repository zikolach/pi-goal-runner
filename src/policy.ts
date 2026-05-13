import type { BackoffPolicy, GoalRecord, GoalState, QuietWindowPolicy, SchedulePolicy } from "./types.js";

export function defaultBackoff(): BackoffPolicy {
  return { initialMs: 60_000, maxMs: 15 * 60_000, multiplier: 2, currentMs: 60_000 };
}

export function defaultQuietWindow(): QuietWindowPolicy {
  return { durationMs: 2 * 60 * 60_000, onExpire: "completed" };
}

export function defaultSchedule(now = new Date()): SchedulePolicy {
  return {
    nextCheckAt: now.toISOString(),
    backoff: defaultBackoff(),
    quietWindow: defaultQuietWindow(),
  };
}

export function resetBackoff(policy: BackoffPolicy): BackoffPolicy {
  return { ...policy, currentMs: policy.initialMs };
}

export function increaseBackoff(policy: BackoffPolicy): BackoffPolicy {
  const next = Math.min(policy.maxMs, Math.max(policy.initialMs, Math.floor(policy.currentMs * policy.multiplier)));
  return { ...policy, currentMs: next };
}

export function nextCheckAt(backoff: BackoffPolicy, now = new Date()): string {
  return new Date(now.getTime() + backoff.currentMs).toISOString();
}

export function updateQuietWindow(policy: QuietWindowPolicy, actionable: boolean, observedAt: string, now = new Date()): QuietWindowPolicy {
  if (actionable) return { ...policy, quietSince: undefined };
  return { ...policy, quietSince: policy.quietSince ?? observedAt ?? now.toISOString() };
}

export function quietWindowExpired(policy: QuietWindowPolicy, now = new Date()): boolean {
  if (!policy.quietSince) return false;
  return now.getTime() - new Date(policy.quietSince).getTime() >= policy.durationMs;
}

export function applyNoActionPolicy(goal: GoalRecord, observedAt: string, now = new Date()): GoalRecord {
  const quietWindow = updateQuietWindow(goal.schedule.quietWindow, false, observedAt, now);
  const backoff = increaseBackoff(goal.schedule.backoff);
  const expired = quietWindowExpired(quietWindow, now);
  const state: GoalState = expired ? quietWindow.onExpire : goal.state === "running" ? "active" : goal.state;
  return {
    ...goal,
    state,
    updatedAt: now.toISOString(),
    schedule: { ...goal.schedule, quietWindow, backoff, nextCheckAt: expired ? goal.schedule.nextCheckAt : nextCheckAt(backoff, now) },
  };
}

export function applyActionablePolicy(goal: GoalRecord, now = new Date()): GoalRecord {
  const backoff = resetBackoff(goal.schedule.backoff);
  return {
    ...goal,
    state: "active",
    updatedAt: now.toISOString(),
    schedule: { ...goal.schedule, backoff, quietWindow: updateQuietWindow(goal.schedule.quietWindow, true, now.toISOString(), now), nextCheckAt: now.toISOString() },
  };
}

export function isDue(goal: GoalRecord, now = new Date()): boolean {
  return new Date(goal.schedule.nextCheckAt).getTime() <= now.getTime();
}

export function isTerminal(state: GoalState): boolean {
  return state === "completed" || state === "cancelled" || state === "dormant";
}
