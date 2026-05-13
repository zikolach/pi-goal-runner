import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { redactText } from "../redaction.js";
const execFileAsync = promisify(execFile);
export async function ensureGoalWorktree(store, goal) {
    if (!goal.github)
        return goal;
    if (goal.github.repository.worktreePath)
        return goal;
    const worktreePath = store.paths.worktreeDir(goal.id);
    const branch = goal.github.repository.branch;
    const repoPath = goal.github.repository.localPath ?? goal.cwd;
    if (!repoPath)
        throw new Error("Repository local path or cwd is required to create a worktree");
    await createOrReuseWorktree(store.paths, repoPath, worktreePath, branch);
    return store.update(goal.id, (current) => ({
        ...current,
        github: current.github ? { ...current.github, repository: { ...current.github.repository, worktreePath } } : current.github,
    }));
}
export async function createOrReuseWorktree(paths, repoPath, worktreePath, branch) {
    await mkdir(paths.worktreesDir, { recursive: true });
    try {
        await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"]);
        if (branch)
            await execFileAsync("git", ["-C", worktreePath, "fetch", "--all", "--prune"]);
        return;
    }
    catch {
        // Create below.
    }
    const args = ["-C", repoPath, "worktree", "add", worktreePath];
    if (branch)
        args.push(branch);
    try {
        await execFileAsync("git", args, { maxBuffer: 10 * 1024 * 1024 });
    }
    catch (error) {
        const err = error;
        throw new Error(`Could not create worktree: ${redactText(err.stderr || err.stdout || err.message, 1_000)}`);
    }
}
//# sourceMappingURL=worktree.js.map