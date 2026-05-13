import { spawn } from "node:child_process";
import { appendGoalEvent, parseWorkerEventLine } from "../state/events.js";
import { addPendingDecision } from "../decisions.js";
import { redactText } from "../redaction.js";
export async function launchWorker(store, goal, prompt, options = {}) {
    const runId = `run-${Date.now().toString(36)}`;
    const run = { id: runId, startedAt: new Date().toISOString(), status: "running" };
    await store.update(goal.id, (current) => ({ ...current, state: "running", runHistory: [...current.runHistory, run] }));
    const command = options.command ?? process.env.PI_GOAL_WORKER_COMMAND ?? "pi";
    const args = options.args ?? workerArgsFromEnv();
    const cwd = options.cwd ?? goal.github?.repository.worktreePath ?? goal.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? 45 * 60_000;
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env: { ...process.env, ...options.env, PI_GOAL_PROMPT: prompt }, stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.end(prompt);
        let stdoutBuffer = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdoutBuffer += chunk;
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) {
                if (line.trim())
                    void ingestWorkerEvent(store, goal.id, runId, parseWorkerEventLine(goal.id, runId, line));
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
            stderr = stderr.slice(-4_000);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            void (async () => {
                if (stdoutBuffer.trim())
                    await ingestWorkerEvent(store, goal.id, runId, parseWorkerEventLine(goal.id, runId, stdoutBuffer));
                if (timedOut) {
                    const event = { type: "failure", goalId: goal.id, runId, timestamp: new Date().toISOString(), message: "Worker timed out", retryable: true };
                    await ingestWorkerEvent(store, goal.id, runId, event, "timeout");
                }
                else if (code !== 0) {
                    const event = { type: "failure", goalId: goal.id, runId, timestamp: new Date().toISOString(), message: `Worker exited ${code}: ${redactText(stderr, 2_000)}`, retryable: true };
                    await ingestWorkerEvent(store, goal.id, runId, event, "failed");
                }
                resolve(await store.get(goal.id));
            })().catch(async (error) => {
                await store.update(goal.id, (current) => ({ ...current, state: "failed", latestProgress: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
                resolve(await store.get(goal.id));
            });
        });
    });
}
export async function ingestWorkerEvent(store, goalId, runId, event, forcedStatus) {
    await appendGoalEvent(store.paths, event);
    await store.update(goalId, (goal) => {
        const runHistory = goal.runHistory.map((run) => {
            if (run.id !== runId)
                return run;
            if (event.type === "complete")
                return { ...run, completedAt: event.timestamp, status: "success", summary: event.summary, commitSha: event.commitSha, validationResults: event.validationResults };
            if (event.type === "failure")
                return { ...run, completedAt: event.timestamp, status: forcedStatus ?? "failed", summary: event.message };
            if (event.type === "decision")
                return { ...run, status: "needs_decision", summary: event.decision.prompt };
            return run;
        });
        if (event.type === "progress")
            return { ...goal, latestProgress: event.message, runHistory };
        if (event.type === "decision")
            return { ...addPendingDecision({ ...goal, runHistory }, event.decision), latestProgress: event.decision.prompt };
        if (event.type === "complete")
            return { ...goal, state: "active", latestProgress: event.summary, lastRunSummary: event.summary, runHistory, github: goal.github ? { ...goal.github, lastHandledAt: event.timestamp, handledThreadIds: [...new Set([...goal.github.handledThreadIds, ...(event.addressedThreadIds ?? [])])] } : goal.github };
        if (event.type === "failure")
            return { ...goal, state: "failed", latestProgress: event.message, runHistory };
        return { ...goal, runHistory, latestProgress: event.message };
    });
}
function workerArgsFromEnv() {
    const configured = process.env.PI_GOAL_WORKER_ARGS;
    if (configured)
        return configured.split(" ").filter(Boolean);
    return ["--print"];
}
//# sourceMappingURL=subprocess.js.map