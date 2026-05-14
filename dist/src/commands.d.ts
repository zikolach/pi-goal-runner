import type { GoalRecord } from "./types.js";
import type { GoalStore } from "./state/store.js";
import { listPendingDecisions } from "./decisions.js";
import { type GhExecutor } from "./github/gh.js";
export { splitArgs } from "./args.js";
export declare const GOAL_SUBCOMMANDS: string[];
export declare function handleGoalCommand(store: GoalStore, argsText: string, options?: {
    gh?: GhExecutor;
    cwd?: string;
    dryRunWorker?: boolean;
}): Promise<string>;
export declare function goalHelp(): string;
export declare function formatGoalList(goals: GoalRecord[]): string;
export declare function formatGoalStatus(goal: GoalRecord): string;
export declare function formatDecisions(decisions: ReturnType<typeof listPendingDecisions>): string;
