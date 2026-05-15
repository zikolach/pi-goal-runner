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
const GITHUB_REPOSITORY_REFERENCE_PATTERN = /^(?:(?:https?|ssh|git):\/\/(?:[^@\s/]+@)?github\.com(?::\d+)?\/|(?:[^@\s/]+@)?github\.com:|github\.com\/)([^/\s?#]+)\/([^/\s?#]+)([/?#].*)?$/;
function matchGithubRepositoryReference(input) {
    const match = input.match(GITHUB_REPOSITORY_REFERENCE_PATTERN);
    if (!match)
        return undefined;
    return { owner: match[1], repo: stripGitSuffix(match[2]), suffix: match[3] ?? "" };
}
export function parseRepo(input) {
    const trimmed = input.trim();
    const repoReference = matchGithubRepositoryReference(trimmed);
    if (repoReference) {
        return { owner: repoReference.owner, repo: repoReference.repo, url: normalizedRepoUrl(repoReference.owner, repoReference.repo) };
    }
    const slash = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (slash)
        return { owner: slash[1], repo: slash[2], url: normalizedRepoUrl(slash[1], slash[2]) };
    throw new Error("Repository must be owner/repo or a GitHub URL");
}
export function parsePr(repoOrUrl, prInput) {
    const trimmedPrInput = prInput.trim();
    const prUrlReference = matchGithubRepositoryReference(trimmedPrInput);
    const prUrlNumberMatch = prUrlReference?.suffix.match(/^\/pull\/(\d+)(?:[/?#]|$)/);
    if (prUrlReference && prUrlNumberMatch) {
        const owner = prUrlReference.owner;
        const repo = prUrlReference.repo;
        const prNumber = parsePrNumber(prUrlNumberMatch[1]);
        return { repository: { owner, repo, url: normalizedRepoUrl(owner, repo) }, prNumber, prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}` };
    }
    const repo = parseRepo(repoOrUrl);
    const numberMatch = trimmedPrInput.match(/^\d+$/);
    if (!numberMatch)
        throw new Error("PR must be a GitHub PR URL or an integer PR number");
    const prNumber = parsePrNumber(numberMatch[0]);
    return { repository: repo, prNumber, prUrl: `https://github.com/${repo.owner}/${repo.repo}/pull/${prNumber}` };
}
export function normalizedRepoUrl(owner, repo) {
    return `https://github.com/${owner}/${repo}`;
}
function stripGitSuffix(repo) {
    return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}
function parsePrNumber(value) {
    const prNumber = Number(value);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1)
        throw new Error("PR number must be a positive safe integer");
    return prNumber;
}
//# sourceMappingURL=gh.js.map