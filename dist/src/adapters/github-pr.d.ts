import type { ActionableObservation, CompleteEvent, GithubObservation, GoalRecord } from "../types.js";
import type { GoalStore } from "../state/store.js";
import type { GoalAdapter, GoalAdapterContext } from "./types.js";
export declare const githubPrAdapter: GoalAdapter<GithubObservation, ActionableObservation>;
export declare function handleGithubPrSuccessfulCompletion(store: GoalStore, gh: GoalAdapterContext["gh"], goal: GoalRecord, event: CompleteEvent, handledCheckNames?: string[]): Promise<void>;
