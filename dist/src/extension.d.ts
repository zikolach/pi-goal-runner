interface ExtensionAPI {
    registerCommand(name: string, options: {
        description?: string;
        handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
        getArgumentCompletions?(prefix: string): unknown[] | null | Promise<unknown[] | null>;
    }): void;
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
interface ExtensionCommandContext extends ExtensionContext {
}
export default function goalRunnerExtension(pi: ExtensionAPI): void;
export {};
