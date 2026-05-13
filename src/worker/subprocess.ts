import { spawn } from "node:child_process";
import { appendGoalEvent, parseWorkerEventLine } from "../state/events.js";
import type { GoalStore } from "../state/store.js";
import type { FailureEvent, GoalEvent, GoalRecord, RunSummary } from "../types.js";
import { addPendingDecision } from "../decisions.js";
import { redactText } from "../redaction.js";

export interface WorkerLaunchOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function launchWorker(store: GoalStore, goal: GoalRecord, prompt: string, options: WorkerLaunchOptions = {}): Promise<GoalRecord> {
  const runId = `run-${Date.now().toString(36)}`;
  const run: RunSummary = { id: runId, startedAt: new Date().toISOString(), status: "running" };
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
    let terminalEventSeen = false;
    let ingestionQueue: Promise<void> = Promise.resolve();
    const enqueueEvent = (event: GoalEvent, forcedStatus?: RunSummary["status"]) => {
      if (event.type === "complete" || event.type === "failure" || event.type === "decision") terminalEventSeen = true;
      ingestionQueue = ingestionQueue.then(() => ingestWorkerEvent(store, goal.id, runId, event, forcedStatus));
      ingestionQueue.catch(() => undefined);
      return ingestionQueue;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) enqueueEvent(parseWorkerEventLine(goal.id, runId, line));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      stderr = stderr.slice(-4_000);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      void (async () => {
        if (stdoutBuffer.trim()) enqueueEvent(parseWorkerEventLine(goal.id, runId, stdoutBuffer));
        await ingestionQueue;
        if (timedOut) {
          const event: FailureEvent = { type: "failure", goalId: goal.id, runId, timestamp: new Date().toISOString(), message: "Worker timed out", retryable: true };
          await enqueueEvent(event, "timeout");
        } else if (code !== 0) {
          const exitReason = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
          const event: FailureEvent = { type: "failure", goalId: goal.id, runId, timestamp: new Date().toISOString(), message: `Worker exited with ${exitReason}: ${redactText(stderr, 2_000)}`, retryable: true };
          await enqueueEvent(event, "failed");
        } else if (!terminalEventSeen) {
          const event: FailureEvent = { type: "failure", goalId: goal.id, runId, timestamp: new Date().toISOString(), message: "Worker exited successfully without emitting a terminal event", retryable: true };
          await enqueueEvent(event, "failed");
        }
        resolve(await store.get(goal.id));
      })().catch(async (error) => {
        await store.update(goal.id, (current) => ({ ...current, state: "failed", latestProgress: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
        resolve(await store.get(goal.id));
      });
    });
  });
}

export async function ingestWorkerEvent(store: GoalStore, goalId: string, runId: string, event: GoalEvent, forcedStatus?: RunSummary["status"]): Promise<void> {
  await appendGoalEvent(store.paths, event);
  await store.update(goalId, (goal) => {
    const runHistory = goal.runHistory.map((run) => {
      if (run.id !== runId) return run;
      if (event.type === "complete") return { ...run, completedAt: event.timestamp, status: "success" as const, summary: event.summary, commitSha: event.commitSha, validationResults: event.validationResults };
      if (event.type === "failure") return { ...run, completedAt: event.timestamp, status: forcedStatus ?? "failed", summary: event.message };
      if (event.type === "decision") return { ...run, status: "needs_decision" as const, summary: event.decision.prompt };
      return run;
    });
    if (event.type === "progress") return { ...goal, latestProgress: event.message, runHistory };
    if (event.type === "decision") return { ...addPendingDecision({ ...goal, runHistory }, event.decision), latestProgress: event.decision.prompt };
    if (event.type === "complete") return { ...goal, state: event.status === "quiet" ? "completed" : "active", latestProgress: event.summary, lastRunSummary: event.summary, runHistory, github: updateGithubHandledState(goal, event) };
    if (event.type === "failure") return { ...goal, state: "failed", latestProgress: event.message, runHistory };
    return { ...goal, runHistory, latestProgress: event.message };
  });
}

function updateGithubHandledState(goal: GoalRecord, event: Extract<GoalEvent, { type: "complete" }>): GoalRecord["github"] {
  if (!goal.github || event.status !== "success") return goal.github;
  return {
    ...goal.github,
    lastHandledAt: event.timestamp,
    handledThreadIds: [...new Set([...goal.github.handledThreadIds, ...(event.addressedThreadIds ?? [])])],
  };
}

function workerArgsFromEnv(): string[] {
  const configured = process.env.PI_GOAL_WORKER_ARGS;
  if (configured) return configured.split(" ").filter(Boolean);
  return ["--print"];
}
