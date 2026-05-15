import { createGoalStore } from "./state/store.js";
import { GOAL_SUBCOMMANDS, handleGoalCommand } from "./commands.js";
import { runGoalNow, schedulerTick } from "./scheduler.js";
import { parseDaemonInterval } from "./cli.js";
import { isTerminal } from "./policy.js";
import { cancelGoal, pauseGoal, resumeGoal } from "./goal-operations.js";
import { GoalManagerDialog } from "./goal-management-ui.js";
import type { GoalRecord } from "./types.js";

interface ExtensionAPI {
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void; getArgumentCompletions?(prefix: string): unknown[] | null | Promise<unknown[] | null> }): void;
  on?(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
}

type GoalManagerWidget = {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
};

interface ExtensionContext {
  cwd: string;
  hasUI?: boolean;
  ui: {
    notify(message: string, type?: "info" | "success" | "warning" | "error"): void;
    setStatus?(key: string, value: string | undefined): void;
    setWidget?(key: string, lines: string[] | undefined): void;
    custom?: (factory: (
      tui: {
        requestRender(): void;
      },
      theme: unknown,
      _keybindings: unknown,
      done: (result: unknown) => void,
    ) => GoalManagerWidget | Promise<GoalManagerWidget>) => unknown | Promise<unknown>;
    options?: {
      overlay?: boolean;
      overlayOptions?: unknown;
      onHandle?: (handle: unknown) => void;
    },
  };
}

interface ExtensionCommandContext extends ExtensionContext {}

export interface SerializedTickState {
  inFlight: boolean;
}

export function runSerializedSchedulerTick(state: SerializedTickState, tick: () => Promise<void>, onError: (error: unknown) => void): boolean {
  if (state.inFlight) return false;
  state.inFlight = true;
  void Promise.resolve()
    .then(tick)
    .catch((error) => {
      try {
        onError(error);
      } catch {
        // Error reporting is best-effort for this fire-and-forget scheduler path.
      }
    })
    .finally(() => {
      state.inFlight = false;
    });
  return true;
}

export function splitCompletionPrefix(prefix: string): string[] {
  const trimmed = prefix.trimStart();
  const parts = trimmed.split(/\s+/);
  if (trimmed.length > 0 && /\s$/.test(prefix) && parts.at(-1) !== "") return [...parts, ""];
  return parts;
}

export function shouldSuggestDaemon(goals: GoalRecord[]): boolean {
  return goals.some(isDaemonEligibleGoal);
}

export function buildDaemonSuggestionMessage(daemonEligibleCount: number): string {
  return `Goal runner extension stops when the session exits (${daemonEligibleCount} goal${daemonEligibleCount === 1 ? "" : "s"} eligible for daemon checks). Run \`npm run goal -- daemon\` from the pi-goal-runner checkout to keep checking in background.`;
}

function isDaemonEligibleGoal(goal: GoalRecord): boolean {
  return !isTerminal(goal.state)
    && goal.state !== "paused"
    && goal.state !== "needs_decision"
    && !goal.pendingDecisions.some((decision) => decision.status === "pending" && decision.required);
}

