export declare const DEFAULT_MAX_TEXT = 4000;
export declare function redactText(input: unknown, maxLength?: number): string;
export declare function redactObject<T>(value: T, maxStringLength?: number): T;
export declare function safeError(error: unknown): string;
export interface Logger {
    debug(message: string, details?: unknown): void;
    info(message: string, details?: unknown): void;
    warn(message: string, details?: unknown): void;
    error(message: string, details?: unknown): void;
}
export declare function createLogger(name?: string): Logger;
