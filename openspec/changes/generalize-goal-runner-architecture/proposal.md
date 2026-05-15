## Why

`pi-goal-runner` is intended to be a durable fuzzy-goal scheduler, but the current scheduler and worker flow still directly encode GitHub PR review behavior. This makes upcoming worktree isolation and goal-management UI work likely to deepen PR-specific assumptions unless the core/adapter boundary is clarified first.

## What Changes

- Introduce an internal goal-adapter architecture that lets the scheduler invoke goal-type behavior through a small contract instead of importing GitHub PR modules directly.
- Move GitHub PR observation, actionability detection, prompt construction, completion side effects, and display metadata behind a GitHub PR adapter while preserving existing `/goal watch-pr` behavior.
- Define generic scheduler responsibilities: due selection, locks, decisions, backoff, event persistence, worker lifecycle, notifications, and no-action policy.
- Define adapter responsibilities: observe external context, decide whether work is useful, prepare goal-specific execution context, build worker prompts, handle successful completion side effects, and provide display summaries.
- Keep the adapter system internal for now; do not introduce a public third-party plugin API or new non-GitHub goal type in this change.

## Capabilities

### New Capabilities
- `goal-adapter-architecture`: Internal adapter contract that separates generic durable goal scheduling from goal-type-specific behavior.

### Modified Capabilities
- None. Existing GitHub PR goal behavior, subprocess execution semantics, and state storage remain externally compatible; this change adds an internal architecture capability rather than changing their public requirements.

## Impact

- Affects `src/scheduler.ts`, `src/types.ts`, `src/worker/prompt.ts`, `src/worker/worktree.ts`, `src/github/*`, and likely command/status formatting in `src/commands.ts`.
- Adds an internal adapter registry/module, with GitHub PR review as the first concrete adapter.
- Adds tests proving current GitHub PR goal behavior remains unchanged through the adapter boundary.
- Creates a cleaner foundation for `isolate-worker-worktrees` and `add-goal-management-tui` without implementing either feature here.
