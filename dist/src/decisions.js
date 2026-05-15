import { redactText } from "./redaction.js";
import { withGoalLock } from "./state/lock.js";
export function addPendingDecision(goal, decision) {
    const safe = {
        ...decision,
        id: redactText(decision.id, 120),
        prompt: redactText(decision.prompt, 2_000),
        options: decision.options.map((option) => ({ id: redactText(option.id, 80), label: redactText(option.label, 120) })),
        status: "pending",
    };
    const pendingDecisions = [...goal.pendingDecisions.filter((existing) => existing.id !== safe.id), safe];
    const hasPendingRequiredDecision = pendingDecisions.some((item) => item.status === "pending" && item.required);
    return {
        ...goal,
        state: hasPendingRequiredDecision ? "needs_decision" : goal.state === "running" || goal.state === "needs_decision" ? "active" : goal.state,
        pendingDecisions,
    };
}
export function listPendingDecisions(goals) {
    return goals.flatMap((goal) => goal.pendingDecisions.filter((decision) => decision.status === "pending"));
}
export async function answerDecision(store, decisionId, choice) {
    const goals = await store.list();
    const goal = goals.find((candidate) => candidate.pendingDecisions.some((decision) => decision.id === decisionId && decision.status === "pending"));
    if (!goal)
        throw new Error(`Unknown pending decision: ${decisionId}`);
    const answered = await withGoalLock(store.paths, goal.id, async () => {
        const current = await store.get(goal.id);
        const decision = current.pendingDecisions.find((item) => item.id === decisionId && item.status === "pending");
        if (!decision)
            throw new Error(`Unknown pending decision: ${decisionId}`);
        if (!decision.options.some((option) => option.id === choice)) {
            throw new Error(`Invalid choice '${choice}'. Valid choices: ${decision.options.map((option) => option.id).join(", ")}`);
        }
        const now = new Date().toISOString();
        const nextDecision = { ...decision, status: "answered", answer: choice, answeredAt: now };
        await store.update(goal.id, (latest) => {
            const pendingDecisions = latest.pendingDecisions.map((item) => (item.id === decisionId ? nextDecision : item));
            const hasPendingRequiredDecision = pendingDecisions.some((item) => item.status === "pending" && item.required);
            return {
                ...latest,
                state: latest.state === "needs_decision" && !hasPendingRequiredDecision ? "active" : latest.state,
                pendingDecisions,
                schedule: { ...latest.schedule, nextCheckAt: now },
            };
        });
        return nextDecision;
    });
    if (!answered)
        throw new Error(`Goal ${goal.id} is busy; try again later`);
    return answered;
}
//# sourceMappingURL=decisions.js.map