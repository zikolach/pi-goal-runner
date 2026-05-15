import type { GoalRecord, GoalType } from "../types.js";
import { githubPrAdapter } from "./github-pr.js";
import type { GoalAdapter, GoalDisplayMetadata } from "./types.js";

const ADAPTERS = new Map<GoalType, GoalAdapter>([[githubPrAdapter.type, githubPrAdapter]]);

export function getGoalAdapter(type: GoalType | string): GoalAdapter | undefined {
  return ADAPTERS.get(type as GoalType);
}

export function getGoalDisplayMetadata(goal: GoalRecord): GoalDisplayMetadata {
  return getGoalAdapter(goal.type)?.display?.(goal) ?? {};
}
