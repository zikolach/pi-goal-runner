import type { GoalEvent } from "../types.js";
import type { StatePaths } from "./paths.js";
export declare function normalizeWorkerEvent(goalId: string, runId: string | undefined, raw: unknown): GoalEvent;
export declare function parseWorkerEventLine(goalId: string, runId: string | undefined, line: string): GoalEvent;
export declare function appendGoalEvent(paths: StatePaths, event: GoalEvent): Promise<void>;
