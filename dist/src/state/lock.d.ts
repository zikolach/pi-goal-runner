import type { StatePaths } from "./paths.js";
export interface GoalLock {
    goalId: string;
    path: string;
    release(): Promise<void>;
}
export declare const DEFAULT_GOAL_LOCK_STALE_MS: number;
export declare function acquireGoalLock(paths: StatePaths, goalId: string, staleMs?: number): Promise<GoalLock | undefined>;
export declare function withGoalLock<T>(paths: StatePaths, goalId: string, fn: () => Promise<T>): Promise<T | undefined>;
