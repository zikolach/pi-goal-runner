import { githubPrAdapter } from "./github-pr.js";
const ADAPTERS = new Map([[githubPrAdapter.type, githubPrAdapter]]);
export function getGoalAdapter(type) {
    return ADAPTERS.get(type);
}
export function getGoalDisplayMetadata(goal) {
    return getGoalAdapter(goal.type)?.display?.(goal) ?? {};
}
//# sourceMappingURL=registry.js.map