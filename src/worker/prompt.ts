import type { ActionableObservation, GoalRecord, GithubObservation } from "../types.js";
import { redactText } from "../redaction.js";

export function buildWorkerPrompt(goal: GoalRecord, observation: GithubObservation, actionable: ActionableObservation): string {
  if (!goal.github) throw new Error("Worker prompt requires GitHub PR goal config");
  const repo = `${goal.github.repository.owner}/${goal.github.repository.repo}`;
  const previous = goal.runHistory.at(-1)?.summary ?? goal.lastRunSummary ?? "No previous run.";
  const validationCommands = redactText(goal.github.validationCommands.join(", "), 2_000) || "none configured";
  const branch = goal.github.repository.pushBranch ?? goal.github.repository.branch ?? observation.headBranch ?? "unknown";
  const pushRemote = goal.github.repository.pushRemote ?? "origin";
  const worktreeMode = goal.github.repository.worktreeMode ?? "isolated";
  const checkoutDescription = worktreeMode === "same_path" ? "user checkout (explicit same-path mode)" : "isolated detached worktree";
  const observedHeadSha = goal.github.repository.worktreeHeadSha ?? observation.headSha ?? "unknown";
  const pushTarget = branch === "unknown" ? "unknown; ask for guidance before pushing" : `${pushRemote} HEAD:${branch}`;
  const pushInstruction = branch === "unknown"
    ? "If the push target is unknown, emit a decision instead of guessing."
    : worktreeMode === "same_path"
      ? `This goal is using explicit same-path mode. Confirm your local checkout state is intended, then push to the PR branch with \`git push ${pushRemote} HEAD:${branch}\` (or \`git push ${pushRemote} ${branch}\` when that branch is checked out), without force by default.`
      : `If this is an isolated detached worktree, push the successful commit with \`git push ${pushRemote} HEAD:${branch}\` without force by default; do not rely on a local branch being checked out.`;
  return `You are a Pi worker subprocess for a durable GitHub PR review goal.

Goal:
- Goal id: ${goal.id}
- Repository: ${repo}
- PR: #${goal.github.prNumber} ${goal.github.prUrl ?? ""}
- PR branch / push branch: ${branch}
- Worker checkout: ${checkoutDescription}
- Worktree: ${goal.github.repository.worktreePath ?? "not assigned"}
- Checked-out worktree HEAD: ${observedHeadSha}
- Push remote: ${pushRemote}
- Push destination: ${pushTarget}
- Quiet window: ${goal.schedule.quietWindow.durationMs}ms
- Validation commands: ${validationCommands}

Fresh observation (${observation.observedAt}):
${redactText(JSON.stringify({ headSha: observation.headSha, actionable }, null, 2), 8_000)}

Previous safe run summary:
${redactText(previous, 2_000)}

Required review-fix loop:
1. Re-check the PR and current worktree before editing.
2. Verify each review comment/check failure against current code; do not blindly apply stale comments.
3. Make only scoped fixes for comments/checks that are still true and within goal scope.
4. If broad redesign, risky behavior, credentials, or user preference is needed, emit one JSONL decision event and stop instead of guessing.
5. Run configured validation.
6. Commit with a concise Conventional Commits subject when fixes are successful.
7. ${pushInstruction}
8. Emit newline-delimited JSON events only for supervisor communication, including progress and final complete/failure. A successful complete event must report the pushed commit SHA in \`commitSha\` so auto-reply/resolve can use it as evidence.

Event protocol examples:
{"type":"progress","message":"Verified thread X against current code"}
{"type":"decision","decision":{"id":"${goal.id}-decision-1","prompt":"Choose approach","options":[{"id":"a","label":"Option A"}],"required":true}}
{"type":"complete","status":"success","summary":"Fixed review comments","commitSha":"<pushed-sha>","validationResults":[{"command":"npm test","status":"passed"}],"addressedThreadIds":["<thread-id>"]}
{"type":"failure","message":"Safe error summary","retryable":true}
`;
}
