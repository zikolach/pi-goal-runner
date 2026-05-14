import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactText } from "../redaction.js";

const execFileAsync = promisify(execFile);

export interface GhExecutor {
  run(args: string[], options?: { cwd?: string }): Promise<string>;
}

export function createGhExecutor(): GhExecutor {
  return {
    async run(args, options) {
      try {
        const { stdout } = await execFileAsync("gh", args, { cwd: options?.cwd, maxBuffer: 20 * 1024 * 1024 });
        return stdout;
      } catch (error) {
        const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
        throw new Error(redactText(err.stderr || err.stdout || err.message));
      }
    },
  };
}

export async function ensureGhAuth(gh: GhExecutor): Promise<void> {
  await gh.run(["auth", "status"]);
}

export function parseRepo(input: string): { owner: string; repo: string; url?: string } {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/github\.com[:/]([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/);
  if (urlMatch) {
    const repo = stripGitSuffix(urlMatch[2]);
    return { owner: urlMatch[1], repo, url: normalizedRepoUrl(urlMatch[1], repo) };
  }
  const slash = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slash) return { owner: slash[1], repo: slash[2], url: normalizedRepoUrl(slash[1], slash[2]) };
  throw new Error("Repository must be owner/repo or a GitHub URL");
}

export function parsePr(repoOrUrl: string, prInput: string): { repository: { owner: string; repo: string; url?: string }; prNumber: number; prUrl?: string } {
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
  if (!numberMatch) throw new Error("PR must be a GitHub PR URL or an integer PR number");
  const prNumber = Number(numberMatch[0]);
  return { repository: repo, prNumber, prUrl: `https://github.com/${repo.owner}/${repo.repo}/pull/${prNumber}` };
}

export function normalizedRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}
