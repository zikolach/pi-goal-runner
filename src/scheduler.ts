import type { CompleteEvent, GoalRecord, SchedulerResult } from "./types.js";
import type { GoalStore } from "./state/store.js";
import { appendGoalEvent } from "./state/events.js";
import { acquireGoalLock } from "./state/lock.js";
import { applyActionablePolicy, applyNoActionPolicy, increaseBackoff, isDue, isTerminal, nextCheckAt } from "./policy.js";
import { createGhExecutor, type GhExecutor } from "./github/gh.js";
import { getGoalAdapter } from "./adapters/registry.js";
import { DEFAULT_WORKER_TIMEOUT_MS, startWorker, type WorkerLaunchOptions } from "./worker/subprocess.js";
import { createDefaultNotificationSink, notifyNonFatal, type NotificationSink } from "./notifications.js";
import { safeError } from "./redaction.js";
import type { GoalActionability, PreparedWorkerInput } from "./adapters/types.js";

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
  if (goal.state === "needs_decision") return "waiting for required user decision";
  if (goal.pendingDecisions.some((decision) => decision.status === "pending" && decision.required)) return "waiting for required user decision";
  if (!isDue(goal, now)) return `not due until ${goal.schedule.nextCheckAt}`;
  return undefined;
}

export interface RunNowResult {
  goalId: string;
  checked: number;
  launched: number;
  skipped: number;
  failures: number;
  messages: string[];
  workerDone?: Promise<GoalRecord>;
}

export async function runGoalNow(store: GoalStore, goalId: string, options: SchedulerOptions = {}): Promise<RunNowResult> {
  const gh = options.gh ?? createGhExecutor();
  const sink = options.notificationSink ?? createDefaultNotificationSink();
  const now = options.now ?? new Date();
  const result: RunNowResult = { goalId, checked: 0, launched: 0, skipped: 0, failures: 0, messages: [] };

  const lock = await acquireGoalLock(store.paths, goalId, schedulerLockStaleMs(options.worker));
  if (!lock) {
    result.skipped++;
    result.messages.push(`${goalId}: goal is already being processed`);
    return result;
  }

  let releaseLock = true;
  try {
    const goal = await store.get(goalId);
    if (goal.state === "running") {
      result.skipped++;
      result.messages.push(`${goalId}: already running`);
      return result;
    }
    const reason = skipReason(goal, now);
    const restoreNextCheckAt = reason?.startsWith("not due until") ? goal.schedule.nextCheckAt : undefined;
    if (reason && !restoreNextCheckAt) {
      result.skipped++;
      result.messages.push(`${goalId}: ${reason}`);
      return result;
    }

    const checkResult = await checkGoal(store, goal, gh, sink, options);
    result.checked = 1;
    result.launched = checkResult.launched ? 1 : 0;
    if (restoreNextCheckAt && !checkResult.launched) {
      await store.update(goalId, (current) => ({ ...current, schedule: { ...current.schedule, nextCheckAt: restoreNextCheckAt } }), { updatedAt: now.toISOString() });
    }
    if (checkResult.workerDone) {
      releaseLock = false;
      result.workerDone = checkResult.workerDone;
      releaseLockAfterWorker(checkResult.workerDone, lock.release);
    }
  } catch (error) {
    result.failures++;
    const message = safeError(error);
    await appendGoalEvent(store.paths, { type: "failure", goalId, timestamp: now.toISOString(), message, retryable: true });
    await store.update(goalId, (current) => {
      const backoff = increaseBackoff(current.schedule.backoff);
      const updatedAt = now.toISOString();
      return { ...current, state: "failed", updatedAt, latestProgress: message, schedule: { ...current.schedule, backoff, nextCheckAt: nextCheckAt(backoff, now) } };
    }, { updatedAt: now.toISOString() });
    result.messages.push(`${goalId}: ${message}`);
  } finally {
    if (releaseLock) await lock.release();
  }

  return result;
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
  const adapter = getGoalAdapter(goal.type);
  if (!adapter) throw new Error(`Unsupported goal type: ${goal.type}`);
  const context = { store, gh, now };
  const observation = await adapter.observe(goal, context);
  const actionable: GoalActionability = await adapter.analyze(goal, observation, context);
  await adapter.recordObservation?.(goal, observation, actionable, context);
  if (!actionable.actionable) {
    const updated = applyNoActionPolicy(await store.get(goal.id), actionable.observedAt, now);
    await store.update(goal.id, () => updated, { updatedAt: now.toISOString() });
    if (updated.state === "completed" || updated.state === "dormant") {
      const event = { type: "complete" as const, goalId: goal.id, timestamp: now.toISOString(), status: "quiet" as const, summary: `Quiet window expired: ${actionable.reason}` };
      await appendGoalEvent(store.paths, event);
      await notifyNonFatal(store, sink, updated, event);
    }
    return { launched: false };
  }
  const actionableGoal = await store.update(goal.id, (current) => applyActionablePolicy(current, now), { updatedAt: now.toISOString() });
  const workerInput = await prepareWorkerInput(adapter, actionableGoal, observation, actionable, context);
  const event = { type: "progress" as const, goalId: goal.id, timestamp: now.toISOString(), message: `Launching worker: ${actionable.reason}` };
  await appendGoalEvent(store.paths, event);
  await notifyNonFatal(store, sink, workerInput.goal, event);
  if (options.worker?.dryRun) {
    await store.update(goal.id, (current) => ({
      ...current,
      updatedAt: now.toISOString(),
      latestProgress: event.message,
      schedule: { ...current.schedule, nextCheckAt: nextCheckAt(current.schedule.backoff, now) },
    }), { updatedAt: now.toISOString() });
    return { launched: true };
  }
  const workerRun = await startWorker(store, workerInput.goal, workerInput.prompt, {
    ...options.worker,
    onComplete: async (completeEvent) => adapter.handleSuccessfulCompletion?.(workerInput.goal, completeEvent, context, workerInput.completionContext),
  });
  return { launched: true, workerDone: workerRun.done };
}

async function prepareWorkerInput(adapter: NonNullable<ReturnType<typeof getGoalAdapter>>, goal: GoalRecord, observation: unknown, actionable: GoalActionability, context: { store: GoalStore; gh: GhExecutor; now: Date }): Promise<PreparedWorkerInput> {
  if (!adapter.prepareWorker) throw new Error(`Goal type ${goal.type} does not support worker execution`);
  return adapter.prepareWorker(goal, observation, actionable, context);
}

export async function handleSuccessfulWorkerComplete(store: GoalStore, gh: GhExecutor, goal: GoalRecord, event: CompleteEvent, handledCheckNames: string[] = []): Promise<void> {
  const adapter = getGoalAdapter(goal.type);
  await adapter?.handleSuccessfulCompletion?.(goal, event, { store, gh, now: new Date(event.timestamp) }, { handledCheckNames });
}
