import type { GoalRecord } from "./types.js";
export type GoalManagerView = "list" | "detail" | "confirm-cancel";
export interface GoalManagerCallbacks {
    loadGoals(): Promise<GoalRecord[]>;
    loadGoal(goalId: string): Promise<GoalRecord | undefined>;
    pauseGoal(goalId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    resumeGoal(goalId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    cancelGoal(goalId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    runGoalNow(goalId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
}
interface GoalManagerComponent {
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
}
export declare class GoalManagerDialog implements GoalManagerComponent {
    private callbacks;
    private requestRender;
    private done;
    private goals;
    private view;
    private selectedIndex;
    private confirm?;
    private detailLineCount;
    constructor(initialGoals: GoalRecord[], callbacks: GoalManagerCallbacks, requestRender: () => void, done: () => void);
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    private reloadGoals;
    private reloadSelectedGoal;
    private handleListInput;
    private handleDetailInput;
    private handleConfirmInput;
    private runAction;
    private renderList;
    private renderDetail;
    private get selectedGoal();
}
export {};
