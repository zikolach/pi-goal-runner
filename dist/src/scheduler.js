import { appendGoalEvent } from "./state/events.js";
import { acquireGoalLock } from "./state/lock.js";
import { applyActionablePolicy, applyNoActionPolicy, increaseBackoff, isDue, isTerminal, nextCheckAt } from "./policy.js";
import { createGhExecutor } from "./github/gh.js";
import { findActionable, observeGithubPr } from "./github/observe.js";
import { replyAndResolveAddressedThreads } from "./github/update.js";
import { buildWorkerPrompt } from "./worker/prompt.js";
import { ensureGoalWorktree } from "./worker/worktree.js";
import { startWorker } from "./worker/subprocess.js";
import { createDefaultNotificationSink, notifyNonFatal } from "./notifications.js";
import { safeError } from "./redaction.js";
export async function selectDueGoals(store, now = new Date()) {
    const goals = await store.list();
    return goals.filter((goal) => !skipReason(goal, now));
}
export function skipReason(goal, now = new Date()) {
    if (isTerminal(goal.state))
        return `terminal state ${goal.state}`;
    if (goal.state === "running")
        return "already running";
    if (goal.state === "paused")
        return "paused";
    if (goal.state === "needs_decision")
        return "waiting for user decision";
    if (goal.pendingDecisions.some((decision) => decision.status === "pending"))
        return "waiting for user decision";
    if (!isDue(goal, now))
        return `not due until ${goal.schedule.nextCheckAt}`;
    return undefined;
}
export async function schedulerTick(store, options = {}) {
    const gh = options.gh ?? createGhExecutor();
    const sink = options.notificationSink ?? createDefaultNotificationSink();
    const now = options.now ?? new Date();
    const goals = await store.list();
    const result = { checked: 0, launched: 0, skipped: 0, failures: 0, messages: [] };
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
        let releaseLock = true;
        try {
            const outcome = await checkGoal(store, goal, gh, sink, options);
            if (outcome.launched)
                result.launched++;
            if (outcome.workerDone) {
                releaseLock = false;
                releaseLockAfterWorker(outcome.workerDone, lock.release);
            }
        }
        catch (error) {
            result.failures++;
            const message = safeError(error);
            await appendGoalEvent(store.paths, { type: "failure", goalId: goal.id, timestamp: now.toISOString(), message, retryable: true });
            await store.update(goal.id, (current) => {
                const backoff = increaseBackoff(current.schedule.backoff);
                return { ...current, state: "failed", latestProgress: message, schedule: { ...current.schedule, backoff, nextCheckAt: nextCheckAt(backoff, now) } };
            });
            result.messages.push(`${goal.id}: ${message}`);
        }
        finally {
            if (releaseLock)
                await lock.release();
        }
    }
    return result;
}
function releaseLockAfterWorker(workerDone, release) {
    void (async () => {
        try {
            await workerDone;
        }
        finally {
            await release();
        }
    })().catch(() => undefined);
}
async function checkGoal(store, goal, gh, sink, options) {
    const now = options.now ?? new Date();
    if (goal.type !== "github_pr_review" || !goal.github)
        throw new Error(`Unsupported goal type: ${goal.type}`);
    const observation = await observeGithubPr(gh, goal.github);
    const actionable = findActionable(goal.github, observation);
    await store.update(goal.id, (current) => ({ ...current, github: current.github ? { ...current.github, lastObservedAt: observation.observedAt, repository: { ...current.github.repository, branch: observation.headBranch ?? current.github.repository.branch } } : current.github }));
    if (!actionable.actionable) {
        const updated = applyNoActionPolicy(await store.get(goal.id), observation.observedAt, now);
        await store.update(goal.id, () => updated);
        if (updated.state === "completed" || updated.state === "dormant") {
            const event = { type: "complete", goalId: goal.id, timestamp: now.toISOString(), status: "quiet", summary: `Quiet window expired: ${actionable.reason}` };
            await appendGoalEvent(store.paths, event);
            await notifyNonFatal(store, sink, updated, event);
        }
        return { launched: false };
    }
    const actionableGoal = await store.update(goal.id, (current) => applyActionablePolicy(current, now));
    const worktreeGoal = await ensureGoalWorktree(store, actionableGoal);
    const prompt = buildWorkerPrompt(worktreeGoal, observation, actionable);
    const event = { type: "progress", goalId: goal.id, timestamp: now.toISOString(), message: `Launching worker: ${actionable.reason}` };
    await appendGoalEvent(store.paths, event);
    await notifyNonFatal(store, sink, worktreeGoal, event);
    if (options.worker?.dryRun)
        return { launched: true };
    const workerRun = await startWorker(store, worktreeGoal, prompt, {
        ...options.worker,
        onComplete: async (completeEvent) => handleSuccessfulWorkerComplete(store, gh, worktreeGoal, completeEvent, actionable.checks.map((check) => check.name)),
    });
    return { launched: true, workerDone: workerRun.done };
}
export async function handleSuccessfulWorkerComplete(store, gh, goal, event, handledCheckNames = []) {
    if (!goal.github)
        return;
    if (handledCheckNames.length > 0) {
        await store.update(goal.id, (current) => ({
            ...current,
            github: current.github ? { ...current.github, handledCheckNames: [...new Set([...current.github.handledCheckNames, ...handledCheckNames])] } : current.github,
        }));
    }
    if (!goal.github.autoReplyAndResolve)
        return;
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
    }
    catch (error) {
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
//# sourceMappingURL=scheduler.js.map