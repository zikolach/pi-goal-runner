export async function replyAndResolveAddressedThreads(gh, config, event) {
    if (!config.autoReplyAndResolve)
        return [];
    if (!event.commitSha)
        throw new Error("Refusing to reply/resolve without pushed commit evidence");
    const threadIds = event.addressedThreadIds ?? [];
    const repo = `${config.repository.owner}/${config.repository.repo}`;
    const resolved = [];
    for (const threadId of threadIds) {
        const body = `Addressed in ${event.commitSha}. Validation: ${formatValidation(event)}.`;
        await gh.run(["api", "graphql", "-f", `query=mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}`,
            "-F", `thread=${threadId}`, "-F", `body=${body}`]);
        await gh.run(["api", "graphql", "-f", `query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}`,
            "-F", `thread=${threadId}`]);
        resolved.push(threadId);
    }
    if (resolved.length)
        await gh.run(["pr", "view", String(config.prNumber), "--repo", repo, "--json", "number"]);
    return resolved;
}
function formatValidation(event) {
    const validations = event.validationResults ?? [];
    if (!validations.length)
        return "not reported";
    return validations.map((result) => `${result.command}: ${result.status}`).join(", ");
}
//# sourceMappingURL=update.js.map