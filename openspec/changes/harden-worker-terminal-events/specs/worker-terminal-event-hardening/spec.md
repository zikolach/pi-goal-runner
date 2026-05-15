## ADDED Requirements

### Requirement: Terminal worker events are authoritative
The system SHALL treat the first successfully ingested terminal worker protocol event for a run as authoritative over later subprocess close status.

#### Scenario: Complete followed by non-zero exit
- **WHEN** a worker emits a valid `complete` event that is persisted successfully
- **AND** the worker process later exits with a non-zero code
- **THEN** the goal remains in the state produced by the `complete` event
- **AND** the run remains recorded as successful, quiet, or stale according to that `complete` event

#### Scenario: Decision followed by non-zero exit
- **WHEN** a worker emits a valid `decision` event that is persisted successfully
- **AND** the worker process later exits with a non-zero code
- **THEN** the goal remains waiting for the pending decision
- **AND** the process exit does not change the goal to failed

#### Scenario: Failure followed by zero exit
- **WHEN** a worker emits a valid `failure` event that is persisted successfully
- **AND** the worker process later exits with code zero
- **THEN** the emitted worker failure remains the run outcome
- **AND** the process close does not synthesize a success or second failure outcome

### Requirement: Late process errors are diagnostic after terminal events
The system SHALL record post-terminal subprocess errors as diagnostics rather than terminal state transitions.

#### Scenario: Stale extension context error after completion
- **WHEN** a worker emits a valid successful `complete` event
- **AND** stderr later contains a stale extension context error before the process exits non-zero
- **THEN** the system records at most a bounded diagnostic event for the late process error
- **AND** the goal state, run status, backoff, and next check are not overwritten by that late error

#### Scenario: Diagnostic write fails after completion
- **WHEN** a worker has already persisted a terminal event
- **AND** recording the late process diagnostic fails
- **THEN** the system still resolves the worker launch using the already persisted terminal state

### Requirement: Missing terminal events remain failures
The system SHALL continue to fail workers that exit or time out without a successfully ingested terminal protocol event.

#### Scenario: Non-zero exit without terminal event
- **WHEN** a worker process exits with a non-zero code without a successfully ingested terminal event
- **THEN** the system records a retryable failure containing a redacted exit reason
- **AND** the goal is scheduled according to retry backoff

#### Scenario: Zero exit without terminal event
- **WHEN** a worker process exits with code zero without a successfully ingested terminal event
- **THEN** the system records a retryable failure explaining that no terminal event was emitted

#### Scenario: Timeout without terminal event
- **WHEN** a worker process times out before a terminal event is successfully ingested
- **THEN** the system records a timeout failure and schedules retry according to backoff
