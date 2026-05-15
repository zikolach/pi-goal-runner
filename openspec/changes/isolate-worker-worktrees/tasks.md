## 1. Worktree Strategy

- [x] 1.1 Audit current worktree creation, reuse, refresh, and prompt assumptions in `src/worker/worktree.ts`, `src/scheduler.ts`, and `src/worker/prompt.ts`.
- [x] 1.2 Define isolated worktree metadata needed for workspace path, observed head SHA, remote, and target push branch.
- [x] 1.3 Detect and migrate existing goals whose worktree path points to the user's active checkout.
- [x] 1.4 Ensure same-path execution is explicit rather than an implicit fallback.

## 2. Detached Worker Worktrees

- [x] 2.1 Create isolated worker worktrees in detached HEAD mode at the observed PR head or safe fetched revision.
- [x] 2.2 Refresh clean reusable worker worktrees by fetching and resetting to the observed PR head.
- [x] 2.3 Fail safely when an isolated worktree is dirty before launch.
- [x] 2.4 Handle missing or invalid stored worktree paths by recreating when safe or recording actionable failure.

## 3. Push Target Prompting

- [x] 3.1 Update worker prompts to distinguish detached workspace state from the PR branch push target.
- [x] 3.2 Include explicit push guidance for detached worktrees, such as pushing `HEAD:<target-branch>` without force by default.
- [x] 3.3 Ensure completion evidence still reports the pushed commit SHA for auto-reply/resolve.
- [x] 3.4 Preserve existing unsupported/fail-safe behavior for fork PRs unless explicitly supported.

## 4. Tests

- [x] 4.1 Add tests for PR branch already checked out in the user's main worktree.
- [x] 4.2 Add tests that existing same-path goals are moved to isolated worker worktrees before launch.
- [x] 4.3 Add tests for dirty isolated worktree safe failure.
- [x] 4.4 Add tests for clean reusable worktree refresh to observed PR head.
- [x] 4.5 Add tests that user checkout untracked files do not block isolated worker execution.
- [x] 4.6 Add prompt tests for detached worktree push target instructions.

## 5. Documentation and Validation

- [x] 5.1 Document worker worktree isolation, detached checkout behavior, and cleanup/recovery notes in README.
- [x] 5.2 Run `npm run typecheck`.
- [x] 5.3 Run `npm test`.
- [x] 5.4 Run `openspec validate isolate-worker-worktrees --strict`.
