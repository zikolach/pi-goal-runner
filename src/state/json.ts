import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJsonFile<T>(file: string): Promise<T> {
  const text = await readFile(file, "utf8");
  return JSON.parse(text) as T;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

export async function removeIfExists(file: string): Promise<void> {
  await rm(file, { recursive: true, force: true });
}
