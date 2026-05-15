## Why

Goal workers communicate success, decisions, and failures through an explicit JSONL protocol, but the surrounding `pi` process can still emit noisy stderr or exit non-zero after a terminal event has already been accepted. That has caused successful PR-review runs to be misclassified as failures when an unrelated Pi extension crashed after completion.

## What Changes

- Make worker protocol terminal events authoritative for the run outcome once successfully ingested.
- Treat process-exit errors, stderr noise, and known post-completion extension crashes after a terminal event as diagnostics rather than overwriting success or decision state.
- Ensure late process failures after `complete`, `decision`, or `failure` events cannot change the goal state, run status, backoff, or next-check scheduling inconsistently.
- Preserve normal failure behavior when a worker exits non-zero without emitting a terminal protocol event.
- Add regression coverage for post-completion non-zero exit, post-terminal timeout, diagnostic-write failure, stale-context stderr after completion, decision plus non-zero exit, and no-terminal-event failures.
- Keep the extension's daemon reminder UI aligned with scheduler-skipped states and document that user-visible reminder behavior in this change.

## Capabilities

### New Capabilities
- `worker-terminal-event-hardening`: Robust worker event ingestion semantics where terminal protocol events remain authoritative over later process lifecycle noise.

### Modified Capabilities
- None.

## Impact

- Affects `src/worker/subprocess.ts` terminal event tracking and failure ingestion behavior.
- Affects scheduler completion handling only insofar as successful worker completions must remain stable after process close.
- Affects extension daemon reminder copy/visibility so it does not suggest a daemon for states that are waiting on the user or paused.
- Adds tests in worker/scheduler coverage for late failures, diagnostics, and process exit edge cases.
- May update README troubleshooting notes if useful.
