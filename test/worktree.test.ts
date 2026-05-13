import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStatePaths } from "../src/state/paths.js";
import { createOrReuseWorktree } from "../src/worker/worktree.js";

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
