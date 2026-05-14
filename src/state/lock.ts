import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StatePaths } from "./paths.js";
import { ensureDir } from "./json.js";

export interface GoalLock {
  goalId: string;
  path: string;
  release(): Promise<void>;
}

export async function acquireGoalLock(paths: StatePaths, goalId: string, staleMs = 30 * 60_000): Promise<GoalLock | undefined> {
  const lockPath = paths.lockDir(goalId);
  await ensureDir(paths.goalDir(goalId));
  try {
    await mkdir(lockPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await isStale(lockPath, staleMs)) {
      await rm(lockPath, { recursive: true, force: true });
      return acquireGoalLock(paths, goalId, staleMs);
    }
    return undefined;
  }
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
  return {
    goalId,
    path: lockPath,
    release: async () => {
      await rm(lockPath, { recursive: true, force: true });
    },
  };
}

export async function withGoalLock<T>(paths: StatePaths, goalId: string, fn: () => Promise<T>): Promise<T | undefined> {
  const lock = await acquireGoalLock(paths, goalId);
  if (!lock) return undefined;
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const text = await readFile(path.join(lockPath, "owner.json"), "utf8");
    const parsed = JSON.parse(text) as { createdAt?: string };
    if (!parsed.createdAt) return isLockDirStale(lockPath, staleMs);
    const createdAtMs = new Date(parsed.createdAt).getTime();
    if (!Number.isFinite(createdAtMs)) return isLockDirStale(lockPath, staleMs);
    return Date.now() - createdAtMs > staleMs;
  } catch {
    return isLockDirStale(lockPath, staleMs);
  }
}

async function isLockDirStale(lockPath: string, staleMs: number): Promise<boolean> {
  if (staleMs <= 0) return true;
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs >= staleMs;
  } catch {
    return true;
  }
}
