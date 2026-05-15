export interface ReplaceFileOps {
    rename(source: string, destination: string): Promise<void>;
    rm(target: string, options: {
        force: boolean;
    }): Promise<void>;
}
export declare function ensureDir(dir: string): Promise<void>;
export declare function readJsonFile<T>(file: string): Promise<T>;
export declare function writeJsonAtomic(file: string, value: unknown): Promise<void>;
export declare function replaceFile(temp: string, file: string, options?: {
    windows?: boolean;
    ops?: ReplaceFileOps;
}): Promise<void>;
export declare function removeIfExists(file: string): Promise<void>;
