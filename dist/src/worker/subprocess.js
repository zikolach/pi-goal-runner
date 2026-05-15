import { spawn } from "node:child_process";
import { appendRecentUnique, MAX_HANDLED_THREAD_IDS } from "../github/handled.js";
import { appendGoalEvent, parseWorkerEventLine } from "../state/events.js";
import { addPendingDecision } from "../decisions.js";
import { redactText } from "../redaction.js";
import { increaseBackoff, nextCheckAt } from "../policy.js";
import { splitArgs } from "../args.js";
export const DEFAULT_WORKER_TIMEOUT_MS = 45 * 60_000;
export const MAX_WORKER_STDOUT_BUFFER_CHARS = 64 * 1024;
export async function launchWorker(store, goal, prompt, options = {}) {
    const run = await startWorker(store, goal, prompt, options);
    return run.done;
}
export async function startWorker(store, goal, prompt, options = {}) {
    const runId = `run-${Date.now().toString(36)}`;
    const run = { id: runId, startedAt: new Date().toISOString(), status: "running" };
    await store.update(goal.id, (current) => ({ ...current, state: "running", runHistory: [...current.runHistory, run] }));
    const command = options.command ?? process.env.PI_GOAL_WORKER_COMMAND ?? "pi";
    const args = options.args ?? workerArgsFromEnv();
    const cwd = options.cwd ?? goal.github?.repository.worktreePath ?? goal.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    const done = new Promise((resolve) => {
        const childEnv = { ...process.env, ...options.env };
        delete childEnv.PI_GOAL_PROMPT;
        const child = spawn(command, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.end(prompt);
        let stdoutBuffer = "";
        let stdoutOverflowed = false;
        let stderr = "";
        let timedOut = false;
        let terminalEventType;
        let settled = false;
        let ingestionQueue = Promise.resolve();
        const ingestionFailures = [];
        const resolveBestEffortFailure = async (error) => {
            const message = redactText(error instanceof Error ? error.message : String(error), 1_000);
            try {
                await store.update(goal.id, (current) => ({ ...current, state: "failed", latestProgress: message }));
            }
            catch {
                // Fall through to a best-effort read or in-memory fallback below.
            }
            try {
                resolve(await store.get(goal.id));
                return;
            }
            catch {
                const completedAt = new Date().toISOString();
                const failedRun = { ...run, completedAt, status: "failed", summary: message };
                const runHistory = goal.runHistory.some((candidate) => candidate.id === runId)
                    ? goal.runHistory.map((candidate) => candidate.id === runId ? failedRun : candidate)
                    : [...goal.runHistory, failedRun];
                resolve({ ...goal, state: "failed", updatedAt: completedAt, latestProgress: message, runHistory });
            }
        };
        const enqueueEvent = (event, forcedStatus) => {
            const emittedTerminalType = event.type === "complete" || event.type === "failure" || event.type === "decision" ? event.type : undefined;
            ingestionQueue = ingestionQueue.catch(() => undefined).then(async () => {
                try {
                    await ingestWorkerEvent(store, goal.id, runId, event, forcedStatus);
                    if (emittedTerminalType)
                        terminalEventType = emittedTerminalType;
                    if (event.type === "complete" && event.status === "success")
                        await options.onComplete?.(event);
                }
                catch (error) {
                    ingestionFailures.push(redactText(error instanceof Error ? error.message : String(error), 1_000));
                }
            });
            return ingestionQueue;
        };
        const failForStdoutOverflow = () => {
            if (stdoutOverflowed)
                return;
            stdoutOverflowed = true;
            stdoutBuffer = stdoutBuffer.slice(0, MAX_WORKER_STDOUT_BUFFER_CHARS);
            const event = {
                type: "failure",
                goalId: goal.id,
                runId,
                timestamp: new Date().toISOString(),
                message: `Worker stdout line exceeded ${MAX_WORKER_STDOUT_BUFFER_CHARS} characters without a newline`,
                retryable: true,
            };
            enqueueEvent(event, "failed");
            child.kill("SIGTERM");
        };
        const appendStdoutFragment = (fragment) => {
            if (!fragment || stdoutOverflowed)
                return;
            const remaining = MAX_WORKER_STDOUT_BUFFER_CHARS - stdoutBuffer.length;
            if (fragment.length > remaining) {
                if (remaining > 0)
                    stdoutBuffer += fragment.slice(0, remaining);
                failForStdoutOverflow();
                return;
            }
            stdoutBuffer += fragment;
        };
        const normalizedStdoutBuffer = () => (stdoutBuffer.endsWith("\r") ? stdoutBuffer.slice(0, -1) : stdoutBuffer);
        const emitBufferedStdoutLine = () => {
            if (stdoutOverflowed)
                return;
            const line = normalizedStdoutBuffer();
            stdoutBuffer = "";
            if (line.trim())
                enqueueEvent(parseWorkerEventLine(goal.id, runId, line));
        };
        const processStdoutChunk = (chunk) => {
            let offset = 0;
            while (offset < chunk.length && !stdoutOverflowed) {
                const newlineIndex = chunk.indexOf("\n", offset);
                if (newlineIndex === -1) {
                    appendStdoutFragment(chunk.slice(offset));
                    break;
                }
                appendStdoutFragment(chunk.slice(offset, newlineIndex));
                emitBufferedStdoutLine();
                offset = newlineIndex + 1;
            }
        };
        let timeoutTimer;
        let sigkillTimer;
        const clearTerminationTimers = () => {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = undefined;
            }
            if (sigkillTimer) {
                clearTimeout(sigkillTimer);
                sigkillTimer = undefined;
            }
        };
        timeoutTimer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
            sigkillTimer.unref();
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            processStdoutChunk(chunk);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
            stderr = stderr.slice(-4_000);
        });
        child.on("error", (error) => {
            clearTerminationTimers();
            if (settled)
                return;
            settled = true;
            void (async () => {
                await ingestionQueue;
                const event = { type: "failure", goalId: goal.id, runId, timestamp: new Date().toISOString(), message: `Worker failed to start: ${redactText(error.message, 2_000)}`, retryable: true };
                await enqueueEvent(event, "failed");
                resolve(await store.get(goal.id));
            })().catch((updateError) => {
                void resolveBestEffortFailure(updateError);
            });
        });
        child.on("close", (code, signal) => {
            clearTerminationTimers();
            if (settled)
                return;
            settled = true;
            void (async () => {
                if (!stdoutOverflowed && stdoutBuffer.trim())
                    enqueueEvent(parseWorkerEventLine(goal.id, runId, normalizedStdoutBuffer()));
                await ingestionQueue;
                if (terminalEventType) {
                    // Worker protocol terminal events are authoritative; process exit status
                    // must not override a recorded completion, failure, or user decision.
                }
                else if (timedOut) {
                    const event = { type: "failure", goalId: goal.id, runId, timestamp: new Date().toISOString(), message: "Worker timed out", retryable: true };
                    await enqueueEvent(event, "timeout");
                }
                else if (code !== 0) {
                    const exitReason = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
                    const event = { type: "failure", goalId: goal.id, runId, timestamp: new Date().toISOString(), message: `Worker exited with ${exitReason}: ${redactText(stderr, 2_000)}`, retryable: true };
                    await enqueueEvent(event, "failed");
                }
                else {
                    const suffix = ingestionFailures.length ? ` (${ingestionFailures.length} ingestion failure(s): ${ingestionFailures.join("; ")})` : "";
                    const event = { type: "failure", goalId: goal.id, runId, timestamp: new Date().toISOString(), message: `Worker exited successfully without emitting a terminal event${suffix}`, retryable: true };
                    await enqueueEvent(event, "failed");
                }
                resolve(await store.get(goal.id));
            })().catch((error) => {
                void resolveBestEffortFailure(error);
            });
        });
    });
    return { runId, done };
}
export async function ingestWorkerEvent(store, goalId, runId, event, forcedStatus) {
    await appendGoalEvent(store.paths, event);
    await store.update(goalId, (goal) => {
        if (event.type === "failure" && hasTerminalRun(goal, runId)) {
            return { ...goal, latestProgress: goal.latestProgress ?? event.message };
        }
        const runHistory = goal.runHistory.map((run) => {
            if (run.id !== runId)
                return run;
            if (event.type === "complete")
                return { ...run, completedAt: event.timestamp, status: event.status === "stale" ? "failed" : "success", summary: event.summary, commitSha: event.commitSha, validationResults: event.validationResults };
            if (event.type === "failure")
                return { ...run, completedAt: event.timestamp, status: forcedStatus ?? "failed", summary: event.message };
            if (event.type === "decision")
                return { ...run, completedAt: event.timestamp, status: "needs_decision", summary: event.decision.prompt };
            return run;
        });
        if (event.type === "progress")
            return { ...goal, latestProgress: event.message, runHistory };
        if (event.type === "decision")
            return { ...addPendingDecision({ ...goal, runHistory }, event.decision), latestProgress: event.decision.prompt };
        if (event.type === "complete") {
            if (event.status === "stale") {
                const backoff = increaseBackoff(goal.schedule.backoff);
                const staleAt = new Date(event.timestamp);
                return { ...goal, state: "failed", latestProgress: event.summary, lastRunSummary: event.summary, runHistory, schedule: { ...goal.schedule, backoff, nextCheckAt: nextCheckAt(backoff, staleAt) }, github: updateGithubHandledState(goal, event) };
            }
            return { ...goal, state: event.status === "quiet" ? "completed" : "active", latestProgress: event.summary, lastRunSummary: event.summary, runHistory, github: updateGithubHandledState(goal, event) };
        }
        if (event.type === "failure") {
            const backoff = increaseBackoff(goal.schedule.backoff);
            const failedAt = new Date(event.timestamp);
            return { ...goal, state: "failed", latestProgress: event.message, runHistory, schedule: { ...goal.schedule, backoff, nextCheckAt: nextCheckAt(backoff, failedAt) } };
        }
        return { ...goal, runHistory, latestProgress: event.message };
    });
}
function hasTerminalRun(goal, runId) {
    const run = goal.runHistory.find((candidate) => candidate.id === runId);
    return run?.status === "success" || run?.status === "needs_decision" || run?.status === "timeout" || (run?.status === "failed" && Boolean(run.completedAt));
}
function updateGithubHandledState(goal, event) {
    if (!goal.github || event.status !== "success")
        return goal.github;
    return {
        ...goal.github,
        lastHandledAt: event.timestamp,
        handledThreadIds: appendRecentUnique(goal.github.handledThreadIds, event.addressedThreadIds ?? [], MAX_HANDLED_THREAD_IDS),
    };
}
function workerArgsFromEnv() {
    const configured = process.env.PI_GOAL_WORKER_ARGS;
    if (configured)
        return splitArgs(configured);
    return ["--print"];
}
//# sourceMappingURL=subprocess.js.map