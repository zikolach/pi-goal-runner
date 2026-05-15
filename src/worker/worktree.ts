import { execFile } from "node:child_process";
import path from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { GoalRecord, RepositoryRef, WorktreeMode } from "../types.js";
import type { GoalStore } from "../state/store.js";
import type { StatePaths } from "../state/paths.js";
import { redactText } from "../redaction.js";
import { ensureDir } from "../state/json.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PUSH_REMOTE = "origin";

export interface EnsureGoalWorktreeOptions {
  updatedAt?: string;
  observedHeadSha?: string;
}

export interface CreateWorktreeOptions {
  branch?: string;
  observedHeadSha?: string;
  remote?: string;
}

export interface PreparedWorktree {
  path: string;
  mode: WorktreeMode;
  headSha?: string;
  pushRemote: string;
  pushBranch?: string;
}

export async function ensureGoalWorktree(store: GoalStore, goal: GoalRecord, options: EnsureGoalWorktreeOptions = {}): Promise<GoalRecord> {
  if (!goal.github) return goal;
  const repoPath = goal.github.repository.localPath ?? goal.cwd;
  if (!repoPath) throw new Error("Repository local path or cwd is required to create a worktree");

  const explicitMode = goal.github.repository.worktreeMode;
  if (explicitMode === "same_path") return ensureSamePathWorktree(store, goal, repoPath, options);

  const recordedWorktreePath = goal.github.repository.worktreePath;
  const expectedWorktreePath = store.paths.worktreeDir(goal.id);
  const worktreePath = recordedWorktreePath && isExpectedWorktreePath(expectedWorktreePath, recordedWorktreePath) ? recordedWorktreePath : expectedWorktreePath;
  const prepared = await createOrReuseWorktree(store.paths, repoPath, worktreePath, {
    branch: goal.github.repository.branch,
    observedHeadSha: options.observedHeadSha,
    remote: goal.github.repository.pushRemote ?? DEFAULT_PUSH_REMOTE,
  });
  const nextRepository = {
    ...goal.github.repository,
    worktreePath,
    worktreeMode: "isolated" as const,
    worktreeHeadSha: prepared.headSha ?? options.observedHeadSha ?? goal.github.repository.worktreeHeadSha,
    pushRemote: prepared.pushRemote,
    pushBranch: goal.github.repository.branch,
  };
  if (repositoriesMatch(goal.github.repository, nextRepository)) return goal;
  return store.update(
    goal.id,
    (current) => ({
      ...current,
      github: current.github ? { ...current.github, repository: { ...current.github.repository, ...nextRepository } } : current.github,
    }),
    options.updatedAt ? { updatedAt: options.updatedAt } : undefined,
  );
}

async function ensureSamePathWorktree(store: GoalStore, goal: GoalRecord, repoPath: string, options: EnsureGoalWorktreeOptions): Promise<GoalRecord> {
  if (!goal.github) return goal;
  const headSha = await resolveCommitish(repoPath, "HEAD").catch(() => options.observedHeadSha);
  const nextRepository = {
    ...goal.github.repository,
    worktreePath: repoPath,
    worktreeMode: "same_path" as const,
    worktreeHeadSha: headSha ?? goal.github.repository.worktreeHeadSha,
    pushRemote: goal.github.repository.pushRemote ?? DEFAULT_PUSH_REMOTE,
    pushBranch: goal.github.repository.branch,
  };
  if (repositoriesMatch(goal.github.repository, nextRepository)) return goal;
  return store.update(
    goal.id,
    (current) => ({
      ...current,
      github: current.github ? { ...current.github, repository: { ...current.github.repository, ...nextRepository } } : current.github,
    }),
    options.updatedAt ? { updatedAt: options.updatedAt } : undefined,
  );
}

function repositoriesMatch(left: RepositoryRef, right: RepositoryRef): boolean {
  const fields: Array<keyof RepositoryRef> = ["owner", "repo", "url", "localPath", "branch", "baseBranch", "worktreePath", "worktreeMode", "worktreeHeadSha", "pushRemote", "pushBranch"];
  return fields.every((field) => left[field] === right[field]);
}

