import type { GoalEvent, GoalRecord } from "./types.js";
import type { GoalStore } from "./state/store.js";
export interface NotificationSink {
    name: string;
    notify(goal: GoalRecord, event: GoalEvent): Promise<void>;
}
export declare class NoopNotificationSink implements NotificationSink {
    name: string;
    notify(): Promise<void>;
}
export declare class CommandNotificationSink implements NotificationSink {
    private command;
    private args;
    private timeoutMs;
    name: string;
    constructor(command: string, args?: string[], name?: string, timeoutMs?: number);
    notify(goal: GoalRecord, event: GoalEvent): Promise<void>;
}
export declare function createDefaultNotificationSink(): NotificationSink;
export declare function notifyNonFatal(store: GoalStore, sink: NotificationSink, goal: GoalRecord, event: GoalEvent): Promise<void>;
