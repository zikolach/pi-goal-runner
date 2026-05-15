import type { GoalRecord, GoalType } from "../types.js";
import type { GoalAdapter, GoalDisplayMetadata } from "./types.js";
export declare function getGoalAdapter(type: GoalType | string): GoalAdapter | undefined;
export declare function getGoalDisplayMetadata(goal: GoalRecord): GoalDisplayMetadata;
