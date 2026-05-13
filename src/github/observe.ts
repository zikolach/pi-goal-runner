import type { ActionableObservation, CheckObservation, GithubObservation, GithubPrGoalConfig, ReviewThreadObservation } from "../types.js";
import { redactText } from "../redaction.js";
import type { GhExecutor } from "./gh.js";

export async function observeGithubPr(gh: GhExecutor, config: GithubPrGoalConfig): Promise<GithubObservation> {
  const repo = `${config.repository.owner}/${config.repository.repo}`;
  const prJson = await gh.run([
    "pr",
    "view",
    String(config.prNumber),
    "--repo",
    repo,
    "--json",
    "url,headRefName,headRefOid,reviewThreads,statusCheckRollup",
  ]);
  const pr = JSON.parse(prJson) as Record<string, unknown>;
  return {
    observedAt: new Date().toISOString(),
    prUrl: typeof pr.url === "string" ? pr.url : config.prUrl,
    headBranch: typeof pr.headRefName === "string" ? pr.headRefName : config.repository.branch,
    headSha: typeof pr.headRefOid === "string" ? pr.headRefOid : undefined,
    reviewThreads: parseReviewThreads(pr.reviewThreads),
    checks: parseChecks(pr.statusCheckRollup),
  };
}

export function findActionable(config: GithubPrGoalConfig, observation: GithubObservation): ActionableObservation {
  const lastHandled = config.lastHandledAt ? new Date(config.lastHandledAt).getTime() : 0;
  const threads = observation.reviewThreads.filter((thread) => {
    if (thread.resolved || thread.outdated) return false;
    if (config.handledThreadIds.includes(thread.id)) return false;
    const updated = latestThreadTime(thread);
    return !updated || updated.getTime() > lastHandled;
  });
  const checks = observation.checks.filter((check) => {
    if (check.status !== "failing") return false;
    if (config.handledCheckNames.includes(check.name) && (!check.completedAt || new Date(check.completedAt).getTime() <= lastHandled)) return false;
    return true;
  });
  const reasons = [];
  if (threads.length) reasons.push(`${threads.length} unresolved review thread(s)`);
  if (checks.length) reasons.push(`${checks.length} failing check(s)`);
  return { actionable: threads.length > 0 || checks.length > 0, observedAt: observation.observedAt, threads, checks, reason: reasons.join("; ") || "No actionable PR feedback" };
}

function parseReviewThreads(raw: unknown): ReviewThreadObservation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((thread: unknown): ReviewThreadObservation => {
    const item = thread as Record<string, unknown>;
    const commentsRaw = Array.isArray(item.comments) ? item.comments : [];
    return {
      id: String(item.id ?? "unknown"),
      path: typeof item.path === "string" ? item.path : undefined,
      line: typeof item.line === "number" ? item.line : undefined,
      outdated: Boolean(item.isOutdated ?? item.outdated),
      resolved: Boolean(item.isResolved ?? item.resolved),
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
      comments: commentsRaw.map((comment: unknown) => {
        const c = comment as Record<string, unknown>;
        return {
          id: String(c.id ?? "unknown"),
          body: redactText(c.body ?? "", 2_000),
          author: typeof (c.author as Record<string, unknown> | undefined)?.login === "string" ? String((c.author as Record<string, unknown>).login) : undefined,
          url: typeof c.url === "string" ? c.url : undefined,
          updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : undefined,
        };
      }),
    };
  });
}

function parseChecks(raw: unknown): CheckObservation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((check: unknown): CheckObservation => {
    const item = check as Record<string, unknown>;
    const conclusion = String(item.conclusion ?? item.state ?? item.status ?? "").toUpperCase();
    const status: CheckObservation["status"] = conclusion === "SUCCESS" || conclusion === "PASSED" ? "passing" : conclusion === "FAILURE" || conclusion === "ERROR" || conclusion === "CANCELLED" || conclusion === "FAILED" ? "failing" : conclusion === "PENDING" || conclusion === "IN_PROGRESS" || conclusion === "QUEUED" ? "pending" : "unknown";
    return {
      name: String(item.name ?? item.context ?? item.workflowName ?? "unknown-check"),
      status,
      url: typeof item.detailsUrl === "string" ? item.detailsUrl : typeof item.url === "string" ? item.url : undefined,
      summary: redactText(item.description ?? item.summary ?? "", 1_000),
      completedAt: typeof item.completedAt === "string" ? item.completedAt : undefined,
    };
  });
}

function latestThreadTime(thread: ReviewThreadObservation): Date | undefined {
  const times = [thread.updatedAt, ...thread.comments.map((comment) => comment.updatedAt)].filter(Boolean) as string[];
  if (!times.length) return undefined;
  return new Date(Math.max(...times.map((time) => new Date(time).getTime())));
}
