const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*=)([^\s]+)/gi,
  /(Authorization:\s*(?:Bearer|token)\s+)([^\s]+)/gi,
];

export const DEFAULT_MAX_TEXT = 4_000;

export function redactText(input: unknown, maxLength = DEFAULT_MAX_TEXT): string {
  let text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...matches: string[]) => {
      if (matches.length >= 3 && matches[1]) return `${matches[1]}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  if (text.length > maxLength) return `${text.slice(0, maxLength)}… [truncated]`;
  return text;
}

export function redactObject<T>(value: T, maxStringLength = DEFAULT_MAX_TEXT): T {
  if (typeof value === "string") return redactText(value, maxStringLength) as T;
  if (Array.isArray(value)) return value.map((item) => redactObject(item, maxStringLength)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (/token|secret|password|authorization|api[_-]?key/i.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = redactObject(raw, maxStringLength);
      }
    }
    return output as T;
  }
  return value;
}

export function safeError(error: unknown): string {
  if (error instanceof Error) return redactText(error.message);
  return redactText(String(error));
}

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export function createLogger(name = "goal-runner"): Logger {
  const write = (level: string, message: string, details?: unknown) => {
    const suffix = details === undefined ? "" : ` ${redactText(details, 2_000)}`;
    console.error(`[${name}] ${level}: ${redactText(message, 500)}${suffix}`);
  };
  return {
    debug: (message, details) => {
      if (process.env.PI_GOAL_RUNNER_DEBUG) write("debug", message, details);
    },
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  };
}
