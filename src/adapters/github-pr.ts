import type { ActionableObservation, CompleteEvent, GithubObservation, GoalRecord } from "../types.js";
import type { GoalStore } from "../state/store.js";
import { appendGoalEvent } from "../state/events.js";
import { appendRecentUnique, MAX_HANDLED_CHECK_NAMES } from "../github/handled.js";
import { findActionable, observeGithubPr } from "../github/observe.js";
import { replyAndResolveAddressedThreads } from "../github/update.js";
import { safeError } from "../redaction.js";
import { buildWorkerPrompt } from "../worker/prompt.js";
import { ensureGoalWorktree } from "../worker/worktree.js";
import type { GoalAdapter, GoalAdapterContext, GoalDisplayMetadata, PreparedWorkerInput } from "./types.js";

interface GithubCompletionContext {
  handledCheckNames?: string[];
}

export const githubPrAdapter: GoalAdapter<GithubObservation, ActionableObservation> = {
  type: "github_pr_review",
  async observe(goal, context) {
    if (!goal.github) throw new Error("GitHub PR goal config is required");
    return observeGithubPr(context.gh, goal.github, { now: context.now });
  },
  async analyze(goal, observation) {
    if (!goal.github) throw new Error("GitHub PR goal config is required");
    return findActionable(goal.github, observation);
  },
  async recordObservation(goal, observation, _actionability, context) {
    await context.store.update(
      goal.id,
      (current) => ({
        ...current,
        updatedAt: context.now.toISOString(),
        github: current.github ? { ...current.github, lastObservedAt: observation.observedAt, repository: { ...current.github.repository, branch: observation.headBranch ?? current.github.repository.branch } } : current.github,
      }),
      { updatedAt: context.now.toISOString() },
    );
  },
  async prepareWorker(goal, observation, actionability, context): Promise<PreparedWorkerInput> {
    const worktreeGoal = await ensureGoalWorktree(context.store, goal, { updatedAt: context.now.toISOString() });
    return {
      goal: worktreeGoal,
      prompt: buildWorkerPrompt(worktreeGoal, observation, actionability),
      completionContext: { handledCheckNames: actionability.checks.map((check) => check.name) } satisfies GithubCompletionContext,
    };
  },
  async handleSuccessfulCompletion(goal, event, context, completionContext) {
    await handleGithubPrSuccessfulCompletion(context.store, context.gh, goal, event, (completionContext as GithubCompletionContext | undefined)?.handledCheckNames ?? []);
  },
  display(goal) {
    return githubPrDisplay(goal);
  },
};

export async function handleGithubPrSuccessfulCompletion(store: GoalStore, gh: GoalAdapterContext["gh"], goal: GoalRecord, event: CompleteEvent, handledCheckNames: string[] = []): Promise<void> {
  if (!goal.github) return;
  if (handledCheckNames.length > 0) {
    await store.update(goal.id, (current) => ({
      ...current,
      github: current.github ? { ...current.github, handledCheckNames: appendRecentUnique(current.github.handledCheckNames, handledCheckNames, MAX_HANDLED_CHECK_NAMES) } : current.github,
    }), { updatedAt: event.timestamp });
  }
  if (!goal.github.autoReplyAndResolve) return;
  try {
    const resolvedThreadIds = await replyAndResolveAddressedThreads(gh, goal.github, event);
    if (resolvedThreadIds.length > 0) {
      await appendGoalEvent(store.paths, {
        type: "diagnostic",
        goalId: goal.id,
        runId: event.runId,
        timestamp: event.timestamp,
        message: `Auto-replied and resolved ${resolvedThreadIds.length} GitHub review thread(s)`,
      });
    }
  } catch (error) {
    await appendGoalEvent(store.paths, {
      type: "failure",
      goalId: goal.id,
      runId: event.runId,
      timestamp: event.timestamp,
      message: `Auto-reply/resolve failed: ${safeError(error)}`,
      retryable: true,
    });
  }
}

function githubPrDisplay(goal: GoalRecord): GoalDisplayMetadata {
  if (!goal.github) return {};
  const repo = `${goal.github.repository.owner}/${goal.github.repository.repo}`;
  return {
    target: `${repo}#${goal.github.prNumber}`,
    workspace: goal.github.repository.worktreePath,
    details: [
      { label: "Repository", value: repo },
      { label: "PR", value: String(goal.github.prNumber) },
      ...(goal.github.repository.branch ? [{ label: "Branch", value: goal.github.repository.branch }] : []),
    ],
  };
}
