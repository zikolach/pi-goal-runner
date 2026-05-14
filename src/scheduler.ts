import type { ActionableObservation, CompleteEvent, GithubObservation, GoalRecord, SchedulerResult } from "./types.js";
import type { GoalStore } from "./state/store.js";
import { appendGoalEvent } from "./state/events.js";
import { acquireGoalLock } from "./state/lock.js";
import { applyActionablePolicy, applyNoActionPolicy, increaseBackoff, isDue, isTerminal, nextCheckAt } from "./policy.js";
import { createGhExecutor, type GhExecutor } from "./github/gh.js";
import { appendRecentUnique, MAX_HANDLED_CHECK_NAMES } from "./github/handled.js";
import { findActionable, observeGithubPr } from "./github/observe.js";
import { replyAndResolveAddressedThreads } from "./github/update.js";
import { buildWorkerPrompt } from "./worker/prompt.js";
import { ensureGoalWorktree } from "./worker/worktree.js";
import { DEFAULT_WORKER_TIMEOUT_MS, startWorker, type WorkerLaunchOptions } from "./worker/subprocess.js";
import { createDefaultNotificationSink, notifyNonFatal, type NotificationSink } from "./notifications.js";
import { safeError } from "./redaction.js";

export interface SchedulerOptions {
  gh?: GhExecutor;
  notificationSink?: NotificationSink;
  worker?: WorkerLaunchOptions & { dryRun?: boolean };
  now?: Date;
}

export const WORKER_LOCK_STALE_BUFFER_MS = 5 * 60_000;

export async function selectDueGoals(store: GoalStore, now = new Date()): Promise<GoalRecord[]> {
  const goals = await store.list();
  return goals.filter((goal) => !skipReason(goal, now));
}

export function skipReason(goal: GoalRecord, now = new Date()): string | undefined {
  if (isTerminal(goal.state)) return `terminal state ${goal.state}`;
  if (goal.state === "paused") return "paused";
  if (goal.state === "needs_decision") return "waiting for user decision";
  if (goal.pendingDecisions.some((decision) => decision.status === "pending")) return "waiting for user decision";
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
    const lock = await acquireGoalLock(store.paths, goal.id, schedulerLockStaleMs(options.worker));
    if (!lock) {
      result.skipped++;
      result.messages.push(`${goal.id}: already running`);
      continue;
    }
    let releaseLock = true;
    try {
      const lockedGoal = await store.get(goal.id);
      const lockedReason = skipReason(lockedGoal, now);
      if (lockedReason) {
        result.skipped++;
        result.messages.push(`${goal.id}: ${lockedReason}`);
        continue;
      }
      if (lockedGoal.state === "running") {
        result.failures++;
        const message = "Recovered abandoned running goal after missing or stale worker lock";
        await appendGoalEvent(store.paths, { type: "failure", goalId: goal.id, timestamp: now.toISOString(), message, retryable: true });
        await store.update(goal.id, (current) => {
          const backoff = increaseBackoff(current.schedule.backoff);
          return {
            ...current,
            state: "failed",
            updatedAt: now.toISOString(),
            latestProgress: message,
            runHistory: current.runHistory.map((run, index) => index === current.runHistory.length - 1 && run.status === "running" ? { ...run, completedAt: now.toISOString(), status: "failed" as const, summary: message } : run),
            schedule: { ...current.schedule, backoff, nextCheckAt: nextCheckAt(backoff, now) },
          };
        }, { updatedAt: now.toISOString() });
        result.messages.push(`${goal.id}: ${message}`);
        continue;
      }
      const outcome = await checkGoal(store, lockedGoal, gh, sink, options);
      if (outcome.launched) result.launched++;
      if (outcome.workerDone) {
        releaseLock = false;
        releaseLockAfterWorker(outcome.workerDone, lock.release);
      }
    } catch (error) {
      result.failures++;
      const message = safeError(error);
      await appendGoalEvent(store.paths, { type: "failure", goalId: goal.id, timestamp: now.toISOString(), message, retryable: true });
      await store.update(goal.id, (current) => {
        const updatedAt = now.toISOString();
        const backoff = increaseBackoff(current.schedule.backoff);
        return { ...current, state: "failed", updatedAt, latestProgress: message, schedule: { ...current.schedule, backoff, nextCheckAt: nextCheckAt(backoff, now) } };
      }, { updatedAt: now.toISOString() });
      result.messages.push(`${goal.id}: ${message}`);
    } finally {
      if (releaseLock) await lock.release();
    }
  }
  return result;
}

interface CheckGoalResult {
  launched: boolean;
  workerDone?: Promise<GoalRecord>;
}

