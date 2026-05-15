## 1. Adapter Contract and Registry

- [x] 1.1 Add internal goal adapter types for observation, actionability, worker preparation, prompt construction, completion side effects, and display metadata.
- [x] 1.2 Add an internal adapter registry keyed by `GoalRecord.type`, initially registering only `github_pr_review`.
- [x] 1.3 Add safe adapter lookup behavior that records a goal failure when no adapter exists instead of crashing the scheduler loop.
- [x] 1.4 Add unit tests for adapter lookup and unsupported goal-type failure behavior.

## 2. GitHub PR Adapter Extraction

- [x] 2.1 Create a GitHub PR adapter module that wraps existing PR observation and actionability behavior.
- [x] 2.2 Move GitHub PR prompt construction behind the adapter while preserving current prompt content and redaction behavior.
- [x] 2.3 Move GitHub PR worktree preparation invocation behind the adapter without changing current worktree behavior.
- [x] 2.4 Move successful-completion GitHub side effects behind the adapter, including handled checks and auto reply/resolve behavior.
- [x] 2.5 Add regression tests proving GitHub PR no-action, actionable dry-run, worker launch, handled-check, handled-thread, and auto-resolve behavior remain unchanged.

## 3. Scheduler Refactor

- [x] 3.1 Refactor `src/scheduler.ts` so it no longer directly imports GitHub observation, prompt, worktree, or update modules.
- [x] 3.2 Keep due checks, lock handling, abandoned-running recovery, backoff, quiet-window policy, event persistence, notification, and worker subprocess launch in scheduler core.
- [x] 3.3 Represent adapter-provided worker inputs explicitly so scheduler launches workers without knowing GitHub-specific observation details.
- [x] 3.4 Verify dry-run behavior, failure backoff, late worker events, and decision handling remain generic and unchanged.

## 4. Display Metadata Boundary

- [x] 4.1 Add adapter display metadata helpers for goal target, workspace, and goal-type detail fields.
- [x] 4.2 Update command/status formatting to use display metadata where practical while preserving existing text output.
- [x] 4.3 Add tests for display metadata fallback when adapter metadata is unavailable.

## 5. Compatibility and Documentation

- [x] 5.1 Keep `GoalRecord` durable state schema compatible and avoid a schema version bump.
- [x] 5.2 Update README architecture notes to describe the internal adapter boundary and clarify that public plugin loading is not introduced yet.
- [x] 5.3 Ensure existing `/goal watch-pr`, CLI daemon/tick, and Pi extension behavior remain compatible.

## 6. Validation

- [x] 6.1 Run `npm run typecheck`.
- [x] 6.2 Run `npm test`.
- [x] 6.3 Run `openspec validate generalize-goal-runner-architecture --strict`.
