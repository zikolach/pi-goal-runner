import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { GoalRecord } from "../types.js";
import type { GoalStore } from "../state/store.js";
import type { StatePaths } from "../state/paths.js";
import { redactText } from "../redaction.js";

const execFileAsync = promisify(execFile);

export async function ensureGoalWorktree(store: GoalStore, goal: GoalRecord): Promise<GoalRecord> {
  if (!goal.github) return goal;
  if (goal.github.repository.worktreePath) return goal;
  const worktreePath = store.paths.worktreeDir(goal.id);
  const branch = goal.github.repository.branch;
  const repoPath = goal.github.repository.localPath ?? goal.cwd;
  if (!repoPath) throw new Error("Repository local path or cwd is required to create a worktree");
  await createOrReuseWorktree(store.paths, repoPath, worktreePath, branch);
  return store.update(goal.id, (current) => ({
    ...current,
    github: current.github ? { ...current.github, repository: { ...current.github.repository, worktreePath } } : current.github,
  }));
}

export async function createOrReuseWorktree(paths: StatePaths, repoPath: string, worktreePath: string, branch?: string): Promise<void> {
  await mkdir(paths.worktreesDir, { recursive: true });
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"]);
    if (stdout.trim() !== "true") throw new Error(`Path is not a git worktree: ${worktreePath}`);
    if (branch) await execFileAsync("git", ["-C", worktreePath, "fetch", "--all", "--prune"]);
    return;
  } catch {
    // Create below.
  }
  await prepareWorktreePath(worktreePath);
  const args = ["-C", repoPath, "worktree", "add", worktreePath];
  if (branch) args.push("--", branch);
  try {
    await execFileAsync("git", args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    throw new Error(`Could not create worktree: ${redactText(err.stderr || err.stdout || err.message, 1_000)}`);
  }
}

async function prepareWorktreePath(worktreePath: string): Promise<void> {
  try {
    const info = await stat(worktreePath);
    if (!info.isDirectory()) throw new Error(`Worktree path exists and is not a directory: ${worktreePath}`);
    const entries = await readdir(worktreePath);
    if (entries.length > 0) throw new Error(`Worktree path exists but is not a valid git worktree and is not empty: ${worktreePath}`);
    await rm(worktreePath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
