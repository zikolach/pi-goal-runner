import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
export async function ensureDir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
        await chmod(dir, 0o700);
    }
    catch (error) {
        if (process.platform === "win32" && isNodeError(error) && error.code === "EPERM")
            return;
        throw error;
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
export async function readJsonFile(file) {
    const text = await readFile(file, "utf8");
    return JSON.parse(text);
}
export async function writeJsonAtomic(file, value) {
    await ensureDir(path.dirname(file));
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    const data = `${JSON.stringify(value, null, 2)}\n`;
    const handle = await open(temp, "w", 0o600);
    try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await replaceFile(temp, file);
    }
    catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
    }
}
export async function replaceFile(temp, file, options = {}) {
    const ops = options.ops ?? { rename, rm };
    const windows = options.windows ?? process.platform === "win32";
    if (!windows) {
        await ops.rename(temp, file);
        return;
    }
    const backup = `${temp}.bak`;
    let hasBackup = false;
    try {
        await ops.rename(file, backup);
        hasBackup = true;
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT")
            throw error;
    }
    try {
        await ops.rename(temp, file);
    }
    catch (error) {
        if (hasBackup)
            await restoreBackupAfterFailedReplace(ops, backup, file, error);
        throw error;
    }
    if (hasBackup)
        await ops.rm(backup, { force: true }).catch(() => undefined);
}
async function restoreBackupAfterFailedReplace(ops, backup, file, replaceError) {
    try {
        await ops.rename(backup, file);
        return;
    }
    catch (restoreError) {
        try {
            await ops.rm(file, { force: true });
            await ops.rename(backup, file);
            return;
        }
        catch (secondRestoreError) {
            throw new AggregateError([replaceError, restoreError, secondRestoreError], `Failed to restore ${file} from backup after replace failure`);
        }
    }
}
export async function removeIfExists(file) {
    await rm(file, { recursive: true, force: true });
}
//# sourceMappingURL=json.js.map