import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./json.js";
export const DEFAULT_GOAL_LOCK_STALE_MS = 50 * 60_000;
export async function acquireGoalLock(paths, goalId, staleMs = DEFAULT_GOAL_LOCK_STALE_MS) {
    const lockPath = paths.lockDir(goalId);
    await ensureDir(paths.goalDir(goalId));
    try {
        await mkdir(lockPath, { recursive: false, mode: 0o700 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
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
export async function withGoalLock(paths, goalId, fn) {
    const lock = await acquireGoalLock(paths, goalId);
    if (!lock)
        return undefined;
    try {
        return await fn();
    }
    finally {
        await lock.release();
    }
}
async function isStale(lockPath, staleMs) {
    try {
        const text = await readFile(path.join(lockPath, "owner.json"), "utf8");
        const parsed = JSON.parse(text);
        if (isPidAlive(parsed.pid))
            return false;
        if (!parsed.createdAt)
            return isLockDirStale(lockPath, staleMs);
        const createdAtMs = new Date(parsed.createdAt).getTime();
        if (!Number.isFinite(createdAtMs))
            return isLockDirStale(lockPath, staleMs);
        return Date.now() - createdAtMs > staleMs;
    }
    catch {
        return isLockDirStale(lockPath, staleMs);
    }
}
function isPidAlive(pid) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
async function isLockDirStale(lockPath, staleMs) {
    if (staleMs <= 0)
        return true;
    try {
        const info = await stat(lockPath);
        return Date.now() - info.mtimeMs >= staleMs;
    }
    catch {
        return true;
    }
}
//# sourceMappingURL=lock.js.map