import { readdir } from "node:fs/promises";
import type { GoalRecord, GoalState } from "../types.js";
import { defaultSchedule } from "../policy.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./json.js";
import { createStatePaths, type StatePaths } from "./paths.js";

export interface GoalStore {
  paths: StatePaths;
  init(): Promise<void>;
  create(input: CreateGoalInput): Promise<GoalRecord>;
  list(): Promise<GoalRecord[]>;
  get(goalId: string): Promise<GoalRecord>;
  update(goalId: string, updater: (goal: GoalRecord) => GoalRecord | Promise<GoalRecord>): Promise<GoalRecord>;
  setState(goalId: string, state: GoalState): Promise<GoalRecord>;
}

export type CreateGoalInput = Omit<GoalRecord, "schemaVersion" | "createdAt" | "updatedAt" | "runHistory" | "pendingDecisions"> &
  Partial<Pick<GoalRecord, "createdAt" | "updatedAt" | "runHistory" | "pendingDecisions" | "schedule">>;

export function createGoalStore(root?: string): GoalStore {
  const paths = createStatePaths(root);
  return {
    paths,
    async init() {
      await ensureDir(paths.root);
      await ensureDir(paths.worktreesDir);
    },
    async create(input) {
      await this.init();
      const now = new Date().toISOString();
      const goal: GoalRecord = {
        schemaVersion: 1,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
        runHistory: input.runHistory ?? [],
        pendingDecisions: input.pendingDecisions ?? [],
        ...input,
        schedule: input.schedule ?? defaultSchedule(new Date(now)),
      };
      await ensureDir(paths.goalDir(goal.id));
      await writeJsonAtomic(paths.stateFile(goal.id), goal);
      return goal;
    },
    async list() {
      await this.init();
      const entries = await readdir(paths.goalsDir, { withFileTypes: true });
      const goals: GoalRecord[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "worktrees") continue;
        try {
          goals.push(await this.get(entry.name));
        } catch {
          // Ignore corrupt or incomplete goal dirs in list output.
        }
      }
      return goals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async get(goalId) {
      const goal = await readJsonFile<GoalRecord>(paths.stateFile(goalId));
      if (goal.schemaVersion !== 1) throw new Error(`Unsupported goal schema for ${goalId}`);
      return goal;
    },
    async update(goalId, updater) {
      const current = await this.get(goalId);
      const next = await updater({ ...current, pendingDecisions: [...current.pendingDecisions], runHistory: [...current.runHistory] });
      const stamped = { ...next, updatedAt: next.updatedAt !== current.updatedAt ? next.updatedAt : new Date().toISOString() };
      await writeJsonAtomic(paths.stateFile(goalId), stamped);
      return stamped;
    },
    async setState(goalId, state) {
      return this.update(goalId, (goal) => ({ ...goal, state }));
    },
  };
}

export function createGoalId(prefix = "goal"): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
