import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StatePaths } from "./paths.js";
import { ensureDir } from "./json.js";

export interface GoalLock {
  goalId: string;
  path: string;
  release(): Promise<void>;
}

export const DEFAULT_GOAL_LOCK_STALE_MS = 50 * 60_000;

export async function acquireGoalLock(paths: StatePaths, goalId: string, staleMs = DEFAULT_GOAL_LOCK_STALE_MS): Promise<GoalLock | undefined> {
  const lockPath = paths.lockDir(goalId);
  await ensureDir(paths.root);
  try {
    await mkdir(lockPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`Unknown goal: ${goalId}`, { cause: error });
    if (code !== "EEXIST") throw error;
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
    const parsed = JSON.parse(text) as { createdAt?: string; pid?: number };
    if (isPidAlive(parsed.pid)) return false;
    if (!parsed.createdAt) return isLockDirStale(lockPath, staleMs);
    const createdAtMs = new Date(parsed.createdAt).getTime();
    if (!Number.isFinite(createdAtMs)) return isLockDirStale(lockPath, staleMs);
    return Date.now() - createdAtMs > staleMs;
  } catch {
    return isLockDirStale(lockPath, staleMs);
  }
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
