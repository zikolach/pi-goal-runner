import { createGoalStore } from "./state/store.js";
import { GOAL_SUBCOMMANDS, handleGoalCommand } from "./commands.js";
import { schedulerTick } from "./scheduler.js";
import { parseDaemonInterval } from "./cli.js";

interface ExtensionAPI {
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void; getArgumentCompletions?(prefix: string): unknown[] | null | Promise<unknown[] | null> }): void;
  on?(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
}

interface ExtensionContext {
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "success" | "warning" | "error"): void;
    setStatus?(key: string, value: string | undefined): void;
    setWidget?(key: string, lines: string[] | undefined): void;
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
    .catch(onError)
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
      try {
        const output = await handleGoalCommand(store, args, { cwd: ctx.cwd });
        ctx.ui.notify(output, "info");
        await refreshWidget(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

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

  pi.on?.("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  async function refreshWidget(ctx: ExtensionContext): Promise<void> {
    const goals = await store.list();
    const active = goals.filter((goal) => !["completed", "cancelled", "dormant"].includes(goal.state)).length;
    const decisions = goals.reduce((count, goal) => count + goal.pendingDecisions.filter((decision) => decision.status === "pending").length, 0);
    ctx.ui.setStatus?.("goals", active ? `goals:${active}${decisions ? ` decisions:${decisions}` : ""}` : undefined);
    if (decisions) {
      ctx.ui.setWidget?.("goals", [`${decisions} goal decision(s) pending. Run /goal decisions.`]);
    } else {
      ctx.ui.setWidget?.("goals", undefined);
    }
  }
}
