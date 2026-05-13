export declare function ensureDir(dir: string): Promise<void>;
export declare function readJsonFile<T>(file: string): Promise<T>;
export declare function writeJsonAtomic(file: string, value: unknown): Promise<void>;
export declare function removeIfExists(file: string): Promise<void>;
