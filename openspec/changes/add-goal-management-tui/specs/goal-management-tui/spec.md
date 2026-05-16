## ADDED Requirements

### Requirement: Interactive goal list modal
The system SHALL provide an interactive modal goal manager in Pi that lists durable goals in a keyboard-navigable summary view.

#### Scenario: Open goal manager with goals
- **WHEN** the user opens the goal manager in an interactive Pi session and at least one goal exists
- **THEN** the system displays a modal list containing each goal's state, id, summary or target, and next-check information

#### Scenario: Open goal manager without goals
- **WHEN** the user opens the goal manager in an interactive Pi session and no goals exist
- **THEN** the system displays an empty-state message and a close hint

#### Scenario: Navigate goal list
- **WHEN** the user presses up or down in the goal list
- **THEN** the selected goal changes without leaving the modal

#### Scenario: Close goal list
- **WHEN** the user presses escape or q in the goal list
- **THEN** the system closes the goal manager modal without changing goal state

### Requirement: Selected goal detail view
The system SHALL allow users to open a formatted detail view for the selected goal from the modal list.

#### Scenario: Open selected goal detail
- **WHEN** the user presses enter on a selected goal in the list
- **THEN** the system displays a detail view for that goal including state, type, summary, next check, latest progress, last run summary, pending-decision count, and worktree or target information when available

#### Scenario: Return to goal list
- **WHEN** the user presses b or escape from the detail view
- **THEN** the system returns to the goal list without changing goal state

#### Scenario: Width-safe detail rendering
- **WHEN** the detail view is rendered in a narrow terminal
- **THEN** every rendered line fits within the available width and long values are truncated or wrapped safely

#### Scenario: Show full status snapshot from selected goal
- **WHEN** the user opens the selected goal detail view
- **THEN** the system includes all fields from `/goal status <goal-id>` (type, state, summary, next check, latest progress, last run, pending decision count, worktree) in a consistent read-only snapshot

#### Scenario: Inspect run history and validation output
- **WHEN** the selected goal has run history
- **THEN** detail view includes the latest run summary and its validation results (command, status, and optional output summary) when available

#### Scenario: Open associated repository/path hints
- **WHEN** the selected goal includes repository metadata
- **THEN** the detail view includes the PR/worktree URL or path context in a readable form to aid navigation

### Requirement: Refresh modal state
The system SHALL allow users to refresh the modal's view of persisted goal state without triggering worker execution.

#### Scenario: Refresh from list
- **WHEN** the user presses r in the goal list
- **THEN** the system reloads goals from the goal store and updates the displayed list

#### Scenario: Refresh from detail
- **WHEN** the user presses r in the detail view
- **THEN** the system reloads the selected goal from the goal store and updates the displayed details

#### Scenario: Refresh does not run scheduler
- **WHEN** the user refreshes the modal
- **THEN** the system does not launch workers or modify goal schedules solely due to refresh

### Requirement: Lifecycle actions from detail view
The system SHALL expose valid lifecycle actions from the selected goal detail view and SHALL update the modal after each action.

#### Scenario: Pause active goal
- **WHEN** the selected goal is active or failed and the user chooses pause
- **THEN** the system sets the selected goal state to paused and refreshes the detail view

#### Scenario: Resume paused goal
- **WHEN** the selected goal is paused and the user chooses resume
- **THEN** the system sets the selected goal state to active and refreshes the detail view

#### Scenario: Hide invalid lifecycle actions
- **WHEN** an action is invalid for the selected goal state
- **THEN** the system does not advertise that action as available in the detail-view help text

#### Scenario: Confirm cancellation
- **WHEN** the user chooses cancel for a cancellable goal
- **THEN** the system displays a confirmation prompt before changing the goal state

#### Scenario: Cancel after confirmation
- **WHEN** the user confirms cancellation
- **THEN** the system sets the selected goal state to cancelled and refreshes the modal

#### Scenario: Abort cancellation
- **WHEN** the user rejects or escapes the cancellation confirmation
- **THEN** the system leaves the selected goal state unchanged and returns to the detail view

### Requirement: Pending decisions from TUI
The system SHALL support pending-decision awareness and answering from the interactive view.

#### Scenario: Navigate to pending decisions from goal detail
- **WHEN** the selected goal has pending decisions
- **THEN** the system shows a decision summary count and allows opening the pending list in the TUI

#### Scenario: Answer pending decision from TUI
- **WHEN** the user selects a pending decision and chooses a valid option
- **THEN** the system submits the same answer payload as `/goal answer` and refreshes modal state without launching workers

#### Scenario: Answer pending decision safely
- **WHEN** the user submits an invalid decision id or option
- **THEN** the system reports the error and leaves goal state unchanged

### Requirement: Run selected goal now
The system SHALL allow users to run scheduler-compatible processing for the selected goal immediately when that goal is eligible.

#### Scenario: Run active goal now
- **WHEN** the selected goal is eligible for execution and the user chooses run now
- **THEN** the system schedules or invokes immediate scheduler processing for that selected goal using the normal scheduler behavior

#### Scenario: Run now respects no-action result
- **WHEN** run now observes no actionable work for the selected goal
- **THEN** the system updates the goal according to normal no-action scheduler policy and does not force-launch a worker

#### Scenario: Run now disabled for running goal
- **WHEN** the selected goal is already running
- **THEN** the system does not advertise run now as available and does not start another worker for that goal

### Requirement: Trigger scheduler tick
The system SHALL expose a direct way to trigger scheduler evaluation from the goal manager without leaving the modal.

#### Scenario: Manual tick from TUI
- **WHEN** the modal is open and the user triggers a tick action
- **THEN** the system runs the scheduler path used by `/goal tick`/`pi-goal-runner tick` and updates the modal summary output

#### Scenario: Tick behavior parity
- **WHEN** user triggers a tick from TUI
- **THEN** the modal observes the same launch/no-op/skip/failure semantics and output shape as text `/goal tick`

### Requirement: List filtering and sorting
The system SHALL support filtering and sorting the list without requiring CLI commands.

#### Scenario: Filter goals by state
- **WHEN** the user applies a state filter in the goal list
- **THEN** only goals in selected states are shown while preserving selection where possible

#### Scenario: Sort goals in list
- **WHEN** the user chooses a sort order
- **THEN** the list re-renders using a deterministic order by state, next check, and id

### Requirement: Preserve text command behavior
The system SHALL preserve existing `/goal` text commands and CLI behavior while adding the interactive modal.

#### Scenario: Existing status command still works
- **WHEN** the user runs `/goal status <goal-id>`
- **THEN** the system returns the text status output for that goal

#### Scenario: Existing lifecycle command still works
- **WHEN** the user runs an existing lifecycle text command such as `/goal pause <goal-id>`
- **THEN** the system performs the lifecycle action and returns text output as before

### Requirement: Non-interactive fallback
The system SHALL fail safely when the interactive goal manager is requested without an interactive Pi UI.

#### Scenario: TUI requested without UI support
- **WHEN** the user opens the interactive goal manager in a context that cannot display custom TUI components
- **THEN** the system reports that interactive goal management requires an interactive Pi session and does not mutate goal state
