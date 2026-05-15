import type { GoalRecord, WorktreeMode } from "../types.js";
import type { GoalStore } from "../state/store.js";
import type { StatePaths } from "../state/paths.js";
export interface EnsureGoalWorktreeOptions {
    updatedAt?: string;
    observedHeadSha?: string;
}
export interface CreateWorktreeOptions {
    branch?: string;
    observedHeadSha?: string;
    remote?: string;
}
export interface PreparedWorktree {
    path: string;
    mode: WorktreeMode;
    headSha?: string;
    pushRemote: string;
    pushBranch?: string;
}
export declare function ensureGoalWorktree(store: GoalStore, goal: GoalRecord, options?: EnsureGoalWorktreeOptions): Promise<GoalRecord>;
export declare function createOrReuseWorktree(paths: StatePaths, repoPath: string, worktreePath: string, branchOrOptions?: string | CreateWorktreeOptions): Promise<PreparedWorktree>;
