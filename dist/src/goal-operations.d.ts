import type { GoalRecord, GoalState } from "./types.js";
import type { GoalStore } from "./state/store.js";
export interface GoalActionAvailability {
    canPause: boolean;
    canResume: boolean;
    canCancel: boolean;
    canRunNow: boolean;
}
export interface GoalLifecycleResultSuccess {
    ok: true;
    goal: GoalRecord;
    busy: false;
    reason?: string;
}
export interface GoalLifecycleResultBusy {
    ok: false;
    goal?: undefined;
    busy: true;
    reason?: string;
}
export type GoalLifecycleResult = GoalLifecycleResultSuccess | GoalLifecycleResultBusy;
export declare function getGoalActionAvailability(goal: GoalRecord): GoalActionAvailability;
export declare function pauseGoal(store: GoalStore, goalId: string): Promise<GoalLifecycleResult>;
export declare function resumeGoal(store: GoalStore, goalId: string): Promise<GoalLifecycleResult>;
export declare function cancelGoal(store: GoalStore, goalId: string): Promise<GoalLifecycleResult>;
export declare function setGoalState(store: GoalStore, goalId: string, state: GoalState): Promise<GoalLifecycleResult>;
export declare function describeGoalActionAvailability(goal: GoalRecord): string[];
