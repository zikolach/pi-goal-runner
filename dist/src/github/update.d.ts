import type { CompleteEvent, GithubPrGoalConfig } from "../types.js";
import type { GhExecutor } from "./gh.js";
export declare function replyAndResolveAddressedThreads(gh: GhExecutor, config: GithubPrGoalConfig, event: CompleteEvent): Promise<string[]>;
