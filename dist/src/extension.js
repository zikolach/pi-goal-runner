import { createGoalStore } from "./state/store.js";
import { GOAL_SUBCOMMANDS, handleGoalCommand } from "./commands.js";
import { schedulerTick } from "./scheduler.js";
export default function goalRunnerExtension(pi) {
    const store = createGoalStore();
    let timer;
    pi.registerCommand("goal", {
        description: "Manage durable automation goals",
        getArgumentCompletions: async (prefix) => {
            const parts = prefix.trimStart().split(/\s+/);
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
        const intervalMs = Number(process.env.PI_GOAL_RUNNER_INTERVAL_MS ?? "60000");
        if (intervalMs > 0) {
            timer = setInterval(() => {
                void schedulerTick(store, { worker: { dryRun: process.env.PI_GOAL_RUNNER_DRY_RUN === "1" } })
                    .then(() => refreshWidget(ctx))
                    .catch((error) => ctx.ui.notify(`Goal runner tick failed: ${error instanceof Error ? error.message : String(error)}`, "error"));
            }, intervalMs);
            timer.unref();
        }
    });
    pi.on?.("session_shutdown", () => {
        if (timer)
            clearInterval(timer);
        timer = undefined;
    });
    async function refreshWidget(ctx) {
        const goals = await store.list();
        const active = goals.filter((goal) => !["completed", "cancelled", "dormant"].includes(goal.state)).length;
        const decisions = goals.reduce((count, goal) => count + goal.pendingDecisions.filter((decision) => decision.status === "pending").length, 0);
        ctx.ui.setStatus?.("goals", active ? `goals:${active}${decisions ? ` decisions:${decisions}` : ""}` : undefined);
        if (decisions) {
            ctx.ui.setWidget?.("goals", [`${decisions} goal decision(s) pending. Run /goal decisions.`]);
        }
        else {
            ctx.ui.setWidget?.("goals", undefined);
        }
    }
}
//# sourceMappingURL=extension.js.map