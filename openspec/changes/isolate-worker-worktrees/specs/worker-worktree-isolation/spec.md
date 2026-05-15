## ADDED Requirements

### Requirement: Workers use isolated worktrees by default
The system SHALL run repository-mutating workers in an isolated git worktree by default instead of the user's active checkout.

#### Scenario: PR branch is already checked out in main worktree
- **WHEN** a GitHub PR goal targets a branch that is already checked out in the user's main worktree
- **THEN** the system creates or reuses an isolated worker worktree without checking out that branch as an attached branch
- **AND** it does not fail with Git's branch-already-checked-out error

#### Scenario: Existing goal points to user checkout
- **WHEN** an existing goal's stored worktree path is the same as the user's active checkout
- **THEN** the system migrates or replaces that workspace with an isolated worker worktree before launching a repository-mutating worker
- **AND** it does not mutate the user's active checkout by default

#### Scenario: Isolated worktree creation fails
- **WHEN** the system cannot create or refresh an isolated worker worktree
- **THEN** it records a retryable, actionable failure
- **AND** it does not silently fall back to mutating the user's active checkout

### Requirement: Detached checkout preserves PR push target
The system SHALL separate the worker checkout state from the PR branch push target.

#### Scenario: Detached worker worktree is prepared
- **WHEN** the system prepares an isolated worktree for a GitHub PR goal
- **THEN** the worktree is checked out at the observed PR head or another safe detached revision
- **AND** the goal or prompt metadata includes the remote owner, repository, target branch, and expected push destination

#### Scenario: Worker needs to push a fix
- **WHEN** a worker commits a fix from a detached worker worktree
- **THEN** the worker prompt provides enough information to push the commit to the PR branch without relying on the detached checkout having a local branch checked out

#### Scenario: Completion reports pushed commit evidence
- **WHEN** the worker reports successful completion after pushing from an isolated worktree
- **THEN** the completion event includes commit evidence suitable for auto-reply and resolve behavior

### Requirement: Reused worker worktrees are refreshed safely
The system SHALL refresh reusable isolated worktrees to the observed PR head before launching workers and SHALL protect dirty worktrees from destructive resets.

#### Scenario: Clean isolated worktree is reused
- **WHEN** an isolated worker worktree already exists and is clean
- **THEN** the system fetches the relevant remote and resets or checks out the observed PR head before launching the worker

#### Scenario: Isolated worktree is dirty before launch
- **WHEN** an isolated worker worktree contains uncommitted tracked or untracked changes before worker launch
- **THEN** the system fails safely with an actionable message
- **AND** it does not delete, reset, or overwrite those changes automatically

#### Scenario: Missing linked worktree metadata
- **WHEN** a stored worker worktree path is missing or no longer a valid git worktree
- **THEN** the system recreates the isolated worktree when safe or records a clear retryable failure

### Requirement: User checkout remains protected
The system SHALL protect the user's active checkout from automated worker mutations.

#### Scenario: User has uncommitted local changes
- **WHEN** the user's active checkout contains uncommitted or untracked local files
- **AND** a goal worker is due
- **THEN** isolated worker execution proceeds or fails based on the isolated worktree state only
- **AND** the user's local changes are not used as a reason to stop the worker unless the goal explicitly opted into same-path execution

#### Scenario: Same-path execution is explicitly configured
- **WHEN** a goal is explicitly configured to use the user's active checkout
- **THEN** the system may run existing dirty-check safeguards against that checkout
- **AND** the goal status or diagnostics make clear that same-path execution is in use
