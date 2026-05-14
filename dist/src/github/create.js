import { createGoalId } from "../state/store.js";
import { defaultSchedule } from "../policy.js";
import { ensureGhAuth, parsePr } from "./gh.js";
export async function createGithubPrGoal(store, gh, repoOrUrl, prNumberOrUrl, options = {}) {
    await ensureGhAuth(gh);
    const parsed = parsePr(repoOrUrl, prNumberOrUrl);
    const repoName = `${parsed.repository.owner}/${parsed.repository.repo}`;
    const prJson = await gh.run(["pr", "view", String(parsed.prNumber), "--repo", repoName, "--json", "url,headRefName,baseRefName,headRepositoryOwner"]);
    const pr = JSON.parse(prJson);
    const headRepositoryOwner = readOwnerLogin(pr.headRepositoryOwner);
    if (headRepositoryOwner && headRepositoryOwner.toLowerCase() !== parsed.repository.owner.toLowerCase()) {
        throw new Error(`Pull requests from forks are not currently supported: head repository owner ${headRepositoryOwner} differs from base repository owner ${parsed.repository.owner}`);
    }
    const schedule = defaultSchedule();
    if (options.quietWindowMs !== undefined)
        schedule.quietWindow.durationMs = options.quietWindowMs;
    if (options.initialBackoffMs !== undefined) {
        schedule.backoff.initialMs = options.initialBackoffMs;
        schedule.backoff.currentMs = options.initialBackoffMs;
    }
    if (options.maxBackoffMs !== undefined)
        schedule.backoff.maxMs = options.maxBackoffMs;
    const github = {
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
function readOwnerLogin(owner) {
    if (typeof owner === "string")
        return owner;
    if (owner && typeof owner === "object" && "login" in owner && typeof owner.login === "string")
        return owner.login;
    return undefined;
}
//# sourceMappingURL=create.js.map