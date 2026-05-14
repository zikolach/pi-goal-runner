import type { CompleteEvent, GithubPrGoalConfig } from "../types.js";
import type { GhExecutor } from "./gh.js";

export async function replyAndResolveAddressedThreads(gh: GhExecutor, config: GithubPrGoalConfig, event: CompleteEvent): Promise<string[]> {
  if (!config.autoReplyAndResolve) return [];
  if (!event.commitSha || !isGitSha(event.commitSha)) throw new Error("Refusing to reply/resolve without valid pushed commit evidence");
  const threadIds = event.addressedThreadIds ?? [];
  const repo = `${config.repository.owner}/${config.repository.repo}`;
  const resolved: string[] = [];
  for (const threadId of threadIds) {
    const body = `Addressed in ${event.commitSha}. Validation: ${formatValidation(event)}.`;
    await gh.run(["api", "graphql", "-f", `query=mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}`,
      "-f", `thread=${threadId}`, "-f", `body=${body}`]);
    await gh.run(["api", "graphql", "-f", `query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}`,
      "-f", `thread=${threadId}`]);
    resolved.push(threadId);
  }
  if (resolved.length) await gh.run(["pr", "view", String(config.prNumber), "--repo", repo, "--json", "number"]);
  return resolved;
}

function isGitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

function formatValidation(event: CompleteEvent): string {
  const validations = event.validationResults ?? [];
  if (!validations.length) return "not reported";
  return validations.map((result) => `${result.command}: ${result.status}`).join(", ");
}
