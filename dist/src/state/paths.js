import { homedir } from "node:os";
import path from "node:path";
export function defaultStateRoot() {
    return process.env.PI_GOAL_STATE_DIR ?? path.join(homedir(), ".pi", "agent", "goals");
}
export function createStatePaths(root = defaultStateRoot()) {
    const goalsDir = root;
    const worktreesDir = path.join(root, "worktrees");
    return {
        root,
        goalsDir,
        worktreesDir,
        goalDir: (goalId) => path.join(goalsDir, sanitizeGoalId(goalId)),
        stateFile: (goalId) => path.join(goalsDir, sanitizeGoalId(goalId), "state.json"),
        eventsFile: (goalId) => path.join(goalsDir, sanitizeGoalId(goalId), "events.jsonl"),
        lockDir: (goalId) => path.join(goalsDir, sanitizeGoalId(goalId), ".lock"),
        worktreeDir: (goalId) => path.join(worktreesDir, sanitizeGoalId(goalId)),
    };
}
export function sanitizeGoalId(goalId) {
    if (goalId === "." ||
        goalId === ".." ||
        goalId.includes("..") ||
        path.isAbsolute(goalId) ||
        path.basename(goalId) !== goalId ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(goalId)) {
        throw new Error(`Invalid goal id: ${goalId}`);
    }
    return goalId;
}
//# sourceMappingURL=paths.js.map