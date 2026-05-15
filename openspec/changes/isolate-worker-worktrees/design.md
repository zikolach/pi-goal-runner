## Context

The original GitHub PR goal implementation attempts to create a per-goal worktree for repository-mutating workers. When the PR branch is already checked out in the user's main checkout, `git worktree add <path> <branch>` fails because Git prevents the same branch from being checked out in multiple worktrees. During recovery, setting `worktreePath` to the main project path allowed progress, but it made workers operate in the same checkout as local human work.

That same-path fallback has caused practical friction: untracked README/OpenSpec files can block workers, workers risk touching local edits, and daemon-triggered automation becomes harder to trust. The intended worker boundary is that automation has its own mutable workspace.

Git supports detached linked worktrees and temporary branches. For PR goals, the worker needs a workspace at the PR head and enough metadata/instructions to push commits back to the PR branch when appropriate.

## Goals / Non-Goals

**Goals:**

- Use an isolated worker worktree by default for repository-mutating goals.
- Avoid Git's same-branch worktree restriction when the PR branch is already checked out elsewhere.
- Preserve the ability for workers to commit and push fixes to the PR branch.
- Protect the user's active checkout from worker mutations and dirty-state checks.
- Make worktree creation, reuse, refresh, and failure messages predictable and testable.

**Non-Goals:**

- Building a full worktree garbage collector UI.
- Supporting arbitrary multi-repository orchestration.
- Automatically merging or rebasing user local changes.
- Force-pushing PR branches by default.
- Changing non-git goals beyond shared abstractions needed for worker workspace selection.

## Decisions

### Prefer detached worker worktrees for existing PR branches

When the target branch may already be checked out, create or refresh a linked worktree in detached HEAD at the observed PR head SHA. This avoids Git's branch exclusivity rule while giving the worker an isolated filesystem.

The prompt should explicitly tell the worker the target branch and remote push destination. The worker can commit in detached HEAD and push `HEAD:<target-branch>` after validation.

Alternative considered: use `git worktree add --force` for the same branch. This is unsafe and defeats Git's branch checkout protection.

### Track push target separately from checkout state

Repository state or prompt metadata should distinguish:

- workspace path used by the worker
- observed head SHA checked out in that workspace
- target owner/repo/branch for pushing successful commits

This avoids assuming the local checkout branch is the same as the remote update target.

### Refresh reusable worker worktrees to observed head

On each actionable run, reusable worker worktrees should fetch the target remote and reset the detached checkout to the observed PR head before launching the worker. If the worker worktree is dirty before launch, the scheduler should fail safely rather than overwrite unknown changes.

### Keep same-path mode explicit only

Using the user's active checkout should be an explicit opt-in or recovery override, not the default behavior. The scheduler should not silently fall back to the user's checkout when isolated worktree creation fails.

### Make cleanup a separate concern

This change can document manual cleanup and ensure reusable worktrees remain safe. Automatic pruning/removal can be added later if needed.

## Risks / Trade-offs

- **Detached commits are easy to lose locally** → Prompt and metadata must instruct workers to push `HEAD:<branch>` and report commit SHA evidence.
- **Pushing from detached HEAD can surprise agents** → Include explicit commands and target branch in generated prompts.
- **Remote branch advances during a run** → Existing stale completion semantics should detect outdated observations; workers should fetch before push where appropriate.
- **Dirty isolated worktree blocks automation** → Fail safely with an actionable message; do not clean/reset dirty worktrees automatically unless known safe.
- **Fork PRs complicate push permissions** → Preserve existing unsupported/fail-safe behavior unless a separate fork-support change is proposed.

## Migration Plan

Existing goals whose `worktreePath` points to the user's active checkout can be migrated lazily: on the next actionable run, detect same-path use and create an isolated detached worktree, then update `worktreePath` in goal state. If creation fails, keep the goal failed with a clear message rather than continuing in the user's checkout.

No historical run data migration is required.
