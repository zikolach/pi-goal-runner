import { appendFile } from "node:fs/promises";
import { redactObject, redactText } from "../redaction.js";
import { ensureDir } from "./json.js";
function nowIso() {
    return new Date().toISOString();
}
export function normalizeWorkerEvent(goalId, runId, raw) {
    if (!raw || typeof raw !== "object") {
        return { type: "diagnostic", goalId, runId, timestamp: nowIso(), message: "Worker emitted a non-object event" };
    }
    const event = raw;
    const type = event.type;
    if (type === "progress") {
        return { type, goalId, runId, timestamp: nowIso(), message: redactText(event.message ?? "", 1_000) };
    }
    if (type === "decision") {
        const decisionRaw = event.decision && typeof event.decision === "object" ? event.decision : undefined;
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
            validationResults: Array.isArray(event.validationResults) ? redactObject(event.validationResults, 1_000) : undefined,
            addressedThreadIds: Array.isArray(event.addressedThreadIds) ? event.addressedThreadIds.map(String) : undefined,
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
function normalizeDecisionOptions(options) {
    return options.map((option, index) => {
        if (!option || typeof option !== "object") {
            return { id: `option-${index + 1}`, label: "" };
        }
        const item = option;
        return {
            id: redactText(item.id ?? `option-${index + 1}`, 80),
            label: redactText(item.label ?? "", 120),
        };
    });
}
export function parseWorkerEventLine(goalId, runId, line) {
    try {
        return normalizeWorkerEvent(goalId, runId, JSON.parse(line));
    }
    catch {
        return { type: "diagnostic", goalId, runId, timestamp: nowIso(), message: `Malformed worker event: ${redactText(line, 500)}` };
    }
}
export async function appendGoalEvent(paths, event) {
    await ensureDir(paths.goalDir(event.goalId));
    const safe = redactObject(event, 4_000);
    await appendFile(paths.eventsFile(event.goalId), `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
}
//# sourceMappingURL=events.js.map