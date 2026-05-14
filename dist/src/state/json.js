import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
export async function ensureDir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
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
    if (process.platform === "win32")
        await rm(file, { force: true });
    await rename(temp, file);
}
export async function removeIfExists(file) {
    await rm(file, { recursive: true, force: true });
}
//# sourceMappingURL=json.js.map