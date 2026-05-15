import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { defaultSchedule } from "../src/policy.js";
import { createGoalStore } from "../src/state/store.js";
import { createStatePaths } from "../src/state/paths.js";
import { createOrReuseWorktree, ensureGoalWorktree } from "../src/worker/worktree.js";

const execFileAsync = promisify(execFile);

async function createRepo(repoPath: string): Promise<void> {
  await execFileAsync("git", ["init", repoPath]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.name", "Test User"]);
  await writeFile(path.join(repoPath, "file.txt"), "data");
  await execFileAsync("git", ["-C", repoPath, "add", "file.txt"]);
  await execFileAsync("git", ["-C", repoPath, "commit", "-m", "initial"]);
}

async function headSha(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"]);
  return stdout.trim();
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

test("createOrReuseWorktree creates the worktrees root with restrictive permissions", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-mode`);
  const repoPath = path.join(root, "repo");
  const statePath = path.join(root, "state");
  const paths = createStatePaths(statePath);
  const worktreePath = path.join(paths.worktreesDir, "wt");
  try {
    await createRepo(repoPath);
    await createOrReuseWorktree(paths, repoPath, worktreePath);

    if (process.platform !== "win32") assert.equal((await stat(paths.worktreesDir)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureGoalWorktree recreates a missing recorded worktree", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-ensure`);
  const repoPath = path.join(root, "repo");
  const statePath = path.join(root, "state");
  const recordedWorktreePath = path.join(statePath, "worktrees", "g");
  const store = createGoalStore(statePath);
  try {
    await createRepo(repoPath);
    await execFileAsync("git", ["-C", repoPath, "branch", "feature"]);
    const goal = await store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r", localPath: repoPath, branch: "feature", worktreePath: recordedWorktreePath }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });

    const updated = await ensureGoalWorktree(store, goal);

    assert.equal(updated.github?.repository.worktreePath, recordedWorktreePath);
    assert.equal(await readFile(path.join(recordedWorktreePath, "file.txt"), "utf8"), "data");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureGoalWorktree resets recorded paths outside the managed worktrees directory", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-outside`);
  const repoPath = path.join(root, "repo");
  const statePath = path.join(root, "state");
  const outsideWorktreePath = path.join(root, "outside-empty");
  const store = createGoalStore(statePath);
  try {
    await createRepo(repoPath);
    await mkdir(outsideWorktreePath, { recursive: true });
    const goal = await store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r", localPath: repoPath, worktreePath: outsideWorktreePath }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });

    const updated = await ensureGoalWorktree(store, goal);

    assert.equal(updated.github?.repository.worktreePath, store.paths.worktreeDir("g"));
    assert.equal((await store.get("g")).github?.repository.worktreePath, store.paths.worktreeDir("g"));
    assert.equal((await stat(outsideWorktreePath)).isDirectory(), true);
    assert.equal(await readFile(path.join(store.paths.worktreeDir("g"), "file.txt"), "utf8"), "data");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureGoalWorktree resets recorded sibling worktree paths", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-sibling`);
  const repoPath = path.join(root, "repo");
  const statePath = path.join(root, "state");
  const siblingWorktreePath = path.join(statePath, "worktrees", "other-goal");
  const store = createGoalStore(statePath);
  try {
    await createRepo(repoPath);
    const goal = await store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r", localPath: repoPath, worktreePath: siblingWorktreePath }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });

    const updated = await ensureGoalWorktree(store, goal);

    assert.equal(updated.github?.repository.worktreePath, store.paths.worktreeDir("g"));
    assert.equal((await store.get("g")).github?.repository.worktreePath, store.paths.worktreeDir("g"));
    await assert.rejects(() => stat(siblingWorktreePath), /ENOENT/);
    assert.equal(await readFile(path.join(store.paths.worktreeDir("g"), "file.txt"), "utf8"), "data");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureGoalWorktree creates a detached isolated worktree when the PR branch is checked out", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-checked-out`);
  const repoPath = path.join(root, "repo");
  const statePath = path.join(root, "state");
  const store = createGoalStore(statePath);
  try {
    await createRepo(repoPath);
    await execFileAsync("git", ["-C", repoPath, "checkout", "-b", "feature"]);
    const observedHeadSha = await headSha(repoPath);
    const goal = await store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r", localPath: repoPath, branch: "feature" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });

    const updated = await ensureGoalWorktree(store, goal, { observedHeadSha });
    const { stdout: checkedOutBranch } = await execFileAsync("git", ["-C", updated.github?.repository.worktreePath ?? "", "branch", "--show-current"]);
    const { stdout: worktreeHead } = await execFileAsync("git", ["-C", updated.github?.repository.worktreePath ?? "", "rev-parse", "HEAD"]);

    assert.equal(updated.github?.repository.worktreePath, store.paths.worktreeDir("g"));
    assert.equal(updated.github?.repository.worktreeMode, "isolated");
    assert.equal(updated.github?.repository.worktreeHeadSha, observedHeadSha);
    assert.equal(updated.github?.repository.pushRemote, "origin");
    assert.equal(updated.github?.repository.pushBranch, "feature");
    assert.equal(checkedOutBranch.trim(), "");
    assert.equal(worktreeHead.trim(), observedHeadSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureGoalWorktree migrates same-path goals to isolated worktrees by default", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-same-path`);
  const repoPath = path.join(root, "repo");
  const statePath = path.join(root, "state");
  const store = createGoalStore(statePath);
  try {
    await createRepo(repoPath);
    const goal = await store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r", localPath: repoPath, worktreePath: repoPath }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });

    const updated = await ensureGoalWorktree(store, goal, { observedHeadSha: await headSha(repoPath) });

    assert.equal(updated.github?.repository.worktreePath, store.paths.worktreeDir("g"));
    assert.equal(updated.github?.repository.worktreeMode, "isolated");
    assert.notEqual(path.resolve(updated.github?.repository.worktreePath ?? ""), path.resolve(repoPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit same-path mode keeps the user checkout", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-explicit-same-path`);
  const repoPath = path.join(root, "repo");
  const statePath = path.join(root, "state");
  const store = createGoalStore(statePath);
  try {
    await createRepo(repoPath);
    const goal = await store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r", localPath: repoPath, worktreeMode: "same_path" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });

    const updated = await ensureGoalWorktree(store, goal, { observedHeadSha: await headSha(repoPath) });

    assert.equal(updated.github?.repository.worktreePath, repoPath);
    assert.equal(updated.github?.repository.worktreeMode, "same_path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dirty isolated worktrees fail safely before refresh", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-dirty`);
  const repoPath = path.join(root, "repo");
  const worktreePath = path.join(root, "state", "worktrees", "wt");
  try {
    await createRepo(repoPath);
    await createOrReuseWorktree(createStatePaths(path.join(root, "state")), repoPath, worktreePath);
    await writeFile(path.join(worktreePath, "untracked.txt"), "do not delete");

    await assert.rejects(() => createOrReuseWorktree(createStatePaths(path.join(root, "state")), repoPath, worktreePath), /uncommitted or untracked changes/);
    assert.equal(await readFile(path.join(worktreePath, "untracked.txt"), "utf8"), "do not delete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user checkout untracked files do not block isolated worker worktree creation", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-user-dirty`);
  const repoPath = path.join(root, "repo");
  const statePath = path.join(root, "state");
  const store = createGoalStore(statePath);
  try {
    await createRepo(repoPath);
    await writeFile(path.join(repoPath, "local-notes.md"), "human work");
    const goal = await store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      github: { repository: { owner: "o", repo: "r", localPath: repoPath }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });

    const updated = await ensureGoalWorktree(store, goal, { observedHeadSha: await headSha(repoPath) });

    assert.equal(updated.github?.repository.worktreePath, store.paths.worktreeDir("g"));
    await assert.rejects(() => stat(path.join(store.paths.worktreeDir("g"), "local-notes.md")), /ENOENT/);
    assert.equal(await readFile(path.join(repoPath, "local-notes.md"), "utf8"), "human work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureGoalWorktree uses caller timestamp when assigning worktree path", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-updated-at`);
  const repoPath = path.join(root, "repo");
  const statePath = path.join(root, "state");
  const store = createGoalStore(statePath);
  const updatedAt = "2026-01-01T01:00:00.000Z";
  try {
    await createRepo(repoPath);
    await execFileAsync("git", ["-C", repoPath, "branch", "feature"]);
    const goal = await store.create({
      id: "g",
      type: "github_pr_review",
      state: "active",
      summary: "g",
      schedule: defaultSchedule(),
      updatedAt: "2025-01-01T00:00:00.000Z",
      github: { repository: { owner: "o", repo: "r", localPath: repoPath, branch: "feature" }, prNumber: 1, validationCommands: [], autoReplyAndResolve: false, handledThreadIds: [], handledCheckNames: [] },
    });

    const updated = await ensureGoalWorktree(store, goal, { updatedAt });

    assert.equal(updated.github?.repository.worktreePath, store.paths.worktreeDir("g"));
    assert.equal(updated.updatedAt, updatedAt);
    assert.equal((await store.get("g")).updatedAt, updatedAt);
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

test("reused worktree resets branch to fetched remote revision", async () => {
  const root = path.join(tmpdir(), `goal-runner-worktree-${Date.now()}-reuse`);
  const repoPath = path.join(root, "repo");
  const remotePath = path.join(root, "remote.git");
  const updaterPath = path.join(root, "updater");
  const worktreePath = path.join(root, "state", "worktrees", "wt");
  try {
    await createRepo(repoPath);
    await execFileAsync("git", ["-C", repoPath, "branch", "feature"]);
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await execFileAsync("git", ["-C", repoPath, "remote", "add", "origin", remotePath]);
    await execFileAsync("git", ["-C", repoPath, "push", "-u", "origin", "feature"]);
    await createOrReuseWorktree(createStatePaths(path.join(root, "state")), repoPath, worktreePath, "feature");

    await execFileAsync("git", ["clone", remotePath, updaterPath]);
    await execFileAsync("git", ["-C", updaterPath, "checkout", "feature"]);
    await execFileAsync("git", ["-C", updaterPath, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", updaterPath, "config", "user.name", "Test User"]);
    await writeFile(path.join(updaterPath, "file.txt"), "updated");
    await execFileAsync("git", ["-C", updaterPath, "commit", "-am", "advance"]);
    await execFileAsync("git", ["-C", updaterPath, "push", "origin", "feature"]);

    await createOrReuseWorktree(createStatePaths(path.join(root, "state")), repoPath, worktreePath, "feature");

    assert.equal(await readFile(path.join(worktreePath, "file.txt"), "utf8"), "updated");
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

    await assert.rejects(() => createOrReuseWorktree(createStatePaths(path.join(root, "state")), repoPath, worktreePath, "main"), /Could not refresh isolated worktree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
