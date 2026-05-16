import type { CompleteEvent, GoalRecord, SchedulerResult } from "./types.js";
import type { GoalStore } from "./state/store.js";
import { type GhExecutor } from "./github/gh.js";
import { type WorkerLaunchOptions } from "./worker/subprocess.js";
import { type NotificationSink } from "./notifications.js";
export interface SchedulerOptions {
    gh?: GhExecutor;
    notificationSink?: NotificationSink;
    worker?: WorkerLaunchOptions & {
        dryRun?: boolean;
    };
    now?: Date;
}
export declare const WORKER_LOCK_STALE_BUFFER_MS: number;
export declare function selectDueGoals(store: GoalStore, now?: Date): Promise<GoalRecord[]>;
export declare function skipReason(goal: GoalRecord, now?: Date): string | undefined;
export interface RunNowResult {
    goalId: string;
    checked: number;
    launched: number;
    skipped: number;
    failures: number;
    messages: string[];
    workerDone?: Promise<GoalRecord>;
}
export declare function runGoalNow(store: GoalStore, goalId: string, options?: SchedulerOptions): Promise<RunNowResult>;
export declare function schedulerTick(store: GoalStore, options?: SchedulerOptions): Promise<SchedulerResult>;
export declare function handleSuccessfulWorkerComplete(store: GoalStore, gh: GhExecutor, goal: GoalRecord, event: CompleteEvent, handledCheckNames?: string[]): Promise<void>;
