## 1. Project Skeleton

- [x] 1.1 Add package metadata, TypeScript config, source/test directories, and npm scripts.
- [x] 1.2 Add Pi extension entrypoint that registers `/goal` command help without executing workers.
- [x] 1.3 Add safe logging/redaction helpers and shared domain types for goals, runs, events, decisions, and schedules.
- [x] 1.4 Add initial README with installation, security model, and command overview.

## 2. Durable Goal State

- [x] 2.1 Implement goal state directory layout and atomic JSON read/write helpers.
- [x] 2.2 Implement append-only JSONL event log with validation and redaction.
- [x] 2.3 Implement per-goal filesystem lock helpers for scheduler and worker execution.
- [x] 2.4 Implement goal create/list/get/update operations with unit tests.
- [x] 2.5 Implement backoff and quiet-window policy helpers with unit tests.

## 3. Pi Extension Commands

- [x] 3.1 Implement `/goal list` and `/goal status <goal-id>`.
- [x] 3.2 Implement `/goal pause`, `/goal resume`, and `/goal cancel`.
- [x] 3.3 Implement `/goal decisions` and `/goal answer <decision-id> <choice>`.
- [x] 3.4 Add command completion for goal subcommands and active goal ids.
- [x] 3.5 Add integration tests for command parsing, state updates, and safe user-facing output.

## 4. Scheduler and Observation Loop

- [x] 4.1 Implement due-goal selection and skip rules for paused/cancelled/completed/waiting goals.
- [x] 4.2 Implement scheduler tick with locking, observation, state update, and backoff handling.
- [x] 4.3 Add extension timer mode that runs scheduler checks while Pi is open and stops on session shutdown.
- [x] 4.4 Add optional daemon/CLI entrypoint for running scheduler checks outside an interactive Pi session.
- [x] 4.5 Add tests for concurrent scheduler attempts and lock behavior.

## 5. Subprocess Worker Execution

- [x] 5.1 Implement dedicated git worktree creation/reuse for repository goals.
- [x] 5.2 Implement worker context prompt generation from durable goal state and fresh observations.
- [x] 5.3 Implement subprocess launch, timeout, abort, and process cleanup.
- [x] 5.4 Implement JSONL event ingestion for progress, decision, completion, and failure events.
- [x] 5.5 Add tests for malformed events, non-zero exits, timeouts, and state updates.

## 6. Decision Protocol and Notifications

- [x] 6.1 Implement pending decision records and answer validation.
- [x] 6.2 Implement local UI notifications/widgets for active Pi sessions when decisions or high-signal events appear.
- [x] 6.3 Define notification sink interface and add a no-op/default sink.
- [x] 6.4 Add optional PiRelay notification sink or integration hook for progress/completion/decision events.
- [x] 6.5 Add tests that notification failures are nonfatal and decisions remain pending.

## 7. GitHub PR Review Goal

- [x] 7.1 Implement `/goal watch-pr <repo-or-url> <pr-number-or-url>` creation flow with `gh` auth/repo validation.
- [x] 7.2 Implement GitHub observation for unresolved review threads, comments, checks, and workflow failures.
- [x] 7.3 Implement actionable-change detection using last observed/handled timestamps and ids.
- [x] 7.4 Implement PR review worker prompt template that requires verify-fix-test-push-reply-resolve behavior.
- [x] 7.5 Implement GitHub reply/resolve helpers gated on pushed commit evidence.
- [x] 7.6 Add tests with mocked `gh` output for no-op, new review, failing checks, stale comments, and quiet-window completion.

## 8. Validation and Packaging

- [x] 8.1 Run `npm run typecheck`.
- [x] 8.2 Run unit and integration tests.
- [x] 8.3 Run `openspec validate add-goal-runner-extension --strict`.
- [x] 8.4 Test extension manually in Pi with a dry-run goal.
- [x] 8.5 Document installation as a global/project Pi extension package and note daemon setup options.
