import { appendFile, chmod } from "node:fs/promises";
import type { DecisionRecord, GoalEvent, ValidationResult } from "../types.js";
import { redactObject, redactText } from "../redaction.js";
import { ensureDir } from "./json.js";
import type { StatePaths } from "./paths.js";

const MAX_ADDRESSED_THREAD_IDS = 50;
const MAX_ADDRESSED_THREAD_ID_LENGTH = 120;
const MAX_VALIDATION_RESULTS = 20;
const MAX_VALIDATION_COMMAND_LENGTH = 500;
const MAX_VALIDATION_OUTPUT_LENGTH = 2_000;

function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeWorkerEvent(goalId: string, runId: string | undefined, raw: unknown): GoalEvent {
  if (!raw || typeof raw !== "object") {
    return { type: "diagnostic", goalId, runId, timestamp: nowIso(), message: "Worker emitted a non-object event" };
  }
  const event = raw as Record<string, unknown>;
  const type = event.type;
  if (type === "progress") {
    return { type, goalId, runId, timestamp: nowIso(), message: redactText(event.message ?? "", 1_000) };
  }
  if (type === "decision") {
    const decisionRaw = event.decision && typeof event.decision === "object" ? (event.decision as Partial<DecisionRecord>) : undefined;
    const options = Array.isArray(decisionRaw?.options) ? decisionRaw.options : [];
    const timeoutAt = typeof decisionRaw?.timeoutAt === "string" ? decisionRaw.timeoutAt : undefined;
    const required = typeof decisionRaw?.required === "boolean" ? decisionRaw.required : true;
    return {
      type,
      goalId,
      runId,
      timestamp: nowIso(),
      decision: {
        id: redactText(decisionRaw?.id ?? event.id ?? `decision-${Date.now()}`, 120),
        goalId,
        runId,
        prompt: redactText(decisionRaw?.prompt ?? event.prompt ?? "Decision required", 2_000),
        options: normalizeDecisionOptions(options),
        createdAt: nowIso(),
        timeoutAt,
        status: "pending",
        required,
      },
    };
  }
  if (type === "complete") {
    return {
      type,
      goalId,
      runId,
      timestamp: nowIso(),
      status: event.status === "quiet" || event.status === "stale" ? event.status : "success",
      summary: redactText(event.summary ?? "Worker completed", 2_000),
      commitSha: typeof event.commitSha === "string" ? redactText(event.commitSha, 80) : undefined,
      validationResults: normalizeValidationResults(event.validationResults),
      addressedThreadIds: normalizeAddressedThreadIds(event.addressedThreadIds),
    };
  }
  if (type === "failure") {
    return {
      type,
      goalId,
      runId,
      timestamp: nowIso(),
      message: redactText(event.message ?? "Worker failed", 2_000),
      retryable: event.retryable !== false,
    };
  }
  return { type: "diagnostic", goalId, runId, timestamp: nowIso(), message: `Unknown worker event type: ${redactText(String(type), 100)}` };
}

function normalizeDecisionOptions(options: unknown[]): DecisionRecord["options"] {
  return options.map((option, index) => {
    if (!option || typeof option !== "object") {
      return { id: `option-${index + 1}`, label: "" };
    }
    const item = option as Record<string, unknown>;
    return {
      id: redactText(item.id ?? `option-${index + 1}`, 80),
      label: redactText(item.label ?? "", 120),
    };
  });
}

function normalizeAddressedThreadIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const rawId of value.slice(0, MAX_ADDRESSED_THREAD_IDS)) {
    if (typeof rawId !== "string") continue;
    const id = redactText(rawId, MAX_ADDRESSED_THREAD_ID_LENGTH).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.length ? ids : undefined;
}

function normalizeValidationResults(value: unknown): ValidationResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const results: ValidationResult[] = [];
  for (const rawResult of value.slice(0, MAX_VALIDATION_RESULTS)) {
    if (!rawResult || typeof rawResult !== "object") continue;
    const item = rawResult as Record<string, unknown>;
    const command = redactText(item.command ?? "", MAX_VALIDATION_COMMAND_LENGTH).trim();
    if (!command) continue;
    const status = item.status === "passed" || item.status === "failed" || item.status === "skipped" ? item.status : "skipped";
    const result: ValidationResult = { command, status };
    if (item.output !== undefined) result.output = redactText(item.output, MAX_VALIDATION_OUTPUT_LENGTH);
    results.push(result);
  }
  return results.length ? results : undefined;
}

export function parseWorkerEventLine(goalId: string, runId: string | undefined, line: string): GoalEvent {
  try {
    return normalizeWorkerEvent(goalId, runId, JSON.parse(line));
  } catch {
    return { type: "diagnostic", goalId, runId, timestamp: nowIso(), message: `Malformed worker event: ${redactText(line, 500)}` };
  }
}

export async function appendGoalEvent(paths: StatePaths, event: GoalEvent): Promise<void> {
  await ensureDir(paths.goalDir(event.goalId));
  const safe = redactObject(event, 4_000);
  const file = paths.eventsFile(event.goalId);
  await appendFile(file, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch (error) {
    if (process.platform !== "win32" || !(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
  }
}
