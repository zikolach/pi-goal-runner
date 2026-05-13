import { readdir } from "node:fs/promises";
import { defaultSchedule } from "../policy.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./json.js";
import { createStatePaths } from "./paths.js";
export function createGoalStore(root) {
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
            const goal = {
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
            const goals = [];
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name === "worktrees")
                    continue;
                try {
                    goals.push(await this.get(entry.name));
                }
                catch {
                    // Ignore corrupt or incomplete goal dirs in list output.
                }
            }
            return goals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        },
        async get(goalId) {
            const goal = await readJsonFile(paths.stateFile(goalId));
            if (goal.schemaVersion !== 1)
                throw new Error(`Unsupported goal schema for ${goalId}`);
            return goal;
        },
        async update(goalId, updater) {
            const current = await this.get(goalId);
            const next = await updater({ ...current, pendingDecisions: [...current.pendingDecisions], runHistory: [...current.runHistory] });
            const stamped = { ...next, updatedAt: new Date().toISOString() };
            await writeJsonAtomic(paths.stateFile(goalId), stamped);
            return stamped;
        },
        async setState(goalId, state) {
            return this.update(goalId, (goal) => ({ ...goal, state }));
        },
    };
}
export function createGoalId(prefix = "goal") {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
}
//# sourceMappingURL=store.js.map