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
  let reusableWorktree = false;
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"], { maxBuffer: 10 * 1024 * 1024 });
    reusableWorktree = stdout.trim() === "true";
  } catch {
    reusableWorktree = false;
  }
  if (reusableWorktree) {
    if (branch) await updateExistingWorktree(worktreePath, branch);
    return;
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

async function updateExistingWorktree(worktreePath: string, branch: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", worktreePath, "fetch", "--all", "--prune"], { maxBuffer: 10 * 1024 * 1024 });
    const remoteCommit = await resolveRemoteBranchCommit(worktreePath, branch);
    try {
      await execFileAsync("git", ["-C", worktreePath, "switch", "--", branch], { maxBuffer: 10 * 1024 * 1024 });
    } catch (switchError) {
      if (!remoteCommit) throw switchError;
      await execFileAsync("git", ["-C", worktreePath, "switch", "--create", branch, "--track", `origin/${branch}`], { maxBuffer: 10 * 1024 * 1024 });
    }
    if (remoteCommit) await execFileAsync("git", ["-C", worktreePath, "reset", "--hard", remoteCommit], { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Could not update existing worktree: ${formatGitError(error)}`);
  }
}

async function resolveRemoteBranchCommit(worktreePath: string, branch: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], { maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function formatGitError(error: unknown): string {
  const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
  return redactText(err.stderr || err.stdout || err.message || String(error), 1_000);
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
