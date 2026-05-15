## Context

The merged goal runner implements a durable scheduler, state store, worker subprocess protocol, GitHub PR observation, worktree preparation, notifications, and auto-reply/resolve behavior. The README now frames the project as a durable fuzzy-goal runner where GitHub PR review is the first adapter, but the implementation still couples the scheduler to GitHub modules directly:

```text
src/scheduler.ts
  ├─ observeGithubPr()
  ├─ findActionable()
  ├─ ensureGoalWorktree()
  ├─ buildWorkerPrompt()
  └─ replyAndResolveAddressedThreads()
```

That coupling makes it harder to implement next changes cleanly. Worktree isolation should become a workspace concern shared by worker-capable goal types, and the future management TUI should render and act on goals without knowing GitHub-specific fields for every row.

## Goals / Non-Goals

**Goals:**

- Introduce an internal `GoalAdapter` boundary selected by `goal.type`.
- Keep the scheduler responsible for durable orchestration: due checks, locks, decisions, backoff, event persistence, worker lifecycle, notifications, and no-action policy.
- Move goal-type-specific behavior behind adapters: external observation, actionability, prompt construction, workspace preparation request/metadata, completion side effects, and display summaries.
- Implement GitHub PR review as the first concrete adapter without changing existing `/goal watch-pr`, CLI, state files, or PR review behavior.
- Create a foundation for worktree isolation and management TUI work without implementing those changes here.

**Non-Goals:**

- No public third-party plugin API.
- No new goal type beyond existing GitHub PR review goals.
- No intentional durable state migration or schema version bump.
- No redesign of the worker JSONL protocol.
- No implementation of detached worktree isolation or interactive TUI behavior in this change.

## Decisions

### Decision: Use an internal adapter registry, not a public plugin API

Introduce a small internal registry keyed by `GoalRecord.type`, initially containing only `github_pr_review`.

```text
GoalRecord.type ──▶ adapter registry ──▶ GoalAdapter
```

Rationale: the immediate need is to remove direct GitHub imports from the scheduler while keeping the implementation simple. A public plugin API would require versioning, extension loading, trust boundaries, documentation, and compatibility commitments that are premature.

Alternative considered: define a fully dynamic plugin system. Rejected because the project has only one concrete goal type and the right contract will become clearer after worktree isolation and TUI work.

### Decision: Keep scheduler policy in core

The scheduler remains the owner of generic lifecycle behavior:

```text
core scheduler
  ├─ skip paused/terminal/not-due/waiting goals
  ├─ acquire and release goal locks
  ├─ recover abandoned running goals
  ├─ apply no-action and actionable scheduling policy
  ├─ append progress/failure events
  ├─ launch worker subprocesses
  └─ notify best-effort sinks
```

Adapters answer goal-specific questions:

```text
adapter
  ├─ observe external context
  ├─ classify whether work is actionable
  ├─ prepare or request execution context
  ├─ build worker prompt
  ├─ handle successful completion side effects
  └─ provide display metadata
```

Rationale: this preserves `pi-goal-runner` as a durable scheduler rather than turning every adapter into a mini-scheduler with inconsistent backoff, lock, decision, and failure behavior.

Alternative considered: let adapters own scheduling decisions. Rejected because it would duplicate durability and recovery logic and make cross-goal UI behavior inconsistent.

### Decision: Make adapter outputs explicit scheduler inputs

A due goal tick should conceptually flow like this:

```text
GoalRecord
  │
  ▼
adapter.observe(goal)
  │
  ▼
adapter.analyze(goal, observation)
  ├─ no action ──▶ core no-action policy
  │
  └─ actionable
       │
       ▼
     adapter.prepareForWorker(goal, observation, actionable)
       │
       ▼
     adapter.buildPrompt(goal, observation, actionable, prepared)
       │
       ▼
     core worker launch + event ingestion
```

The exact TypeScript shape can be refined during implementation, but the boundary should make data dependencies clear and testable. The scheduler should not need to know that a GitHub adapter uses review threads, check names, PR branches, or auto-resolve thread IDs.

### Decision: Treat workspace preparation as adapter-guided, core-invoked

Workspace setup is currently GitHub-specific through `ensureGoalWorktree()`, but the safety property is generic: worker-capable goals should not unexpectedly mutate the user's active checkout.

For this change, keep behavior equivalent by allowing the GitHub adapter to prepare the existing worktree path. Design the boundary so a later `isolate-worker-worktrees` change can introduce a reusable workspace manager without reshaping scheduler logic again.

```text
GitHub adapter knows: repo, branch, PR target, validation commands
Core/worker knows: launch cwd, prompt stdin, subprocess protocol
Future workspace manager knows: isolated path, cleanliness, reuse, recovery
```

### Decision: Add display metadata through adapters

Commands and the future TUI need goal summaries that are not hardcoded to `goal.github`. Add an adapter method or helper for display metadata such as target label, detail fields, valid action hints, and workspace path. Keep existing `/goal status` output compatible in this change.

Rationale: this keeps management UI from becoming a pile of `if goal.github` checks while avoiding a full UI implementation now.

## Risks / Trade-offs

- **Risk: Over-abstraction before multiple goal types exist** → Keep the adapter internal, small, and driven only by existing GitHub PR behavior.
- **Risk: Accidentally changing PR review behavior while moving code** → Add adapter-boundary regression tests around no-action, actionable launch, handled checks/threads, prompt contents, and auto-reply/resolve.
- **Risk: State model becomes awkward for future goal types** → Avoid a schema version bump; introduce helper accessors and adapter-specific config boundaries while preserving the existing `github` field for PR goals.
- **Risk: Worktree isolation gets partially implemented in the architecture change** → Only create the seam; leave detached worktree strategy, dirty worktree checks, and push-target prompt changes to `isolate-worker-worktrees`.
- **Risk: TUI needs more display/action metadata than anticipated** → Provide minimal adapter display metadata now and let `add-goal-management-tui` expand it with concrete UI needs.

## Migration Plan

1. Add adapter interfaces and registry while leaving GitHub modules functionally unchanged.
2. Move scheduler GitHub calls behind the GitHub PR adapter.
3. Update command/status display to use adapter display helpers where practical while preserving existing text output.
4. Run existing tests to prove behavior remains unchanged.
5. Add focused tests that verify scheduler dispatches through the adapter boundary.

Rollback is straightforward: adapter extraction is internal and can be reverted without state migration because goal records remain schema-compatible.

## Open Questions

- Should adapter display metadata be part of the core `GoalAdapter` interface immediately, or a separate optional `GoalDisplayAdapter` helper to keep scheduling minimal?
- Should workspace preparation return a generic `WorkerExecutionContext` now, or should that wait until the worktree isolation change defines the concrete shape?
- Should GitHub PR config eventually move under a generic `config` union field, or is preserving `goal.github` preferable until a second goal type exists?
