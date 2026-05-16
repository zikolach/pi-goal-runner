import type { GoalRecord } from "./types.js";
export type GoalManagerView = "list" | "detail" | "decisions" | "decision-answer" | "confirm-cancel";
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
    answerDecision(goalId: string, decisionId: string, choice: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    runSchedulerTick(): Promise<{
        ok: boolean;
        summary: string;
        reason?: string;
        messages: string[];
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
    private selectedGoalId?;
    private selectedFilterIndex;
    private selectedSortIndex;
    private selectedListColumnIndex;
    private selectedDecisionColumnIndex;
    private detailScrollOffset;
    private listLineCount;
    private selectedDecisionIndex;
    private selectedDecisionId?;
    private confirm?;
    private lastTickSummary;
    constructor(initialGoals: GoalRecord[], callbacks: GoalManagerCallbacks, requestRender: () => void, done: () => void);
    render(width: number): string[];
    private renderCurrentView;
    private renderConfirm;
    handleInput(data: string): void;
    private runSchedulerTick;
    private answerDecision;
    private handleListInput;
    private handleDetailInput;
    private handleDecisionsInput;
    private handleDecisionAnswerInput;
    private handleConfirmInput;
    private runAction;
    private reloadGoals;
    private reloadSelectedGoal;
    private visibleGoals;
    private get stateFilter();
    private get sortMode();
    private get sortModeLabel();
    private syncSelection;
    private syncDecisionSelection;
    private sortGoals;
    private renderList;
    private rememberListLines;
    private renderCompactGoalList;
    private renderDetail;
    private renderDetailTableContent;
    private renderCompactDetailContent;
    private renderScrollableDetail;
    private renderDecisions;
    private renderDecisionAnswer;
    invalidate(): void;
    private get selectedGoal();
}
export {};
