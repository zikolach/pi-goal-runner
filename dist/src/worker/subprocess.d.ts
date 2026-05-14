import type { GoalStore } from "../state/store.js";
import type { CompleteEvent, GoalEvent, GoalRecord, RunSummary } from "../types.js";
export interface WorkerLaunchOptions {
    command?: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    onComplete?: (event: CompleteEvent) => Promise<void>;
}
export interface StartedWorkerRun {
    runId: string;
    done: Promise<GoalRecord>;
}
export declare const MAX_WORKER_STDOUT_BUFFER_CHARS: number;
export declare function launchWorker(store: GoalStore, goal: GoalRecord, prompt: string, options?: WorkerLaunchOptions): Promise<GoalRecord>;
export declare function startWorker(store: GoalStore, goal: GoalRecord, prompt: string, options?: WorkerLaunchOptions): Promise<StartedWorkerRun>;
export declare function ingestWorkerEvent(store: GoalStore, goalId: string, runId: string, event: GoalEvent, forcedStatus?: RunSummary["status"]): Promise<void>;
