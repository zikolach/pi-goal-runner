## 1. Terminal Event Semantics

- [x] 1.1 Review current worker close handling and terminal event tracking in `src/worker/subprocess.ts`.
- [x] 1.2 Latch terminal event type only after successful event ingestion.
- [x] 1.3 Prevent non-zero close, timeout, or zero-without-terminal synthesis from overwriting an already latched terminal event.
- [x] 1.4 Preserve existing synthetic failure behavior when no terminal event was successfully ingested.

## 2. Late Diagnostics

- [x] 2.1 Add bounded diagnostic recording for non-zero process exit after a terminal event.
- [x] 2.2 Ensure diagnostic write failure after terminal completion is nonfatal and does not change run outcome.
- [x] 2.3 Redact stderr/exit details in diagnostics using existing redaction helpers.

## 3. Regression Tests

- [x] 3.1 Add a test for successful `complete` followed by non-zero process exit.
- [x] 3.2 Add a test for `decision` followed by non-zero process exit preserving `needs_decision`.
- [x] 3.3 Add a test for emitted `failure` remaining authoritative after process close.
- [x] 3.4 Add tests for non-zero exit, zero exit, and timeout without terminal events remaining failures.
- [x] 3.5 Add a test for stale-context-like stderr after completion being recorded only as diagnostic.

## 4. Validation

- [x] 4.1 Run `npm run typecheck`.
- [x] 4.2 Run `npm test`.
- [x] 4.3 Run `openspec validate harden-worker-terminal-events --strict`.
