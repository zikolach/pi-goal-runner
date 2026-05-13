import type { GoalRecord } from "../types.js";
import type { GoalStore } from "../state/store.js";
import type { StatePaths } from "../state/paths.js";
export declare function ensureGoalWorktree(store: GoalStore, goal: GoalRecord): Promise<GoalRecord>;
export declare function createOrReuseWorktree(paths: StatePaths, repoPath: string, worktreePath: string, branch?: string): Promise<void>;
