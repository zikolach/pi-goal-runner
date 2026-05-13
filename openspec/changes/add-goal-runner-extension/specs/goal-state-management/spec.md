## ADDED Requirements

### Requirement: Goals are durable structured records
The system SHALL store each automation goal as a durable structured record outside the LLM transcript.

#### Scenario: Goal is created
- **WHEN** the user creates a goal from a Pi command
- **THEN** the system writes a goal record with id, type, repository or working directory metadata, schedule policy, state, created timestamp, and safe summary
- **AND** it does not store secrets, bot tokens, or full LLM transcripts in the goal record

#### Scenario: Goal state survives restart
- **WHEN** Pi or the goal runner restarts
- **THEN** the system reloads existing goal records from durable state
- **AND** preserves next-run timing, backoff state, quiet-window state, run summaries, and pending decisions

### Requirement: Goal commands manage lifecycle
The Pi extension SHALL expose local commands to inspect and manage goals.

#### Scenario: User lists goals
- **WHEN** the user runs `/goal list`
- **THEN** the system displays active, paused, waiting, failed, completed, and cancelled goals with concise safe status

#### Scenario: User inspects one goal
- **WHEN** the user runs `/goal status <goal-id>`
- **THEN** the system displays the goal type, state, next scheduled check, latest safe progress, last run summary, pending decision count, and worktree path if applicable

#### Scenario: User pauses or resumes a goal
- **WHEN** the user runs `/goal pause <goal-id>` or `/goal resume <goal-id>`
- **THEN** the system updates the goal state durably
- **AND** paused goals do not start new worker runs

#### Scenario: User cancels a goal
- **WHEN** the user runs `/goal cancel <goal-id>`
- **THEN** the system marks the goal cancelled durably
- **AND** does not schedule new checks or worker runs for that goal

### Requirement: Goals apply backoff and quiet-window policies
The scheduler SHALL decide future checks from durable backoff and quiet-window policy.

#### Scenario: No actionable work is found
- **WHEN** a scheduled check finds no new review, no failing checks, and no pending decision
- **THEN** the system increases or preserves backoff according to the goal policy
- **AND** updates quiet-window state from the latest observed actionable timestamp

#### Scenario: Quiet window expires
- **WHEN** a goal has no actionable work for its configured quiet window
- **THEN** the system marks the goal completed or dormant according to policy
- **AND** records a completion event

#### Scenario: Actionable work is found
- **WHEN** a scheduled check finds new actionable work
- **THEN** the system resets backoff according to policy
- **AND** attempts to acquire the goal lock before launching a worker

### Requirement: Goal state updates are concurrency-safe
The system SHALL guard goal state and worker execution with per-goal locking.

#### Scenario: Two schedulers check the same goal
- **WHEN** two runner processes attempt to start the same due goal concurrently
- **THEN** only one process acquires the goal execution lock
- **AND** the other process exits or reports that the goal is already running

#### Scenario: State write fails
- **WHEN** a goal state update cannot be written atomically
- **THEN** the system reports a safe failure
- **AND** does not claim the goal run completed successfully
