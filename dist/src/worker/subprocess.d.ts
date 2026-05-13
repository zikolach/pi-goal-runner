import type { GoalStore } from "../state/store.js";
import type { GoalEvent, GoalRecord, RunSummary } from "../types.js";
export interface WorkerLaunchOptions {
    command?: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}
export declare function launchWorker(store: GoalStore, goal: GoalRecord, prompt: string, options?: WorkerLaunchOptions): Promise<GoalRecord>;
export declare function ingestWorkerEvent(store: GoalStore, goalId: string, runId: string, event: GoalEvent, forcedStatus?: RunSummary["status"]): Promise<void>;