function schedulerLockStaleMs(worker: SchedulerOptions["worker"]): number {
  const timeoutMs = worker?.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) return DEFAULT_WORKER_TIMEOUT_MS + WORKER_LOCK_STALE_BUFFER_MS;
  return timeoutMs + WORKER_LOCK_STALE_BUFFER_MS;
}

function releaseLockAfterWorker(workerDone: Promise<GoalRecord>, release: () => Promise<void>): void {
  void (async () => {
    try {
      await workerDone;
    } finally {
      await release();
    }
  })().catch(() => undefined);
}

async function checkGoal(store: GoalStore, goal: GoalRecord, gh: GhExecutor, sink: NotificationSink, options: SchedulerOptions): Promise<CheckGoalResult> {
  const now = options.now ?? new Date();
  if (goal.type !== "github_pr_review" || !goal.github) throw new Error(`Unsupported goal type: ${goal.type}`);
  const observation: GithubObservation = await observeGithubPr(gh, goal.github, { now });
  const actionable: ActionableObservation = findActionable(goal.github, observation);
  await store.update(
    goal.id,
    (current) => ({
      ...current,
      updatedAt: now.toISOString(),
      github: current.github ? { ...current.github, lastObservedAt: observation.observedAt, repository: { ...current.github.repository, branch: observation.headBranch ?? current.github.repository.branch } } : current.github,
    }),
    { updatedAt: now.toISOString() },
  );
  if (!actionable.actionable) {
    const updated = applyNoActionPolicy(await store.get(goal.id), observation.observedAt, now);
    await store.update(goal.id, () => updated, { updatedAt: now.toISOString() });
    if (updated.state === "completed" || updated.state === "dormant") {
      const event = { type: "complete" as const, goalId: goal.id, timestamp: now.toISOString(), status: "quiet" as const, summary: `Quiet window expired: ${actionable.reason}` };
      await appendGoalEvent(store.paths, event);
      await notifyNonFatal(store, sink, updated, event);
    }
    return { launched: false };
  }
  const actionableGoal = await store.update(goal.id, (current) => applyActionablePolicy(current, now), { updatedAt: now.toISOString() });
  const worktreeGoal = await ensureGoalWorktree(store, actionableGoal, { updatedAt: now.toISOString() });
  const prompt = buildWorkerPrompt(worktreeGoal, observation, actionable);
  const event = { type: "progress" as const, goalId: goal.id, timestamp: now.toISOString(), message: `Launching worker: ${actionable.reason}` };
  await appendGoalEvent(store.paths, event);
  await notifyNonFatal(store, sink, worktreeGoal, event);
  if (options.worker?.dryRun) {
    await store.update(goal.id, (current) => ({
      ...current,
      updatedAt: now.toISOString(),
      latestProgress: event.message,
      schedule: { ...current.schedule, nextCheckAt: nextCheckAt(current.schedule.backoff, now) },
    }), { updatedAt: now.toISOString() });
    return { launched: true };
  }
  const workerRun = await startWorker(store, worktreeGoal, prompt, {
    ...options.worker,
    onComplete: async (completeEvent) => handleSuccessfulWorkerComplete(store, gh, worktreeGoal, completeEvent, actionable.checks.map((check) => check.name)),
  });
  return { launched: true, workerDone: workerRun.done };
}

export async function handleSuccessfulWorkerComplete(store: GoalStore, gh: GhExecutor, goal: GoalRecord, event: CompleteEvent, handledCheckNames: string[] = []): Promise<void> {
  if (!goal.github) return;
  if (handledCheckNames.length > 0) {
    await store.update(goal.id, (current) => ({
      ...current,
      github: current.github ? { ...current.github, handledCheckNames: appendRecentUnique(current.github.handledCheckNames, handledCheckNames, MAX_HANDLED_CHECK_NAMES) } : current.github,
    }), { updatedAt: event.timestamp });
  }
  if (!goal.github.autoReplyAndResolve) return;
  try {
    const resolvedThreadIds = await replyAndResolveAddressedThreads(gh, goal.github, event);
    if (resolvedThreadIds.length > 0) {
      await appendGoalEvent(store.paths, {
        type: "diagnostic",
        goalId: goal.id,
        runId: event.runId,
        timestamp: event.timestamp,
        message: `Auto-replied and resolved ${resolvedThreadIds.length} GitHub review thread(s)`,
      });
    }
  } catch (error) {
    await appendGoalEvent(store.paths, {
      type: "failure",
      goalId: goal.id,
      runId: event.runId,
      timestamp: event.timestamp,
      message: `Auto-reply/resolve failed: ${safeError(error)}`,
      retryable: true,
    });
  }
}
