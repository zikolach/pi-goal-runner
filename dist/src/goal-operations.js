import { isTerminal } from "./policy.js";
import { withGoalLock } from "./state/lock.js";
export function getGoalActionAvailability(goal) {
    const terminal = isTerminal(goal.state);
    const blockedByRequiredDecision = goal.pendingDecisions.some((decision) => decision.status === "pending" && decision.required);
    return {
        canPause: !terminal && goal.state !== "paused" && goal.state !== "running",
        canResume: goal.state === "paused",
        canCancel: !terminal && goal.state !== "running",
        canRunNow: !terminal && goal.state !== "paused" && goal.state !== "running" && !blockedByRequiredDecision,
    };
}
export async function pauseGoal(store, goalId) {
    return setGoalState(store, goalId, "paused");
}
export async function resumeGoal(store, goalId) {
    return setGoalState(store, goalId, "active");
}
export async function cancelGoal(store, goalId) {
    return setGoalState(store, goalId, "cancelled");
}
export async function setGoalState(store, goalId, state) {
    const result = await withGoalLock(store.paths, goalId, async () => {
        const next = await store.setState(goalId, state);
        return { ok: true, goal: next, busy: false };
    });
    if (!result)
        return { ok: false, busy: true, reason: "goal is busy; try again later" };
    return result;
}
export function describeGoalActionAvailability(goal) {
    const availability = getGoalActionAvailability(goal);
    const actions = [];
    if (availability.canPause)
        actions.push("pause");
    if (availability.canResume)
        actions.push("resume");
    if (availability.canRunNow)
        actions.push("run-now");
    if (availability.canCancel)
        actions.push("cancel");
    return actions;
}
//# sourceMappingURL=goal-operations.js.map