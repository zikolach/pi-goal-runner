import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkerEvent } from "../src/state/events.js";

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