export default function goalRunnerExtension(pi: ExtensionAPI): void {
  const store = createGoalStore();
  let timer: NodeJS.Timeout | undefined;
  const tickState = { inFlight: false };

  pi.registerCommand("goal", {
    description: "Manage durable automation goals",
    getArgumentCompletions: async (prefix: string) => {
      const parts = splitCompletionPrefix(prefix);
      if (parts.length <= 1) return GOAL_SUBCOMMANDS.filter((item) => item.startsWith(parts[0] ?? "")).map((value) => ({ value, label: value }));
      const sub = parts[0];
      if (["status", "pause", "resume", "cancel"].includes(sub)) {
        const goals = await store.list();
        const current = parts.at(-1) ?? "";
        return goals.filter((goal) => goal.id.startsWith(current)).map((goal) => ({ value: goal.id, label: `${goal.id} ${goal.state}` }));
      }
      if (sub === "answer") {
        const current = parts.at(-1) ?? "";
        const goals = await store.list();
        return goals.flatMap((goal) => goal.pendingDecisions.filter((decision) => decision.status === "pending" && decision.id.startsWith(current)).map((decision) => ({ value: decision.id, label: decision.prompt.slice(0, 60) })));
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = splitCompletionPrefix(args)[0] ?? "";
      try {
        if (command === "ui") {
          await showGoalManager(store, ctx);
          await refreshWidget(ctx);
          return;
        }
        const output = await handleGoalCommand(store, args, { cwd: ctx.cwd });
        ctx.ui.notify(output, "info");
        await refreshWidget(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("goals", {
    description: "Open goal manager",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      try {
        await showGoalManager(store, ctx);
        await refreshWidget(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  async function showGoalManager(currentStore: ReturnType<typeof createGoalStore>, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
      ctx.ui.notify("Interactive goal management requires an interactive Pi session.", "warning");
      return;
    }

    const initialGoals = await currentStore.list();
    await ctx.ui.custom((tui, _theme, _kb, done) => {
      const component = new GoalManagerDialog(
        initialGoals,
        {
          loadGoals: async () => currentStore.list(),
          loadGoal: async (goalId: string) => {
            try {
              return await currentStore.get(goalId);
            } catch {
              return undefined;
            }
          },
          pauseGoal: async (goalId: string) => {
            const result = await pauseGoal(currentStore, goalId);
            return { ok: result.ok, reason: result.reason };
          },
          resumeGoal: async (goalId: string) => {
            const result = await resumeGoal(currentStore, goalId);
            return { ok: result.ok, reason: result.reason };
          },
          cancelGoal: async (goalId: string) => {
            const result = await cancelGoal(currentStore, goalId);
            return { ok: result.ok, reason: result.reason };
          },
          runGoalNow: async (goalId: string) => {
            const result = await runGoalNow(currentStore, goalId, { worker: { dryRun: process.env.PI_GOAL_RUNNER_DRY_RUN === "1" } });
            if (result.failures > 0) return { ok: false, reason: result.messages.at(-1) };
            if (result.skipped > 0) return { ok: false, reason: result.messages.at(-1) };
            return { ok: true };
          },
          notify: (message: string, type?: "info" | "warning" | "error") => {
            ctx.ui.notify(message, type);
          },
        },
        () => tui.requestRender(),
        (result?: unknown) => {
          done(result);
        },
      );
      return component;
    });
  }

  pi.on?.("session_start", async (_event, ctx) => {
    await store.init();
    await refreshWidget(ctx);
    let intervalMs: number;
    try {
      intervalMs = parseDaemonInterval(process.env.PI_GOAL_RUNNER_INTERVAL_MS);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    if (intervalMs > 0) {
      timer = setInterval(() => {
        runSerializedSchedulerTick(
          tickState,
          async () => {
            await schedulerTick(store, { worker: { dryRun: process.env.PI_GOAL_RUNNER_DRY_RUN === "1" } });
            await refreshWidget(ctx);
          },
          (error) => ctx.ui.notify(`Goal runner tick failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
        );
      }, intervalMs);
      timer.unref();
    }
  });

  pi.on?.("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    try {
      const goals = await store.list();
      const daemonEligibleGoals = goals.filter(isDaemonEligibleGoal);
      if (daemonEligibleGoals.length > 0) {
        const message = buildDaemonSuggestionMessage(daemonEligibleGoals.length);
        try {
          ctx.ui.notify(message, "info");
        } catch {
          // ignore
        }
        // session shutdown can tear down UI before notifications render;
        // write to stderr as a reliable fallback.
        process.stderr.write(`${message}\n`);
      }
    } catch {
      // Best effort only; session is shutting down.
    }
  });

  async function refreshWidget(ctx: ExtensionContext): Promise<void> {
    const goals = await store.list();
    const active = goals.filter((goal) => !isTerminal(goal.state)).length;
    const decisions = goals.reduce((count, goal) => count + goal.pendingDecisions.filter((decision) => decision.status === "pending").length, 0);
    ctx.ui.setStatus?.("goals", active ? `goals:${active}${decisions ? ` decisions:${decisions}` : ""}` : undefined);
    if (decisions) {
      ctx.ui.setWidget?.("goals", [`${decisions} goal decision(s) pending. Run /goal decisions.`]);
    } else {
      ctx.ui.setWidget?.("goals", undefined);
    }
  }
}
