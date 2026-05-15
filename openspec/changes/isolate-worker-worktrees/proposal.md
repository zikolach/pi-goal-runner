## Why

Goal workers currently may operate in the user's active checkout when a same-branch linked worktree cannot be created. This makes automation collide with local edits, untracked OpenSpec work, and Git's rule that one branch cannot be checked out in multiple worktrees.

## What Changes

- Introduce a worker-isolated worktree strategy that avoids mutating the user's active checkout by default.
- Use a detached worktree or generated worker branch/ref strategy for PR goals so Git does not reject the worktree because the PR branch is already checked out elsewhere.
- Ensure worker commits can still be pushed to the target PR branch when the worker successfully fixes feedback.
- Add safety checks for dirty worker worktrees, stale/missing worktrees, and existing local user changes.
- Document worktree layout, cleanup expectations, and recovery behavior.

## Capabilities

### New Capabilities
- `worker-worktree-isolation`: Isolated git workspace management for worker subprocesses that protects the user's active checkout while preserving PR branch update behavior.

### Modified Capabilities
- None.

## Impact

- Affects `src/worker/worktree.ts`, scheduler worktree setup, prompt generation, and possibly GitHub PR goal creation metadata.
- May add explicit worktree mode/configuration fields to repository state or worker launch options.
- Adds tests for detached worktree creation, branch-already-checked-out recovery, push target metadata, and dirty worktree safety.
- Reduces conflicts with local README/OpenSpec edits and makes daemon-driven worker runs safer.
