import type { GoalRecord } from "../types.js";
import { type GoalStore } from "../state/store.js";
import type { GhExecutor } from "./gh.js";
export interface WatchPrOptions {
    quietWindowMs?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    validationCommands?: string[];
    autoReplyAndResolve?: boolean;
    cwd?: string;
}
export declare function createGithubPrGoal(store: GoalStore, gh: GhExecutor, repoOrUrl: string, prNumberOrUrl: string, options?: WatchPrOptions): Promise<GoalRecord>;
