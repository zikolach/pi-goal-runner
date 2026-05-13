import type { DecisionRecord, GoalRecord } from "./types.js";
import type { GoalStore } from "./state/store.js";
export declare function addPendingDecision(goal: GoalRecord, decision: DecisionRecord): GoalRecord;
export declare function listPendingDecisions(goals: GoalRecord[]): DecisionRecord[];
export declare function answerDecision(store: GoalStore, decisionId: string, choice: string): Promise<DecisionRecord>;
