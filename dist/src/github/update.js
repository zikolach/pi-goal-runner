export async function replyAndResolveAddressedThreads(gh, config, event) {
    if (!config.autoReplyAndResolve)
        return [];
    if (!event.commitSha || !isGitSha(event.commitSha))
        throw new Error("Refusing to reply/resolve without valid pushed commit evidence");
    const threadIds = event.addressedThreadIds ?? [];
    const repo = `${config.repository.owner}/${config.repository.repo}`;
    const resolved = [];
    let attempted = 0;
    let failures = 0;
    for (const threadId of threadIds) {
        if (!isResolvableThreadId(threadId))
            continue;
        attempted++;
        const body = `Addressed in ${event.commitSha}. Validation: ${formatValidation(event)}.`;
        try {
            await gh.run(["api", "graphql", "-f", `query=mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}`,
                "-f", `thread=${threadId}`, "-f", `body=${body}`]);
            await gh.run(["api", "graphql", "-f", `query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}`,
                "-f", `thread=${threadId}`]);
            resolved.push(threadId);
        }
        catch {
            failures++;
            // Continue so one invalid/stale thread id does not block other resolutions.
        }
    }
    if (attempted > 0 && failures > 0 && resolved.length === 0)
        throw new Error("Failed to reply/resolve addressed GitHub review threads");
    if (resolved.length)
        await gh.run(["pr", "view", String(config.prNumber), "--repo", repo, "--json", "number"]);
    return resolved;
}
function isResolvableThreadId(value) {
    return value.trim().length > 0 && value.length <= 500 && !value.includes("[REDACTED]") && !/[\r\n\0]/.test(value);
}
function isGitSha(value) {
    return /^[0-9a-f]{7,40}$/i.test(value);
}
function formatValidation(event) {
    const validations = event.validationResults ?? [];
    if (!validations.length)
        return "not reported";
    return validations.map((result) => `${result.command}: ${result.status}`).join(", ");
}
//# sourceMappingURL=update.js.map