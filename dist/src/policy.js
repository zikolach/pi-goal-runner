export function defaultBackoff() {
    return { initialMs: 60_000, maxMs: 15 * 60_000, multiplier: 2, currentMs: 60_000 };
}
export function defaultQuietWindow() {
    return { durationMs: 2 * 60 * 60_000, onExpire: "completed" };
}
export function defaultSchedule(now = new Date()) {
    return {
        nextCheckAt: now.toISOString(),
        backoff: defaultBackoff(),
        quietWindow: defaultQuietWindow(),
    };
}
export function resetBackoff(policy) {
    return { ...policy, currentMs: policy.initialMs };
}
export function increaseBackoff(policy) {
    const next = Math.min(policy.maxMs, Math.max(policy.initialMs, Math.floor(policy.currentMs * policy.multiplier)));
    return { ...policy, currentMs: next };
}
export function nextCheckAt(backoff, now = new Date()) {
    return new Date(now.getTime() + backoff.currentMs).toISOString();
}
export function updateQuietWindow(policy, actionable, observedAt, now = new Date()) {
    if (actionable)
        return { ...policy, quietSince: undefined };
    return { ...policy, quietSince: policy.quietSince ?? observedAt ?? now.toISOString() };
}
export function quietWindowExpired(policy, now = new Date()) {
    if (!policy.quietSince)
        return false;
    return now.getTime() - new Date(policy.quietSince).getTime() >= policy.durationMs;
}
export function applyNoActionPolicy(goal, observedAt, now = new Date()) {
    const quietWindow = updateQuietWindow(goal.schedule.quietWindow, false, observedAt, now);
    const backoff = increaseBackoff(goal.schedule.backoff);
    const expired = quietWindowExpired(quietWindow, now);
    const state = expired ? quietWindow.onExpire : goal.state === "running" ? "active" : goal.state;
    return {
        ...goal,
        state,
        updatedAt: now.toISOString(),
        schedule: { ...goal.schedule, quietWindow, backoff, nextCheckAt: expired ? goal.schedule.nextCheckAt : nextCheckAt(backoff, now) },
    };
}
export function applyActionablePolicy(goal, now = new Date()) {
    const backoff = resetBackoff(goal.schedule.backoff);
    return {
        ...goal,
        state: "active",
        updatedAt: now.toISOString(),
        schedule: { ...goal.schedule, backoff, quietWindow: updateQuietWindow(goal.schedule.quietWindow, true, now.toISOString(), now), nextCheckAt: now.toISOString() },
    };
}
export function isDue(goal, now = new Date()) {
    return new Date(goal.schedule.nextCheckAt).getTime() <= now.getTime();
}
export function isTerminal(state) {
    return state === "completed" || state === "cancelled" || state === "dormant";
}
//# sourceMappingURL=policy.js.map