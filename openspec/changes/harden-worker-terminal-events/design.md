## Context

Workers are subprocesses, usually `pi --print`, that receive a goal prompt on stdin and emit newline-delimited JSON events on stdout. The goal runner folds these events into durable state. The intended protocol is that `complete`, `decision`, and `failure` are terminal run events.

In practice, the spawned Pi process may continue running extension cleanup, notification hooks, or other post-turn work after emitting a terminal event. If that post-turn code writes noisy stderr or exits non-zero, the goal runner can see both a successful terminal event and a process-level failure. Recent PiRelay stale-context crashes exposed this: the goal work completed and pushed commits, but a later process exit made the run appear failed.

## Goals / Non-Goals

**Goals:**

- Preserve the first successfully ingested terminal worker event as the authoritative run outcome.
- Record post-terminal process errors as diagnostics when useful, without changing run state.
- Keep non-zero exit without a terminal event as a real retryable worker failure.
- Keep output bounding and malformed event handling safe.
- Add tests that prevent regressions in success, decision, failure, timeout, and no-terminal-event paths.

**Non-Goals:**

- Fixing bugs inside Pi extensions loaded by worker sessions.
- Suppressing real worker failures before any terminal protocol event is accepted.
- Changing the worker JSONL protocol shape.
- Hiding stderr completely; it remains useful when no terminal event is emitted.

## Decisions

### Terminal event status is latched after successful ingestion

Track the terminal event type only after its ingestion succeeds. Once latched, later process close handling must not enqueue a synthetic failure for non-zero exit or timeout. This avoids trusting malformed/unpersisted terminal-looking output while still protecting accepted terminal outcomes.

### Late process errors become diagnostic events

When the child exits non-zero after a terminal event, append a bounded diagnostic event with the exit reason and redacted stderr rather than mutating goal state or run history. If diagnostics cannot be written, the runner should still resolve with the already persisted terminal state.

Alternative considered: ignore late exits entirely. Diagnostics are preferable because they preserve debuggability for issues like stale Pi extension contexts.

### Synthetic failures remain for missing terminal events

If the worker times out, exits non-zero, or exits zero without any terminal event, the existing synthetic failure behavior remains. These are protocol failures and should advance backoff/retry state.

### Existing terminal failure is also authoritative

If a worker emits a terminal `failure` event and then exits zero or non-zero, the emitted failure remains the outcome. The close handler should not add a second failure that changes timestamps/backoff unexpectedly.

## Risks / Trade-offs

- **Late diagnostics could hide severe process issues** → Keep diagnostics visible in the event log while preserving the protocol outcome.
- **Terminal event ingestion could partially fail** → Latch only after successful event ingestion; if ingestion fails, close handling can still surface failure.
- **Multiple terminal events could conflict** → Preserve current serialized ingestion order and treat the first successfully ingested terminal event as authoritative for process-close synthesis.
- **Long-running workers could still hang after emitting completion** → Timeout should terminate the process, but must not overwrite the accepted completion.

## Migration Plan

No state migration is required. The change affects future worker ingestion behavior only. Existing historical failed runs remain unchanged unless manually repaired.
