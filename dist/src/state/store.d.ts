import type { GoalRecord, GoalState } from "../types.js";
import { type StatePaths } from "./paths.js";
export interface GoalStore {
    paths: StatePaths;
    init(): Promise<void>;
    create(input: CreateGoalInput): Promise<GoalRecord>;
    list(): Promise<GoalRecord[]>;
    get(goalId: string): Promise<GoalRecord>;
    update(goalId: string, updater: (goal: GoalRecord) => GoalRecord | Promise<GoalRecord>, options?: {
        updatedAt?: string;
    }): Promise<GoalRecord>;
    setState(goalId: string, state: GoalState): Promise<GoalRecord>;
}
export type CreateGoalInput = Omit<GoalRecord, "schemaVersion" | "createdAt" | "updatedAt" | "runHistory" | "pendingDecisions"> & Partial<Pick<GoalRecord, "createdAt" | "updatedAt" | "runHistory" | "pendingDecisions" | "schedule">>;
export declare function createGoalStore(root?: string): GoalStore;
export declare function createGoalId(prefix?: string): string;
