import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkerEvent } from "../src/state/events.js";

test("complete worker events bound and redact addressed thread ids", () => {
  const capped = normalizeWorkerEvent("g", "r", {
    type: "complete",
    status: "success",
    addressedThreadIds: Array.from({ length: 75 }, (_unused, index) => `thread-${index}`),
  });

  assert.equal(capped.type, "complete");
  if (capped.type !== "complete") return;
  assert.equal(capped.addressedThreadIds?.length, 50);
  assert.equal(capped.addressedThreadIds?.at(-1), "thread-49");

  const unsafe = normalizeWorkerEvent("g", "r", {
    type: "complete",
    status: "success",
    addressedThreadIds: [null, "", "   ", `PRRT_ghp_${"a".repeat(24)}_${"x".repeat(200)}`, "ok", "ok"],
  });

  assert.equal(unsafe.type, "complete");
  if (unsafe.type !== "complete") return;
  assert.equal(unsafe.addressedThreadIds?.length, 2);
  const [redacted, ok] = unsafe.addressedThreadIds ?? [];
  assert.doesNotMatch(redacted ?? "", /ghp_/);
  assert.match(redacted ?? "", /\[REDACTED\]/);
  assert.ok((redacted ?? "").length <= 133);
  assert.equal(ok, "ok");
});

test("decision worker events coerce timeoutAt and required to schema-safe types", () => {
  const malformed = normalizeWorkerEvent("g", "r", {
    type: "decision",
    decision: {
      id: "d",
      prompt: "Choose",
      options: [],
      timeoutAt: { at: "2026-01-01T00:00:00Z" },
      required: "false",
    },
  });

  assert.equal(malformed.type, "decision");
  if (malformed.type !== "decision") return;
  assert.equal(malformed.decision.timeoutAt, undefined);
  assert.equal(malformed.decision.required, true);

  const valid = normalizeWorkerEvent("g", "r", {
    type: "decision",
    decision: {
      id: "d",
      prompt: "Choose",
      options: [],
      timeoutAt: "2026-01-01T00:00:00Z",
      required: false,
    },
  });

  assert.equal(valid.type, "decision");
  if (valid.type !== "decision") return;
  assert.equal(valid.decision.timeoutAt, "2026-01-01T00:00:00Z");
  assert.equal(valid.decision.required, false);
});

test("decision worker events cap untrusted options", () => {
  const event = normalizeWorkerEvent("g", "r", {
    type: "decision",
    decision: {
      id: "d",
      prompt: "Choose",
      options: Array.from({ length: 30 }, (_unused, index) => ({ id: `option-${index}`, label: `Option ${index}` })),
    },
  });

  assert.equal(event.type, "decision");
  if (event.type !== "decision") return;
  assert.equal(event.decision.options.length, 20);
  assert.equal(event.decision.options.at(-1)?.id, "option-19");
});
