import { createGoalStore } from "./state/store.js";
import { schedulerTick } from "./scheduler.js";
interface DaemonLogger {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}
export declare function main(): Promise<void>;
export declare function parseDaemonInterval(value: string | undefined): number;
export declare function runDaemonTick(store: ReturnType<typeof createGoalStore>, tick?: typeof schedulerTick, logger?: DaemonLogger): Promise<void>;
export {};
