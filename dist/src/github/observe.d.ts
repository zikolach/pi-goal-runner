import type { ActionableObservation, GithubObservation, GithubPrGoalConfig } from "../types.js";
import type { GhExecutor } from "./gh.js";
export declare function observeGithubPr(gh: GhExecutor, config: GithubPrGoalConfig): Promise<GithubObservation>;
export declare function findActionable(config: GithubPrGoalConfig, observation: GithubObservation): ActionableObservation;
