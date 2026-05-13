## ADDED Requirements

### Requirement: Workers can request human decisions
The system SHALL support durable human decision requests emitted by worker subprocesses.

#### Scenario: Worker requests a decision
- **WHEN** a worker emits a decision event with id, prompt, options, and optional timeout
- **THEN** the supervisor stores a pending decision in the goal state
- **AND** exposes it to local Pi commands and notification sinks

#### Scenario: Decision prompt contains unsafe content
- **WHEN** a decision prompt includes suspected secrets or excessive output
- **THEN** the system redacts and truncates the prompt before persisting or displaying it

### Requirement: Users can answer decisions locally
The Pi extension SHALL provide local commands for viewing and answering pending decisions.

#### Scenario: User lists pending decisions
- **WHEN** the user runs `/goal decisions`
- **THEN** the system lists pending decisions with goal id, decision id, concise prompt, and valid choices

#### Scenario: User answers a decision
- **WHEN** the user runs `/goal answer <decision-id> <choice>`
- **THEN** the system validates the choice against the pending decision
- **AND** writes the answer durably for the waiting worker or next scheduler pass

#### Scenario: Invalid decision answer
- **WHEN** the user answers an unknown decision id or invalid choice
- **THEN** the system leaves goal state unchanged
- **AND** reports a safe actionable error

### Requirement: Decisions can be surfaced through optional notifications
The system SHALL allow notification sinks to surface decision requests without requiring the main Pi session to be open.

#### Scenario: PiRelay sink is configured
- **WHEN** a goal enters `needs_decision` state and PiRelay notification is configured
- **THEN** the system sends a concise decision request to the paired messenger destination
- **AND** includes instructions for answering through the supported command surface

#### Scenario: Notification sink fails
- **WHEN** a decision notification cannot be delivered
- **THEN** the system records the notification failure as a nonfatal event
- **AND** keeps the decision pending in durable state

### Requirement: Worker execution respects unresolved decisions
The scheduler SHALL not continue work that requires an unanswered decision.

#### Scenario: Goal has pending decision
- **WHEN** a scheduled check runs for a goal with an unanswered required decision
- **THEN** the scheduler does not launch a new worker for that goal
- **AND** reports that the goal is waiting for user input

#### Scenario: Decision is answered
- **WHEN** a required decision is answered
- **THEN** the scheduler considers the goal eligible for the next run immediately or at the configured next check time
