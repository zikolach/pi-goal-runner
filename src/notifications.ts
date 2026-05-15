import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GoalEvent, GoalRecord, NotificationEvent } from "./types.js";
import { appendGoalEvent } from "./state/events.js";
import type { GoalStore } from "./state/store.js";
import { redactText } from "./redaction.js";
import { splitArgs } from "./args.js";

const execFileAsync = promisify(execFile);
const DEFAULT_NOTIFICATION_TIMEOUT_MS = 30_000;

export interface NotificationSink {
  name: string;
  notify(goal: GoalRecord, event: GoalEvent): Promise<void>;
}

export class NoopNotificationSink implements NotificationSink {
  name = "noop";
  async notify(): Promise<void> {}
}

export class CommandNotificationSink implements NotificationSink {
  name: string;
  constructor(private command: string, private args: string[] = [], name = "command", private timeoutMs = DEFAULT_NOTIFICATION_TIMEOUT_MS) {
    this.name = name;
  }
  async notify(goal: GoalRecord, event: GoalEvent): Promise<void> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pi-goal-notification-"));
    const payloadFile = path.join(tempDir, "payload.json");
    try {
      await writeFile(payloadFile, JSON.stringify({ goalId: goal.id, event }), { encoding: "utf8", mode: 0o600 });
      const env: NodeJS.ProcessEnv = { ...process.env, PI_GOAL_NOTIFICATION_FILE: payloadFile };
      delete env.PI_GOAL_NOTIFICATION;
      await execFileAsync(this.command, this.args, {
        env,
        killSignal: "SIGTERM",
        maxBuffer: 1024 * 1024,
        timeout: this.timeoutMs,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function createDefaultNotificationSink(): NotificationSink {
  if (process.env.PI_GOAL_NOTIFY_COMMAND) {
    return new CommandNotificationSink(process.env.PI_GOAL_NOTIFY_COMMAND, process.env.PI_GOAL_NOTIFY_ARGS ? splitArgs(process.env.PI_GOAL_NOTIFY_ARGS) : [], "command");
  }
  if (process.env.PIRELAY_NOTIFY_COMMAND) {
    return new CommandNotificationSink(process.env.PIRELAY_NOTIFY_COMMAND, process.env.PIRELAY_NOTIFY_ARGS ? splitArgs(process.env.PIRELAY_NOTIFY_ARGS) : [], "pirelay");
  }
  return new NoopNotificationSink();
}

export async function notifyNonFatal(store: GoalStore, sink: NotificationSink, goal: GoalRecord, event: GoalEvent): Promise<void> {
  try {
    await sink.notify(goal, event);
  } catch (error) {
    await appendNotificationEventNonFatal(store, { type: "notification", goalId: goal.id, runId: event.runId, timestamp: event.timestamp, sink: sink.name, status: "failed", message: redactText(error instanceof Error ? error.message : String(error), 1_000) });
    return;
  }
  if (sink.name !== "noop") await appendNotificationEventNonFatal(store, { type: "notification", goalId: goal.id, runId: event.runId, timestamp: event.timestamp, sink: sink.name, status: "sent", message: event.type });
}

async function appendNotificationEventNonFatal(store: GoalStore, event: NotificationEvent): Promise<void> {
  try {
    await appendGoalEvent(store.paths, event);
  } catch {
    // Notification event logging is best-effort and must not make notifyNonFatal throw.
  }
}
