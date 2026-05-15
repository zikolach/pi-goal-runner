## ADDED Requirements

### Requirement: Scheduler uses goal adapters for goal-type-specific behavior
The scheduler SHALL invoke goal-type-specific behavior through an internal adapter selected by `GoalRecord.type` instead of directly importing or branching into concrete GitHub PR observation, prompt, workspace, or completion-update modules.

#### Scenario: GitHub PR goal is processed through an adapter
- **WHEN** a due `github_pr_review` goal is checked by the scheduler
- **THEN** the scheduler resolves the GitHub PR adapter for that goal type and uses it for observation, actionability, prompt preparation, and successful-completion side effects

#### Scenario: Unsupported goal type fails safely
- **WHEN** a due goal has no registered adapter
- **THEN** the scheduler records a retryable failure for that goal without crashing the daemon or processing other goals incorrectly

### Requirement: Core scheduler owns durable lifecycle policy
The core scheduler SHALL remain responsible for generic durable goal lifecycle behavior, including due checks, terminal/paused/waiting skips, lock acquisition, abandoned-running recovery, backoff, no-action policy, event persistence, notifications, and worker subprocess launch.

#### Scenario: Adapter reports no actionable work
- **WHEN** an adapter observation indicates no useful work is available for a due goal
- **THEN** the scheduler applies the existing no-action policy and quiet-window behavior without requiring adapter-specific scheduling logic

#### Scenario: Adapter reports actionable work
- **WHEN** an adapter indicates useful work is available for a due goal
- **THEN** the scheduler applies the existing actionable policy, records launch progress, prepares worker inputs, and launches or dry-runs the worker through the generic worker path

### Requirement: Adapters provide worker inputs explicitly
A goal adapter SHALL provide the scheduler with explicit worker inputs for actionable goals, including the prompt text and any goal-specific execution context needed to choose the worker working directory.

#### Scenario: GitHub PR prompt remains adapter-owned
- **WHEN** a GitHub PR review goal becomes actionable
- **THEN** the GitHub PR adapter builds the PR-review worker prompt with repository, PR, review-thread, check, validation, and push guidance instead of the scheduler constructing that prompt directly

#### Scenario: Worker launch remains generic
- **WHEN** the scheduler launches a worker using adapter-provided inputs
- **THEN** worker subprocess handling, JSONL event ingestion, timeout behavior, and terminal-event semantics remain independent of the concrete goal type

### Requirement: GitHub PR behavior remains externally compatible
The GitHub PR adapter SHALL preserve the externally visible behavior of existing GitHub PR review goals, including `/goal watch-pr` creation, PR observation, review-thread/check actionability, validation-command handling, worktree preparation behavior, handled-thread/check suppression, and opt-in auto reply/resolve semantics.

#### Scenario: Existing watch-pr workflow still works
- **WHEN** a user creates a goal with `/goal watch-pr <repo> <pr>` or the equivalent CLI command
- **THEN** the goal is created with the same durable state shape and is processed successfully through the GitHub PR adapter

#### Scenario: Successful completion still updates GitHub side effects
- **WHEN** a GitHub PR worker completes successfully with pushed commit evidence and auto-resolve enabled
- **THEN** the GitHub PR adapter performs the existing reply/resolve behavior and records nonfatal diagnostics for side-effect failures as before

### Requirement: Adapter display metadata is available for generic management surfaces
A goal adapter SHALL expose enough display metadata for generic commands and future TUI surfaces to render a goal without directly inspecting adapter-private fields.

#### Scenario: Status rendering uses adapter display metadata
- **WHEN** a command or management surface renders a GitHub PR review goal
- **THEN** it can obtain target, workspace, and goal-type detail labels through adapter display metadata while preserving the existing text command output

#### Scenario: Missing adapter display metadata is safe
- **WHEN** a goal has no adapter display metadata available
- **THEN** generic management surfaces fall back to core fields such as id, type, state, summary, next check time, and latest progress

### Requirement: Adapter architecture remains internal
The adapter registry and adapter interfaces SHALL remain internal implementation details of the package and SHALL NOT expose a public third-party plugin loading API in this change.

#### Scenario: No dynamic plugin loading is introduced
- **WHEN** the package starts as a Pi extension or CLI daemon
- **THEN** it uses built-in adapters only and does not load adapter code from user configuration, package metadata, or external paths
