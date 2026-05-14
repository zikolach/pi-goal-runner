import type { ActionableObservation, GithubObservation, GithubPrGoalConfig } from "../types.js";
import type { GhExecutor } from "./gh.js";
export interface ObserveGithubPrOptions {
    now?: Date;
}
export declare function observeGithubPr(gh: GhExecutor, config: GithubPrGoalConfig, options?: ObserveGithubPrOptions): Promise<GithubObservation>;
export declare function findActionable(config: GithubPrGoalConfig, observation: GithubObservation): ActionableObservation;
