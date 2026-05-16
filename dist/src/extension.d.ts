import type { GoalRecord } from "./types.js";
interface ExtensionAPI {
    registerCommand(name: string, options: {
        description?: string;
        handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
        getArgumentCompletions?(prefix: string): unknown[] | null | Promise<unknown[] | null>;
    }): void;
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
        custom?: (factory: (tui: {
            requestRender(): void;
        }, theme: unknown, _keybindings: unknown, done: (result: unknown) => void) => GoalManagerWidget | Promise<GoalManagerWidget>, options?: {
            overlay?: boolean;
            overlayOptions?: unknown;
            onHandle?: (handle: unknown) => void;
        }) => unknown | Promise<unknown>;
    };
}
interface ExtensionCommandContext extends ExtensionContext {
}
export interface SerializedTickState {
    inFlight: boolean;
}
export declare function runSerializedSchedulerTick(state: SerializedTickState, tick: () => Promise<void>, onError: (error: unknown) => void): boolean;
export declare function splitCompletionPrefix(prefix: string): string[];
export declare function shouldSuggestDaemon(goals: GoalRecord[]): boolean;
export declare function buildDaemonSuggestionMessage(daemonEligibleCount: number): string;
export default function goalRunnerExtension(pi: ExtensionAPI): void;
export {};
