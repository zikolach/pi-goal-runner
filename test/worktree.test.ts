import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createStatePaths } from "../src/state/paths.js";
import { createOrReuseWorktree } from "../src/worker/worktree.js";

const execFileAsync = promisify(execFile);

async function createRepo(repoPath: string): Promise<void> {
  await execFileAsync("git", ["init", repoPath]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.name", "Test User"]);
  await writeFile(path.join(repoPath, "file.txt"), "data");
  await execFileAsync("git", ["-C", repoPath, "add", "file.txt"]);
  await execFileAsync("git", ["-C", repoPath, "commit", "-m", "initial"]);
}

test("worktree creation fails safely for non-empty invalid path", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}`);
  const worktreePath = path.join(root, "worktree");
  try {
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, "leftover.txt"), "data");
    await assert.rejects(() => createOrReuseWorktree(createStatePaths(root), root, worktreePath, "branch"), /not a valid git worktree and is not empty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree reuse requires rev-parse to report a real worktree", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-bare`);
  const worktreePath = path.join(root, "bare.git");
  try {
    await execFileAsync("git", ["init", "--bare", worktreePath]);
    await assert.rejects(() => createOrReuseWorktree(createStatePaths(root), root, worktreePath), /not a valid git worktree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree branch argument is separated from git options", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-branch`);
  const repoPath = path.join(root, "repo");
  const worktreePath = path.join(root, "state", "worktrees", "wt");
  try {
    await createRepo(repoPath);
    await execFileAsync("git", ["-C", repoPath, "update-ref", "refs/heads/-bad", "HEAD"]);
    await createOrReuseWorktree(createStatePaths(path.join(root, "state")), repoPath, worktreePath, "-bad");

    await assert.rejects(() => execFileAsync("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", "refs/heads/ad"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree reuse surfaces fetch failures without falling through to creation", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-fetch`);
  const repoPath = path.join(root, "repo");
  const worktreePath = path.join(root, "state", "worktrees", "wt");
  try {
    await createRepo(repoPath);
    await execFileAsync("git", ["-C", repoPath, "worktree", "add", worktreePath]);
    await execFileAsync("git", ["-C", worktreePath, "remote", "add", "broken", path.join(root, "missing-remote.git")]);

    await assert.rejects(() => createOrReuseWorktree(createStatePaths(path.join(root, "state")), repoPath, worktreePath, "main"), /Could not update existing worktree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
