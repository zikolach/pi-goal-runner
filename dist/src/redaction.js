const SECRET_PATTERNS = [
    /gh[pousr]_[A-Za-z0-9_]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /sk-[A-Za-z0-9_-]{20,}/g,
    /xox[baprs]-[A-Za-z0-9-]{20,}/g,
];
const PREFIXED_SECRET_PATTERNS = [
    /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*=)([^\s]+)/gi,
    /(Authorization:\s*(?:Bearer|token)\s+)([^\s]+)/gi,
];
export const DEFAULT_MAX_TEXT = 4_000;
export function redactText(input, maxLength = DEFAULT_MAX_TEXT) {
    let text = typeof input === "string" ? input : JSON.stringify(input ?? "");
    for (const pattern of SECRET_PATTERNS) {
        text = text.replace(pattern, "[REDACTED]");
    }
    for (const pattern of PREFIXED_SECRET_PATTERNS) {
        text = text.replace(pattern, (_match, prefix) => `${prefix}[REDACTED]`);
    }
    if (text.length > maxLength)
        return `${text.slice(0, maxLength)}… [truncated]`;
    return text;
}
export function redactObject(value, maxStringLength = DEFAULT_MAX_TEXT) {
    if (typeof value === "string")
        return redactText(value, maxStringLength);
    if (Array.isArray(value))
        return value.map((item) => redactObject(item, maxStringLength));
    if (value && typeof value === "object") {
        const output = {};
        for (const [key, raw] of Object.entries(value)) {
            if (/token|secret|password|authorization|api[_-]?key/i.test(key)) {
                output[key] = "[REDACTED]";
            }
            else {
                output[key] = redactObject(raw, maxStringLength);
            }
        }
        return output;
    }
    return value;
}
export function safeError(error) {
    if (error instanceof Error)
        return redactText(error.message);
    return redactText(String(error));
}
export function createLogger(name = "goal-runner") {
    const write = (level, message, details) => {
        const suffix = details === undefined ? "" : ` ${redactText(details, 2_000)}`;
        console.error(`[${name}] ${level}: ${redactText(message, 500)}${suffix}`);
    };
    return {
        debug: (message, details) => {
            if (process.env.PI_GOAL_RUNNER_DEBUG)
                write("debug", message, details);
        },
        info: (message, details) => write("info", message, details),
        warn: (message, details) => write("warn", message, details),
        error: (message, details) => write("error", message, details),
    };
}
//# sourceMappingURL=redaction.js.map