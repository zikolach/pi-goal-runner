import type { GoalRecord, GithubPrGoalConfig } from "../types.js";
import { createGoalId, type GoalStore } from "../state/store.js";
import { defaultSchedule } from "../policy.js";
import type { GhExecutor } from "./gh.js";
import { ensureGhAuth, parsePr } from "./gh.js";

export interface WatchPrOptions {
  quietWindowMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  validationCommands?: string[];
  autoReplyAndResolve?: boolean;
  cwd?: string;
}

export async function createGithubPrGoal(store: GoalStore, gh: GhExecutor, repoOrUrl: string, prNumberOrUrl: string, options: WatchPrOptions = {}): Promise<GoalRecord> {
  await ensureGhAuth(gh);
  const parsed = parsePr(repoOrUrl, prNumberOrUrl);
  const repoName = `${parsed.repository.owner}/${parsed.repository.repo}`;
  const prJson = await gh.run(["pr", "view", String(parsed.prNumber), "--repo", repoName, "--json", "url,headRefName,baseRefName,headRepositoryOwner"]);
  const pr = JSON.parse(prJson) as Record<string, unknown>;
  const schedule = defaultSchedule();
  if (options.quietWindowMs) schedule.quietWindow.durationMs = options.quietWindowMs;
  if (options.initialBackoffMs) {
    schedule.backoff.initialMs = options.initialBackoffMs;
    schedule.backoff.currentMs = options.initialBackoffMs;
  }
  if (options.maxBackoffMs) schedule.backoff.maxMs = options.maxBackoffMs;
  const github: GithubPrGoalConfig = {
    repository: {
      ...parsed.repository,
      branch: typeof pr.headRefName === "string" ? pr.headRefName : undefined,
      baseBranch: typeof pr.baseRefName === "string" ? pr.baseRefName : undefined,
    },
    prNumber: parsed.prNumber,
    prUrl: typeof pr.url === "string" ? pr.url : parsed.prUrl,
    validationCommands: options.validationCommands ?? ["npm test"],
    autoReplyAndResolve: options.autoReplyAndResolve ?? false,
    handledThreadIds: [],
    handledCheckNames: [],
  };
  return store.create({
    id: createGoalId("pr"),
    type: "github_pr_review",
    state: "active",
    summary: `Watch PR ${repoName}#${parsed.prNumber}`,
    cwd: options.cwd,
    schedule,
    github,
  });
}
