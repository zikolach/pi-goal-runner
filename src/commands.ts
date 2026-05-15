import type { GoalRecord } from "./types.js";
import type { GoalStore } from "./state/store.js";
import { answerDecision, listPendingDecisions } from "./decisions.js";
import { createGhExecutor, type GhExecutor } from "./github/gh.js";
import { createGithubPrGoal } from "./github/create.js";
import { schedulerTick } from "./scheduler.js";
import { redactText } from "./redaction.js";
import { splitArgs } from "./args.js";
import { withGoalLock } from "./state/lock.js";
import { getGoalDisplayMetadata } from "./adapters/registry.js";

export { splitArgs } from "./args.js";

export const GOAL_SUBCOMMANDS = ["help", "list", "status", "pause", "resume", "cancel", "decisions", "answer", "watch-pr", "tick"];

export async function handleGoalCommand(store: GoalStore, argsText: string, options: { gh?: GhExecutor; cwd?: string; dryRunWorker?: boolean } = {}): Promise<string> {
  return handleGoalCommandArgs(store, splitArgs(argsText), options);
}

export async function handleGoalCommandArgs(store: GoalStore, args: string[], options: { gh?: GhExecutor; cwd?: string; dryRunWorker?: boolean } = {}): Promise<string> {
  const cmd = args[0] ?? "help";
  if (cmd === "help") return goalHelp();
  if (cmd === "list") return formatGoalList(await store.list());
  if (cmd === "status") {
    const id = required(args[1], "goal id");
    return formatGoalStatus(await store.get(id));
  }
  if (cmd === "pause" || cmd === "resume" || cmd === "cancel") {
    const id = required(args[1], "goal id");
    const state = cmd === "pause" ? "paused" : cmd === "resume" ? "active" : "cancelled";
    const goal = await withGoalLock(store.paths, id, () => store.setState(id, state));
    if (!goal) return `${id}: goal is busy; try again later`;
    return `${goal.id}: ${goal.state}`;
  }
  if (cmd === "decisions") return formatDecisions(listPendingDecisions(await store.list()));
  if (cmd === "answer") {
    const decisionId = required(args[1], "decision id");
    const choice = required(args[2], "choice");
    const decision = await answerDecision(store, decisionId, choice);
    return `Answered ${decision.id} with ${choice}`;
  }
  if (cmd === "watch-pr") {
    const repo = required(args[1], "repo or url");
    const pr = required(args[2], "PR number or URL");
    const goal = await createGithubPrGoal(store, options.gh ?? createGhExecutor(), repo, pr, { cwd: options.cwd, ...parseWatchOptions(args.slice(3)) });
    return `Created ${goal.id}: ${goal.summary}`;
  }
  if (cmd === "tick") {
    const result = await schedulerTick(store, { gh: options.gh, worker: { dryRun: options.dryRunWorker } });
    return `Checked ${result.checked}, launched ${result.launched}, skipped ${result.skipped}, failures ${result.failures}\n${result.messages.join("\n")}`.trim();
  }
  throw new Error(`Unknown /goal subcommand: ${cmd}`);
}

export function goalHelp(): string {
  return `Goal runner commands:
/goal list
/goal status <goal-id>
/goal pause <goal-id>
/goal resume <goal-id>
/goal cancel <goal-id>
/goal decisions
/goal answer <decision-id> <choice>
/goal watch-pr <owner/repo|url> <pr-number|url> [--quiet-ms N] [--validation "npm test"] [--auto-resolve]
/goal tick`;
}

export function formatGoalList(goals: GoalRecord[]): string {
  if (!goals.length) return "No goals.";
  return goals.map((goal) => `${goal.id}\t${goal.state}\t${goal.type}\t${redactText(goal.summary, 120)}\tnext: ${goal.schedule.nextCheckAt}`).join("\n");
}

export function formatGoalStatus(goal: GoalRecord): string {
  const display = getGoalDisplayMetadata(goal);
  return `Goal ${goal.id}
Type: ${goal.type}
State: ${goal.state}
Summary: ${redactText(goal.summary, 200)}
Next check: ${goal.schedule.nextCheckAt}
Latest progress: ${redactText(goal.latestProgress ?? "none", 300)}
Last run: ${redactText(goal.lastRunSummary ?? goal.runHistory.at(-1)?.summary ?? "none", 300)}
Pending decisions: ${goal.pendingDecisions.filter((decision) => decision.status === "pending").length}
Worktree: ${display.workspace ?? "none"}`;
}

export function formatDecisions(decisions: ReturnType<typeof listPendingDecisions>): string {
  if (!decisions.length) return "No pending decisions.";
  return decisions.map((decision) => `${decision.id}\tgoal=${decision.goalId}\t${redactText(decision.prompt, 160)}\tchoices=${decision.options.map((option) => option.id).join("|")}`).join("\n");
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseWatchOptions(args: string[]): { quietWindowMs?: number; validationCommands?: string[]; autoReplyAndResolve?: boolean } {
  const output: { quietWindowMs?: number; validationCommands?: string[]; autoReplyAndResolve?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--quiet-ms") output.quietWindowMs = parseNonNegativeNumber(required(args[++i], "quiet ms"), "quiet ms");
    else if (arg === "--validation") output.validationCommands = [required(args[++i], "validation command")];
    else if (arg === "--auto-resolve") output.autoReplyAndResolve = true;
  }
  return output;
}

function parseNonNegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a finite non-negative number`);
  return parsed;
}
