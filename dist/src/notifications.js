import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendGoalEvent } from "./state/events.js";
import { redactText } from "./redaction.js";
const execFileAsync = promisify(execFile);
const DEFAULT_NOTIFICATION_TIMEOUT_MS = 30_000;
export class NoopNotificationSink {
    name = "noop";
    async notify() { }
}
export class CommandNotificationSink {
    command;
    args;
    timeoutMs;
    name;
    constructor(command, args = [], name = "command", timeoutMs = DEFAULT_NOTIFICATION_TIMEOUT_MS) {
        this.command = command;
        this.args = args;
        this.timeoutMs = timeoutMs;
        this.name = name;
    }
    async notify(goal, event) {
        await execFileAsync(this.command, this.args, {
            env: { ...process.env, PI_GOAL_NOTIFICATION: JSON.stringify({ goalId: goal.id, event }) },
            killSignal: "SIGTERM",
            maxBuffer: 1024 * 1024,
            timeout: this.timeoutMs,
        });
    }
}
export function createDefaultNotificationSink() {
    if (process.env.PI_GOAL_NOTIFY_COMMAND) {
        return new CommandNotificationSink(process.env.PI_GOAL_NOTIFY_COMMAND, process.env.PI_GOAL_NOTIFY_ARGS?.split(" ").filter(Boolean) ?? [], "command");
    }
    if (process.env.PIRELAY_NOTIFY_COMMAND) {
        return new CommandNotificationSink(process.env.PIRELAY_NOTIFY_COMMAND, process.env.PIRELAY_NOTIFY_ARGS?.split(" ").filter(Boolean) ?? [], "pirelay");
    }
    return new NoopNotificationSink();
}
export async function notifyNonFatal(store, sink, goal, event) {
    try {
        await sink.notify(goal, event);
        if (sink.name !== "noop")
            await appendGoalEvent(store.paths, { type: "notification", goalId: goal.id, runId: event.runId, timestamp: new Date().toISOString(), sink: sink.name, status: "sent", message: event.type });
    }
    catch (error) {
        await appendGoalEvent(store.paths, { type: "notification", goalId: goal.id, runId: event.runId, timestamp: new Date().toISOString(), sink: sink.name, status: "failed", message: redactText(error instanceof Error ? error.message : String(error), 1_000) });
    }
}
//# sourceMappingURL=notifications.js.map