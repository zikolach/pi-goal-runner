import { redactText } from "../redaction.js";
export async function observeGithubPr(gh, config) {
    const repo = `${config.repository.owner}/${config.repository.repo}`;
    const prJson = await gh.run([
        "pr",
        "view",
        String(config.prNumber),
        "--repo",
        repo,
        "--json",
        "url,headRefName,headRefOid,statusCheckRollup",
    ]);
    const pr = JSON.parse(prJson);
    const threads = await fetchReviewThreads(gh, config);
    return {
        observedAt: new Date().toISOString(),
        prUrl: typeof pr.url === "string" ? pr.url : config.prUrl,
        headBranch: typeof pr.headRefName === "string" ? pr.headRefName : config.repository.branch,
        headSha: typeof pr.headRefOid === "string" ? pr.headRefOid : undefined,
        reviewThreads: parseReviewThreads(threads),
        checks: parseChecks(pr.statusCheckRollup),
    };
}
async function fetchReviewThreads(gh, config) {
    const response = await gh.run([
        "api",
        "graphql",
        "-f",
        `owner=${config.repository.owner}`,
        "-f",
        `name=${config.repository.repo}`,
        "-F",
        `number=${config.prNumber}`,
        "-f",
        "query=query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { id isResolved isOutdated path line comments(first:20) { nodes { id body author { login } url updatedAt } } } } } } }",
    ]);
    const parsed = JSON.parse(response);
    return parsed.data?.repository?.pullRequest?.reviewThreads;
}
export function findActionable(config, observation) {
    const lastHandled = config.lastHandledAt ? new Date(config.lastHandledAt).getTime() : 0;
    const threads = observation.reviewThreads.filter((thread) => {
        if (thread.resolved || thread.outdated)
            return false;
        if (config.handledThreadIds.includes(thread.id))
            return false;
        const updated = latestThreadTime(thread);
        return !updated || updated.getTime() > lastHandled;
    });
    const checks = observation.checks.filter((check) => {
        if (check.status !== "failing")
            return false;
        if (config.handledCheckNames.includes(check.name) && (!check.completedAt || new Date(check.completedAt).getTime() <= lastHandled))
            return false;
        return true;
    });
    const reasons = [];
    if (threads.length)
        reasons.push(`${threads.length} unresolved review thread(s)`);
    if (checks.length)
        reasons.push(`${checks.length} failing check(s)`);
    return { actionable: threads.length > 0 || checks.length > 0, observedAt: observation.observedAt, threads, checks, reason: reasons.join("; ") || "No actionable PR feedback" };
}
function parseReviewThreads(raw) {
    const threads = Array.isArray(raw) ? raw : Array.isArray(raw?.nodes) ? raw.nodes : [];
    return threads.map((thread) => {
        const item = thread;
        const commentsSource = item.comments;
        const commentsRaw = Array.isArray(commentsSource) ? commentsSource : Array.isArray(commentsSource?.nodes) ? commentsSource.nodes : [];
        return {
            id: String(item.id ?? "unknown"),
            path: typeof item.path === "string" ? item.path : undefined,
            line: typeof item.line === "number" ? item.line : undefined,
            outdated: Boolean(item.isOutdated ?? item.outdated),
            resolved: Boolean(item.isResolved ?? item.resolved),
            updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
            comments: commentsRaw.map((comment) => {
                const c = comment;
                return {
                    id: String(c.id ?? "unknown"),
                    body: redactText(c.body ?? "", 2_000),
                    author: typeof c.author?.login === "string" ? String(c.author.login) : undefined,
                    url: typeof c.url === "string" ? c.url : undefined,
                    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : undefined,
                };
            }),
        };
    });
}
function parseChecks(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map((check) => {
        const item = check;
        const conclusion = String(item.conclusion ?? item.state ?? item.status ?? "").toUpperCase();
        const status = conclusion === "SUCCESS" || conclusion === "PASSED" ? "passing" : conclusion === "FAILURE" || conclusion === "ERROR" || conclusion === "CANCELLED" || conclusion === "FAILED" ? "failing" : conclusion === "PENDING" || conclusion === "IN_PROGRESS" || conclusion === "QUEUED" ? "pending" : "unknown";
        return {
            name: String(item.name ?? item.context ?? item.workflowName ?? "unknown-check"),
            status,
            url: typeof item.detailsUrl === "string" ? item.detailsUrl : typeof item.url === "string" ? item.url : undefined,
            summary: redactText(item.description ?? item.summary ?? "", 1_000),
            completedAt: typeof item.completedAt === "string" ? item.completedAt : undefined,
        };
    });
}
function latestThreadTime(thread) {
    const times = [thread.updatedAt, ...thread.comments.map((comment) => comment.updatedAt)].filter(Boolean);
    if (!times.length)
        return undefined;
    return new Date(Math.max(...times.map((time) => new Date(time).getTime())));
}
//# sourceMappingURL=observe.js.map