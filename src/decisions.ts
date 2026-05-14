import type { DecisionRecord, GoalRecord } from "./types.js";
import { redactText } from "./redaction.js";
import type { GoalStore } from "./state/store.js";
import { withGoalLock } from "./state/lock.js";

export function addPendingDecision(goal: GoalRecord, decision: DecisionRecord): GoalRecord {
  const safe: DecisionRecord = {
    ...decision,
    id: redactText(decision.id, 120),
    prompt: redactText(decision.prompt, 2_000),
    options: decision.options.map((option) => ({ id: redactText(option.id, 80), label: redactText(option.label, 120) })),
    status: "pending",
  };
  return {
    ...goal,
    state: "needs_decision",
    pendingDecisions: [...goal.pendingDecisions.filter((existing) => existing.id !== safe.id), safe],
  };
}

export function listPendingDecisions(goals: GoalRecord[]): DecisionRecord[] {
  return goals.flatMap((goal) => goal.pendingDecisions.filter((decision) => decision.status === "pending"));
}

export async function answerDecision(store: GoalStore, decisionId: string, choice: string): Promise<DecisionRecord> {
  const goals = await store.list();
  const goal = goals.find((candidate) => candidate.pendingDecisions.some((decision) => decision.id === decisionId && decision.status === "pending"));
  if (!goal) throw new Error(`Unknown pending decision: ${decisionId}`);
  const answered = await withGoalLock(store.paths, goal.id, async () => {
    const current = await store.get(goal.id);
    const decision = current.pendingDecisions.find((item) => item.id === decisionId && item.status === "pending");
    if (!decision) throw new Error(`Unknown pending decision: ${decisionId}`);
    if (!decision.options.some((option) => option.id === choice)) {
      throw new Error(`Invalid choice '${choice}'. Valid choices: ${decision.options.map((option) => option.id).join(", ")}`);
    }
    const now = new Date().toISOString();
    const nextDecision: DecisionRecord = { ...decision, status: "answered", answer: choice, answeredAt: now };
    await store.update(goal.id, (latest) => ({
      ...latest,
      state: latest.state === "needs_decision" ? "active" : latest.state,
      pendingDecisions: latest.pendingDecisions.map((item) => (item.id === decisionId ? nextDecision : item)),
      schedule: { ...latest.schedule, nextCheckAt: now },
    }));
    return nextDecision;
  });
  if (!answered) throw new Error(`Goal ${goal.id} is busy; try again later`);
  return answered;
}
