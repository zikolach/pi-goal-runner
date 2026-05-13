## ADDED Requirements

### Requirement: Users can create GitHub PR review goals
The system SHALL allow users to create recurring goals that monitor a GitHub pull request and address actionable review or check feedback.

#### Scenario: PR review goal is created
- **WHEN** the user runs `/goal watch-pr <repo-or-url> <pr-number-or-url>` with schedule options
- **THEN** the system validates the repository and PR using GitHub CLI/API
- **AND** creates a durable goal record with repository, PR number, branch, quiet-window policy, and backoff policy

#### Scenario: GitHub authentication is unavailable
- **WHEN** the user creates a PR review goal but GitHub CLI authentication is missing or insufficient
- **THEN** the system refuses to create the active goal
- **AND** reports safe setup guidance without storing credentials

### Requirement: PR goals observe review threads and checks before launching workers
The scheduler SHALL poll GitHub state cheaply and launch workers only when actionable changes are present.

#### Scenario: No new feedback exists
- **WHEN** the PR has no unresolved review threads, no new comments, and checks are passing or unchanged
- **THEN** the scheduler updates observation timestamps and applies quiet/backoff policy
- **AND** does not launch an LLM worker

#### Scenario: New unresolved review thread exists
- **WHEN** the scheduler observes an unresolved non-outdated review thread newer than the last handled observation
- **THEN** it marks the goal actionable
- **AND** prepares a worker run with thread ids, comment ids, paths, and safe comment bodies

#### Scenario: Checks fail
- **WHEN** the scheduler observes failing required checks or newly failed workflow jobs
- **THEN** it marks the goal actionable
- **AND** includes relevant check names, URLs, and failure summaries in the worker context

### Requirement: PR review workers follow the review-fix loop
The worker prompt for a PR review goal SHALL require verification, scoped fixes, validation, push, replies, and thread resolution.

#### Scenario: Worker addresses review comments
- **WHEN** a worker receives unresolved review thread context
- **THEN** it verifies each comment against current code before editing
- **AND** fixes only comments that are still true and within the goal scope

#### Scenario: Worker pushes fixes
- **WHEN** the worker implements fixes successfully
- **THEN** it runs configured validation, commits with a concise conventional commit, and pushes to the PR branch
- **AND** emits structured completion details including commit sha and validation results

#### Scenario: Worker needs user decision
- **WHEN** the worker determines that a review comment requires broad redesign, risky behavior, or user preference
- **THEN** it emits a decision event instead of guessing
- **AND** does not resolve the related thread until a decision is answered and a fix is pushed

### Requirement: PR goals update GitHub after successful fixes
The system SHALL reply to and resolve addressed review threads only after fixes are committed and pushed.

#### Scenario: Addressed thread is pushed
- **WHEN** a worker has pushed a commit that addresses a review thread
- **THEN** the system replies to the parent review comment with the commit sha and validation evidence
- **AND** resolves the GitHub review thread

#### Scenario: Comment is stale or already addressed
- **WHEN** the worker verifies that an unresolved comment is stale, outdated, or already addressed on current HEAD
- **THEN** it replies with evidence
- **AND** may resolve the thread according to policy without making code changes

### Requirement: PR goals stop after quiet period
The system SHALL stop or suspend PR review goals after the configured quiet window with no actionable feedback.

#### Scenario: PR remains quiet
- **WHEN** the PR has no actionable review/check feedback for the configured quiet duration
- **THEN** the goal transitions to completed or dormant state according to configuration
- **AND** emits a final summary event

#### Scenario: Feedback appears before quiet window expires
- **WHEN** new actionable feedback appears before the quiet window expires
- **THEN** the goal remains active
- **AND** launches or schedules a worker run according to backoff and lock policy
