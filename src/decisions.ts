import type { DecisionRecord, GoalRecord } from "./types.js";
import { redactText } from "./redaction.js";
import type { GoalStore } from "./state/store.js";

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
  const decision = goal.pendingDecisions.find((item) => item.id === decisionId && item.status === "pending");
  if (!decision) throw new Error(`Unknown pending decision: ${decisionId}`);
  if (!decision.options.some((option) => option.id === choice)) {
    throw new Error(`Invalid choice '${choice}'. Valid choices: ${decision.options.map((option) => option.id).join(", ")}`);
  }
  const answered: DecisionRecord = { ...decision, status: "answered", answer: choice, answeredAt: new Date().toISOString() };
  await store.update(goal.id, (current) => ({
    ...current,
    state: current.state === "needs_decision" ? "active" : current.state,
    pendingDecisions: current.pendingDecisions.map((item) => (item.id === decisionId ? answered : item)),
    schedule: { ...current.schedule, nextCheckAt: new Date().toISOString() },
  }));
  return answered;
}
