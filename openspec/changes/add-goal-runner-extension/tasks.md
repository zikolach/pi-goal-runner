## 1. Project Skeleton

- [ ] 1.1 Add package metadata, TypeScript config, source/test directories, and npm scripts.
- [ ] 1.2 Add Pi extension entrypoint that registers `/goal` command help without executing workers.
- [ ] 1.3 Add safe logging/redaction helpers and shared domain types for goals, runs, events, decisions, and schedules.
- [ ] 1.4 Add initial README with installation, security model, and command overview.

## 2. Durable Goal State

- [ ] 2.1 Implement goal state directory layout and atomic JSON read/write helpers.
- [ ] 2.2 Implement append-only JSONL event log with validation and redaction.
- [ ] 2.3 Implement per-goal filesystem lock helpers for scheduler and worker execution.
- [ ] 2.4 Implement goal create/list/get/update operations with unit tests.
- [ ] 2.5 Implement backoff and quiet-window policy helpers with unit tests.

## 3. Pi Extension Commands

- [ ] 3.1 Implement `/goal list` and `/goal status <goal-id>`.
- [ ] 3.2 Implement `/goal pause`, `/goal resume`, and `/goal cancel`.
- [ ] 3.3 Implement `/goal decisions` and `/goal answer <decision-id> <choice>`.
- [ ] 3.4 Add command completion for goal subcommands and active goal ids.
- [ ] 3.5 Add integration tests for command parsing, state updates, and safe user-facing output.

## 4. Scheduler and Observation Loop

- [ ] 4.1 Implement due-goal selection and skip rules for paused/cancelled/completed/waiting goals.
- [ ] 4.2 Implement scheduler tick with locking, observation, state update, and backoff handling.
- [ ] 4.3 Add extension timer mode that runs scheduler checks while Pi is open and stops on session shutdown.
- [ ] 4.4 Add optional daemon/CLI entrypoint for running scheduler checks outside an interactive Pi session.
- [ ] 4.5 Add tests for concurrent scheduler attempts and lock behavior.

## 5. Subprocess Worker Execution

- [ ] 5.1 Implement dedicated git worktree creation/reuse for repository goals.
- [ ] 5.2 Implement worker context prompt generation from durable goal state and fresh observations.
- [ ] 5.3 Implement subprocess launch, timeout, abort, and process cleanup.
- [ ] 5.4 Implement JSONL event ingestion for progress, decision, completion, and failure events.
- [ ] 5.5 Add tests for malformed events, non-zero exits, timeouts, and state updates.

## 6. Decision Protocol and Notifications

- [ ] 6.1 Implement pending decision records and answer validation.
- [ ] 6.2 Implement local UI notifications/widgets for active Pi sessions when decisions or high-signal events appear.
- [ ] 6.3 Define notification sink interface and add a no-op/default sink.
- [ ] 6.4 Add optional PiRelay notification sink or integration hook for progress/completion/decision events.
- [ ] 6.5 Add tests that notification failures are nonfatal and decisions remain pending.

## 7. GitHub PR Review Goal

- [ ] 7.1 Implement `/goal watch-pr <repo-or-url> <pr-number-or-url>` creation flow with `gh` auth/repo validation.
- [ ] 7.2 Implement GitHub observation for unresolved review threads, comments, checks, and workflow failures.
- [ ] 7.3 Implement actionable-change detection using last observed/handled timestamps and ids.
- [ ] 7.4 Implement PR review worker prompt template that requires verify-fix-test-push-reply-resolve behavior.
- [ ] 7.5 Implement GitHub reply/resolve helpers gated on pushed commit evidence.
- [ ] 7.6 Add tests with mocked `gh` output for no-op, new review, failing checks, stale comments, and quiet-window completion.

## 8. Validation and Packaging

- [ ] 8.1 Run `npm run typecheck`.
- [ ] 8.2 Run unit and integration tests.
- [ ] 8.3 Run `openspec validate add-goal-runner-extension --strict`.
- [ ] 8.4 Test extension manually in Pi with a dry-run goal.
- [ ] 8.5 Document installation as a global/project Pi extension package and note daemon setup options.
