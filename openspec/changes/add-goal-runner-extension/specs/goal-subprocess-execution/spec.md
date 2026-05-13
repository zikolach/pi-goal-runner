## ADDED Requirements

### Requirement: Worker runs execute outside the main Pi session
The system SHALL run actionable goal work in an isolated worker process rather than the user's main interactive Pi session.

#### Scenario: Worker is launched
- **WHEN** a goal check determines that worker action is required
- **THEN** the system launches a worker subprocess with explicit goal context
- **AND** the main Pi session remains usable for unrelated user prompts

#### Scenario: Main session is closed
- **WHEN** no interactive Pi session is open but the external scheduler is running
- **THEN** the scheduler can still launch worker subprocesses and update durable goal state

### Requirement: Worker runs use explicit context seeding
The system SHALL generate a worker prompt from durable goal state and fresh observations.

#### Scenario: PR review worker starts
- **WHEN** the system starts a PR review worker
- **THEN** the worker prompt includes the repository, PR number, branch, goal policy, fresh review/check observations, previous safe run summary, and required validation steps
- **AND** it does not depend on the main interactive session transcript for required instructions

#### Scenario: Previous run summary exists
- **WHEN** a goal has previous run history
- **THEN** the worker prompt includes the latest safe summary and relevant ids/timestamps needed for continuity
- **AND** excludes full prior transcripts unless explicitly configured

### Requirement: Repository-mutating goals use dedicated worktrees
The system SHALL isolate repository-mutating worker runs in dedicated git worktrees.

#### Scenario: Worktree is created
- **WHEN** a repository goal is created or first executed
- **THEN** the system creates or reuses a dedicated worktree for the target branch
- **AND** records the worktree path in goal state

#### Scenario: Main working tree has local changes
- **WHEN** the user's main repository working tree is dirty
- **THEN** worker execution still uses the dedicated worktree
- **AND** does not modify or stage files in the main working tree

#### Scenario: Worktree branch is unavailable
- **WHEN** the configured branch cannot be checked out or updated safely
- **THEN** the system records a failure event and does not launch the worker agent

### Requirement: Worker subprocesses emit structured events
The system SHALL ingest newline-delimited JSON events from worker subprocesses.

#### Scenario: Progress event is emitted
- **WHEN** a worker emits `{ "type": "progress", "message": "..." }`
- **THEN** the supervisor appends a safe progress event to durable goal events
- **AND** forwards it to active UI or notification sinks according to policy

#### Scenario: Completion event is emitted
- **WHEN** a worker emits a completion event with status and summary
- **THEN** the supervisor records the run summary and updates goal state
- **AND** schedules the next check according to the goal policy

#### Scenario: Malformed event is emitted
- **WHEN** a worker emits invalid JSON or an unknown event shape
- **THEN** the supervisor records a safe diagnostic
- **AND** does not crash the scheduler process

### Requirement: Worker failures are contained
The system SHALL treat worker errors as goal-run failures without corrupting state.

#### Scenario: Worker exits non-zero
- **WHEN** a worker subprocess exits with a non-zero status
- **THEN** the supervisor records a failure event with redacted output
- **AND** applies retry/backoff policy

#### Scenario: Worker times out
- **WHEN** a worker exceeds the configured execution timeout
- **THEN** the supervisor terminates the worker process tree where possible
- **AND** records a timeout failure event
