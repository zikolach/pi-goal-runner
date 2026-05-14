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
    const threads = [];
    let cursor;
    do {
        const response = await gh.run([
            "api",
            "graphql",
            "-f",
            `owner=${config.repository.owner}`,
            "-f",
            `name=${config.repository.repo}`,
            "-F",
            `number=${config.prNumber}`,
            ...(cursor ? ["-f", `threadsCursor=${cursor}`] : []),
            "-f",
            "query=query($owner:String!, $name:String!, $number:Int!, $threadsCursor:String) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { reviewThreads(first:100, after:$threadsCursor) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated path line comments(first:100) { pageInfo { hasNextPage endCursor } nodes { id body author { login } url updatedAt } } } } } } }",
        ]);
        const page = extractReviewThreadsPage(response);
        threads.push(...page.nodes);
        cursor = page.pageInfo.hasNextPage && page.pageInfo.endCursor ? page.pageInfo.endCursor : undefined;
    } while (cursor);
    for (const thread of threads) {
        await fetchRemainingThreadComments(gh, thread);
    }
    return threads;
}
function extractReviewThreadsPage(response) {
    const parsed = JSON.parse(response);
    const reviewThreads = parsed.data?.repository?.pullRequest?.reviewThreads;
    return { pageInfo: reviewThreads?.pageInfo ?? {}, nodes: Array.isArray(reviewThreads?.nodes) ? reviewThreads.nodes : [] };
}
async function fetchRemainingThreadComments(gh, thread) {
    const comments = thread.comments;
    let cursor = comments?.pageInfo?.hasNextPage && comments.pageInfo.endCursor ? comments.pageInfo.endCursor : undefined;
    if (!cursor || typeof thread.id !== "string")
        return;
    const nodes = Array.isArray(comments?.nodes) ? [...comments.nodes] : [];
    while (cursor) {
        const response = await gh.run([
            "api",
            "graphql",
            "-f",
            `threadId=${thread.id}`,
            ...(cursor ? ["-f", `commentsCursor=${cursor}`] : []),
            "-f",
            "query=query($threadId:ID!, $commentsCursor:String) { node(id:$threadId) { ... on PullRequestReviewThread { comments(first:100, after:$commentsCursor) { pageInfo { hasNextPage endCursor } nodes { id body author { login } url updatedAt } } } } }",
        ]);
        const page = extractCommentsPage(response);
        nodes.push(...page.nodes);
        cursor = page.pageInfo.hasNextPage && page.pageInfo.endCursor ? page.pageInfo.endCursor : undefined;
    }
    thread.comments = { ...comments, pageInfo: { hasNextPage: false, endCursor: null }, nodes };
}
function extractCommentsPage(response) {
    const parsed = JSON.parse(response);
    const comments = parsed.data?.node?.comments;
    return { pageInfo: comments?.pageInfo ?? {}, nodes: Array.isArray(comments?.nodes) ? comments.nodes : [] };
}
export function findActionable(config, observation) {
    const lastHandled = config.lastHandledAt ? new Date(config.lastHandledAt).getTime() : 0;
    const threads = observation.reviewThreads.filter((thread) => {
        if (thread.resolved || thread.outdated)
            return false;
        const updated = latestThreadTime(thread);
        if (config.handledThreadIds.includes(thread.id) && updated && updated.getTime() <= lastHandled)
            return false;
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
    const timestamps = times.map((time) => new Date(time).getTime()).filter(Number.isFinite);
    if (!timestamps.length)
        return undefined;
    return new Date(Math.max(...timestamps));
}
//# sourceMappingURL=observe.js.map