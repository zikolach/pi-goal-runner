import type { ActionableObservation, GithubObservation, GoalRecord, SchedulerResult } from "./types.js";
import type { GoalStore } from "./state/store.js";
import { appendGoalEvent } from "./state/events.js";
import { acquireGoalLock } from "./state/lock.js";
import { applyActionablePolicy, applyNoActionPolicy, isDue, isTerminal, nextCheckAt } from "./policy.js";
import { createGhExecutor, type GhExecutor } from "./github/gh.js";
import { findActionable, observeGithubPr } from "./github/observe.js";
import { buildWorkerPrompt } from "./worker/prompt.js";
import { ensureGoalWorktree } from "./worker/worktree.js";
import { launchWorker, type WorkerLaunchOptions } from "./worker/subprocess.js";
import { createDefaultNotificationSink, notifyNonFatal, type NotificationSink } from "./notifications.js";
import { safeError } from "./redaction.js";

export interface SchedulerOptions {
  gh?: GhExecutor;
  notificationSink?: NotificationSink;
  worker?: WorkerLaunchOptions & { dryRun?: boolean };
  now?: Date;
}

export async function selectDueGoals(store: GoalStore, now = new Date()): Promise<GoalRecord[]> {
  const goals = await store.list();
  return goals.filter((goal) => isDue(goal, now) && !isTerminal(goal.state) && goal.state !== "paused" && goal.state !== "needs_decision" && !goal.pendingDecisions.some((decision) => decision.status === "pending" && decision.required));
}

export function skipReason(goal: GoalRecord, now = new Date()): string | undefined {
  if (isTerminal(goal.state)) return `terminal state ${goal.state}`;
  if (goal.state === "paused") return "paused";
  if (goal.pendingDecisions.some((decision) => decision.status === "pending" && decision.required)) return "waiting for user decision";
  if (!isDue(goal, now)) return `not due until ${goal.schedule.nextCheckAt}`;
  return undefined;
}

export async function schedulerTick(store: GoalStore, options: SchedulerOptions = {}): Promise<SchedulerResult> {
  const gh = options.gh ?? createGhExecutor();
  const sink = options.notificationSink ?? createDefaultNotificationSink();
  const now = options.now ?? new Date();
  const goals = await store.list();
  const result: SchedulerResult = { checked: 0, launched: 0, skipped: 0, failures: 0, messages: [] };
  for (const goal of goals) {
    const reason = skipReason(goal, now);
    if (reason) {
      result.skipped++;
      result.messages.push(`${goal.id}: ${reason}`);
      continue;
    }
    result.checked++;
    const lock = await acquireGoalLock(store.paths, goal.id);
    if (!lock) {
      result.skipped++;
      result.messages.push(`${goal.id}: already running`);
      continue;
    }
    try {
      const launched = await checkGoal(store, goal, gh, sink, options);
      if (launched) result.launched++;
    } catch (error) {
      result.failures++;
      const message = safeError(error);
      await appendGoalEvent(store.paths, { type: "failure", goalId: goal.id, timestamp: new Date().toISOString(), message, retryable: true });
      await store.update(goal.id, (current) => ({ ...current, state: "failed", latestProgress: message, schedule: { ...current.schedule, nextCheckAt: nextCheckAt(current.schedule.backoff) } }));
      result.messages.push(`${goal.id}: ${message}`);
    } finally {
      await lock.release();
    }
  }
  return result;
}

async function checkGoal(store: GoalStore, goal: GoalRecord, gh: GhExecutor, sink: NotificationSink, options: SchedulerOptions): Promise<boolean> {
  if (goal.type !== "github_pr_review" || !goal.github) throw new Error(`Unsupported goal type: ${goal.type}`);
  const observation: GithubObservation = await observeGithubPr(gh, goal.github);
  const actionable: ActionableObservation = findActionable(goal.github, observation);
  await store.update(goal.id, (current) => ({ ...current, github: current.github ? { ...current.github, lastObservedAt: observation.observedAt, repository: { ...current.github.repository, branch: observation.headBranch ?? current.github.repository.branch } } : current.github }));
  if (!actionable.actionable) {
    const updated = applyNoActionPolicy(await store.get(goal.id), observation.observedAt);
    await store.update(goal.id, () => updated);
    if (updated.state === "completed" || updated.state === "dormant") {
      const event = { type: "complete" as const, goalId: goal.id, timestamp: new Date().toISOString(), status: "quiet" as const, summary: `Quiet window expired: ${actionable.reason}` };
      await appendGoalEvent(store.paths, event);
      await notifyNonFatal(store, sink, updated, event);
    }
    return false;
  }
  const actionableGoal = await store.update(goal.id, (current) => applyActionablePolicy(current));
  const worktreeGoal = await ensureGoalWorktree(store, actionableGoal);
  const prompt = buildWorkerPrompt(worktreeGoal, observation, actionable);
  const event = { type: "progress" as const, goalId: goal.id, timestamp: new Date().toISOString(), message: `Launching worker: ${actionable.reason}` };
  await appendGoalEvent(store.paths, event);
  await notifyNonFatal(store, sink, worktreeGoal, event);
  if (options.worker?.dryRun) return true;
  await launchWorker(store, worktreeGoal, prompt, options.worker);
  return true;
}
