export interface StatePaths {
    root: string;
    goalsDir: string;
    worktreesDir: string;
    goalDir(goalId: string): string;
    stateFile(goalId: string): string;
    eventsFile(goalId: string): string;
    lockDir(goalId: string): string;
    worktreeDir(goalId: string): string;
}
export declare function defaultStateRoot(): string;
export declare function createStatePaths(root?: string): StatePaths;
export declare function sanitizeGoalId(goalId: string): string;
