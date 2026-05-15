export interface GhExecutor {
    run(args: string[], options?: {
        cwd?: string;
    }): Promise<string>;
}
export declare function createGhExecutor(): GhExecutor;
export declare function ensureGhAuth(gh: GhExecutor): Promise<void>;
export declare function parseRepo(input: string): {
    owner: string;
    repo: string;
    url?: string;
};
export declare function parsePr(repoOrUrl: string, prInput: string): {
    repository: {
        owner: string;
        repo: string;
        url?: string;
    };
    prNumber: number;
    prUrl?: string;
};
export declare function normalizedRepoUrl(owner: string, repo: string): string;
