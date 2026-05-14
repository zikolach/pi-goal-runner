import { createGoalId } from "../state/store.js";
import { defaultSchedule } from "../policy.js";
import { ensureGhAuth, parsePr } from "./gh.js";
export async function createGithubPrGoal(store, gh, repoOrUrl, prNumberOrUrl, options = {}) {
    const quietWindowMs = validateNonNegativeFiniteOption("quietWindowMs", options.quietWindowMs);
    const initialBackoffMs = validateNonNegativeFiniteOption("initialBackoffMs", options.initialBackoffMs);
    const maxBackoffMs = validateNonNegativeFiniteOption("maxBackoffMs", options.maxBackoffMs);
    const schedule = defaultSchedule();
    if (maxBackoffMs !== undefined && maxBackoffMs < (initialBackoffMs ?? schedule.backoff.initialMs)) {
        throw new Error("maxBackoffMs must be greater than or equal to initialBackoffMs");
    }
    if (initialBackoffMs !== undefined && (maxBackoffMs ?? schedule.backoff.maxMs) < initialBackoffMs) {
        throw new Error("maxBackoffMs must be greater than or equal to initialBackoffMs");
    }
    await ensureGhAuth(gh);
    const parsed = parsePr(repoOrUrl, prNumberOrUrl);
    const repoName = `${parsed.repository.owner}/${parsed.repository.repo}`;
    const prJson = await gh.run(["pr", "view", String(parsed.prNumber), "--repo", repoName, "--json", "url,headRefName,baseRefName,headRepositoryOwner"]);
    const pr = JSON.parse(prJson);
    const headRepositoryOwner = readOwnerLogin(pr.headRepositoryOwner);
    if (headRepositoryOwner && headRepositoryOwner.toLowerCase() !== parsed.repository.owner.toLowerCase()) {
        throw new Error(`Pull requests from forks are not currently supported: head repository owner ${headRepositoryOwner} differs from base repository owner ${parsed.repository.owner}`);
    }
    if (quietWindowMs !== undefined)
        schedule.quietWindow.durationMs = quietWindowMs;
    if (initialBackoffMs !== undefined) {
        schedule.backoff.initialMs = initialBackoffMs;
        schedule.backoff.currentMs = initialBackoffMs;
    }
    if (maxBackoffMs !== undefined)
        schedule.backoff.maxMs = maxBackoffMs;
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
function validateNonNegativeFiniteOption(name, value) {
    if (value === undefined)
        return undefined;
    if (!Number.isFinite(value) || value < 0)
        throw new Error(`${name} must be a finite non-negative number`);
    return value;
}
//# sourceMappingURL=create.js.map