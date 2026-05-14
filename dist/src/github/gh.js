import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactText } from "../redaction.js";
const execFileAsync = promisify(execFile);
export function createGhExecutor() {
    return {
        async run(args, options) {
            try {
                const { stdout } = await execFileAsync("gh", args, { cwd: options?.cwd, maxBuffer: 20 * 1024 * 1024 });
                return stdout;
            }
            catch (error) {
                const err = error;
                throw new Error(redactText(err.stderr || err.stdout || err.message));
            }
        },
    };
}
export async function ensureGhAuth(gh) {
    await gh.run(["auth", "status"]);
}
export function parseRepo(input) {
    const trimmed = input.trim();
    const urlMatch = trimmed.match(/github\.com[:/]([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/);
    if (urlMatch) {
        const repo = stripGitSuffix(urlMatch[2]);
        return { owner: urlMatch[1], repo, url: normalizedRepoUrl(urlMatch[1], repo) };
    }
    const slash = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (slash)
        return { owner: slash[1], repo: slash[2], url: normalizedRepoUrl(slash[1], slash[2]) };
    throw new Error("Repository must be owner/repo or a GitHub URL");
}
export function parsePr(repoOrUrl, prInput) {
    const trimmedPrInput = prInput.trim();
    const prUrlMatch = trimmedPrInput.match(/github\.com[:/]([^/]+)\/([^/?#]+)\/pull\/(\d+)/);
    if (prUrlMatch) {
        const owner = prUrlMatch[1];
        const repo = stripGitSuffix(prUrlMatch[2]);
        const prNumber = Number(prUrlMatch[3]);
        return { repository: { owner, repo, url: normalizedRepoUrl(owner, repo) }, prNumber, prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}` };
    }
    const repo = parseRepo(repoOrUrl);
    const numberMatch = trimmedPrInput.match(/^\d+$/);
    if (!numberMatch)
        throw new Error("PR must be a GitHub PR URL or an integer PR number");
    const prNumber = Number(numberMatch[0]);
    return { repository: repo, prNumber, prUrl: `https://github.com/${repo.owner}/${repo.repo}/pull/${prNumber}` };
}
export function normalizedRepoUrl(owner, repo) {
    return `https://github.com/${owner}/${repo}`;
}
function stripGitSuffix(repo) {
    return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}
//# sourceMappingURL=gh.js.map