function isExpectedWorktreePath(expectedWorktreePath: string, worktreePath: string): boolean {
  return path.resolve(worktreePath) === path.resolve(expectedWorktreePath);
}

export async function createOrReuseWorktree(paths: StatePaths, repoPath: string, worktreePath: string, branchOrOptions: string | CreateWorktreeOptions = {}): Promise<PreparedWorktree> {
  const options = typeof branchOrOptions === "string" ? { branch: branchOrOptions } : branchOrOptions;
  const pushRemote = options.remote ?? DEFAULT_PUSH_REMOTE;
  await ensureDir(paths.worktreesDir);
  let reusableWorktree = false;
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"], { maxBuffer: 10 * 1024 * 1024 });
    reusableWorktree = stdout.trim() === "true";
  } catch {
    reusableWorktree = false;
  }
  if (reusableWorktree) {
    const headSha = await updateExistingWorktree(worktreePath, options);
    return { path: worktreePath, mode: "isolated", headSha, pushRemote, pushBranch: options.branch };
  }
  await prepareWorktreePath(worktreePath);
  try {
    if (options.observedHeadSha || options.branch) await fetchRepositoryIfConfigured(repoPath);
    const revision = await resolveCheckoutRevision(repoPath, options);
    await execFileAsync("git", ["-C", repoPath, "worktree", "add", "--detach", worktreePath, "--", revision], { maxBuffer: 10 * 1024 * 1024 });
    const headSha = await resolveCommitish(worktreePath, "HEAD").catch(() => undefined);
    return { path: worktreePath, mode: "isolated", headSha, pushRemote, pushBranch: options.branch };
  } catch (error) {
    throw new Error(`Could not create isolated worktree: ${formatGitError(error)}`);
  }
}

async function updateExistingWorktree(worktreePath: string, options: CreateWorktreeOptions): Promise<string | undefined> {
  try {
    await assertWorktreeClean(worktreePath);
    if (options.observedHeadSha || options.branch) await fetchRepositoryIfConfigured(worktreePath);
    const revision = await resolveCheckoutRevision(worktreePath, options);
    await execFileAsync("git", ["-C", worktreePath, "checkout", "--detach", revision], { maxBuffer: 10 * 1024 * 1024 });
    await execFileAsync("git", ["-C", worktreePath, "reset", "--hard", revision], { maxBuffer: 10 * 1024 * 1024 });
    return resolveCommitish(worktreePath, "HEAD").catch(() => undefined);
  } catch (error) {
    throw new Error(`Could not refresh isolated worktree: ${formatGitError(error)}`);
  }
}

async function fetchRepositoryIfConfigured(repoPath: string): Promise<void> {
  if (!await hasConfiguredRemotes(repoPath)) return;
  await execFileAsync("git", ["-C", repoPath, "fetch", "--all", "--prune"], { maxBuffer: 10 * 1024 * 1024 });
}

async function hasConfiguredRemotes(repoPath: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "remote"], { maxBuffer: 1024 * 1024 });
  return stdout.trim().length > 0;
}

async function assertWorktreeClean(worktreePath: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"], { maxBuffer: 10 * 1024 * 1024 });
  if (stdout.trim()) throw new Error(`isolated worktree has uncommitted or untracked changes; inspect or clean ${worktreePath} before retrying`);
}

async function resolveCheckoutRevision(repoPath: string, options: CreateWorktreeOptions): Promise<string> {
  if (options.observedHeadSha) {
    const observed = await resolveCommitish(repoPath, options.observedHeadSha).catch(() => undefined);
    if (observed) return observed;
  }
  if (options.branch) {
    const remoteBranch = await resolveCommitish(repoPath, `refs/remotes/${options.remote ?? DEFAULT_PUSH_REMOTE}/${options.branch}`).catch(() => undefined);
    if (remoteBranch) return remoteBranch;
    return resolveCommitish(repoPath, options.branch);
  }
  return resolveCommitish(repoPath, "HEAD");
}

async function resolveCommitish(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
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
