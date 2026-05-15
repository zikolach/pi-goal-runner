import type { CompleteEvent, GoalRecord, GoalType } from "../types.js";
import type { GoalStore } from "../state/store.js";
import type { GhExecutor } from "../github/gh.js";

export interface GoalAdapterContext {
  store: GoalStore;
  gh: GhExecutor;
  now: Date;
}

export interface GoalActionability {
  actionable: boolean;
  observedAt: string;
  reason: string;
}

export interface PreparedWorkerInput {
  goal: GoalRecord;
  prompt: string;
  completionContext?: unknown;
}

export interface GoalDisplayMetadata {
  target?: string;
  workspace?: string;
  details?: Array<{ label: string; value: string }>;
}

export interface GoalAdapter<Observation = unknown, Actionability extends GoalActionability = GoalActionability> {
  type: GoalType;
  observe(goal: GoalRecord, context: GoalAdapterContext): Promise<Observation>;
  analyze(goal: GoalRecord, observation: Observation, context: GoalAdapterContext): Promise<Actionability>;
  recordObservation?(goal: GoalRecord, observation: Observation, actionability: Actionability, context: GoalAdapterContext): Promise<void>;
  prepareWorker?(goal: GoalRecord, observation: Observation, actionability: Actionability, context: GoalAdapterContext): Promise<PreparedWorkerInput>;
  handleSuccessfulCompletion?(goal: GoalRecord, event: CompleteEvent, context: GoalAdapterContext, completionContext?: unknown): Promise<void>;
  display?(goal: GoalRecord): GoalDisplayMetadata;
}
