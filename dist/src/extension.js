import { createGoalStore } from "./state/store.js";
import { GOAL_SUBCOMMANDS, handleGoalCommand } from "./commands.js";
import { schedulerTick } from "./scheduler.js";
import { parseDaemonInterval } from "./cli.js";
export function runSerializedSchedulerTick(state, tick, onError) {
    if (state.inFlight)
        return false;
    state.inFlight = true;
    void Promise.resolve()
        .then(tick)
        .catch((error) => {
        try {
            onError(error);
        }
        catch {
            // Error reporting is best-effort for this fire-and-forget scheduler path.
        }
    })
        .finally(() => {
        state.inFlight = false;
    });
    return true;
}
export function splitCompletionPrefix(prefix) {
    const trimmed = prefix.trimStart();
    const parts = trimmed.split(/\s+/);
    if (trimmed.length > 0 && /\s$/.test(prefix) && parts.at(-1) !== "")
        return [...parts, ""];
    return parts;
}
const TERMINAL_GOAL_STATES = new Set(["completed", "cancelled", "dormant"]);
export function shouldSuggestDaemon(goals) {
    return goals.some((goal) => !TERMINAL_GOAL_STATES.has(goal.state) && goal.state !== "paused");
}
export function buildDaemonSuggestionMessage(activeCount) {
    return `Goal runner extension stops when the session exits (${activeCount} active goal${activeCount === 1 ? "" : "s"}). Run \`pi-goal-runner daemon\` to keep checking in background.`;
}
export default function goalRunnerExtension(pi) {
    const store = createGoalStore();
    let timer;
    const tickState = { inFlight: false };
    pi.registerCommand("goal", {
        description: "Manage durable automation goals",
        getArgumentCompletions: async (prefix) => {
            const parts = splitCompletionPrefix(prefix);
            if (parts.length <= 1)
                return GOAL_SUBCOMMANDS.filter((item) => item.startsWith(parts[0] ?? "")).map((value) => ({ value, label: value }));
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
        handler: async (args, ctx) => {
            try {
                const output = await handleGoalCommand(store, args, { cwd: ctx.cwd });
                ctx.ui.notify(output, "info");
                await refreshWidget(ctx);
            }
            catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            }
        },
    });
    pi.on?.("session_start", async (_event, ctx) => {
        await store.init();
        await refreshWidget(ctx);
        let intervalMs;
        try {
            intervalMs = parseDaemonInterval(process.env.PI_GOAL_RUNNER_INTERVAL_MS);
        }
        catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
        }
        if (intervalMs > 0) {
            timer = setInterval(() => {
                runSerializedSchedulerTick(tickState, async () => {
                    await schedulerTick(store, { worker: { dryRun: process.env.PI_GOAL_RUNNER_DRY_RUN === "1" } });
                    await refreshWidget(ctx);
                }, (error) => ctx.ui.notify(`Goal runner tick failed: ${error instanceof Error ? error.message : String(error)}`, "error"));
            }, intervalMs);
            timer.unref();
        }
    });
    pi.on?.("session_shutdown", async (_event, ctx) => {
        if (timer)
            clearInterval(timer);
        timer = undefined;
        try {
            const goals = await store.list();
            const active = goals.filter((goal) => !TERMINAL_GOAL_STATES.has(goal.state) && goal.state !== "paused");
            if (active.length > 0)
                ctx.ui.notify(buildDaemonSuggestionMessage(active.length), "info");
        }
        catch {
            // Best effort only; session is shutting down.
        }
    });
    async function refreshWidget(ctx) {
        const goals = await store.list();
        const active = goals.filter((goal) => !["completed", "cancelled", "dormant"].includes(goal.state)).length;
        const decisions = goals.reduce((count, goal) => count + goal.pendingDecisions.filter((decision) => decision.status === "pending").length, 0);
        ctx.ui.setStatus?.("goals", active ? `goals:${active}${decisions ? ` decisions:${decisions}` : ""}` : undefined);
        if (!active) {
            ctx.ui.setWidget?.("goals", undefined);
            return;
        }
        const lines = [];
        if (decisions)
            lines.push(`${decisions} goal decision(s) pending. Run /goal decisions.`);
        lines.push("Tip: run `pi-goal-runner daemon` before exiting Pi to keep goal checks running in background.");
        ctx.ui.setWidget?.("goals", lines);
    }
}
//# sourceMappingURL=extension.js.map