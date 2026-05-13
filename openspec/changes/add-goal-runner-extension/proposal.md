## Why

Pi users need a way to pursue recurring goals such as watching a PR for new review feedback, addressing comments, and retrying until the goal has been quiet for a configured period without occupying or contaminating the main interactive session. Ad-hoc reminders and long-lived chat context are not durable enough for backoff, resumability, decisions, and progress reporting.

## What Changes

- Introduce a Pi goal-runner extension/package that manages durable recurring automation goals.
- Add local commands to create, list, inspect, pause/resume, cancel, and answer goal decisions.
- Store goal state outside the LLM transcript, including schedule/backoff state, last observed external timestamps, run history summaries, and pending decisions.
- Execute goal work in isolated subprocesses and dedicated git worktrees so the main Pi session remains free and clean.
- Seed each subprocess with explicit goal context instead of relying on implicit main-session memory.
- Stream structured subprocess progress, completion, failure, and decision-request events back to durable state and any active Pi UI.
- Support an initial GitHub PR review watcher goal that polls PR review threads/checks and launches a worker only when actionable.
- Provide notification integration points so PiRelay or future messengers can surface high-signal progress and decision requests.
- No breaking changes to Pi or PiRelay are required.

## Capabilities

### New Capabilities

- `goal-state-management`: Durable goal records, run history, locking, backoff, quiet-window completion, and local goal commands.
- `goal-subprocess-execution`: Isolated subprocess/worktree execution with explicit context seeding and structured event ingestion.
- `goal-decision-protocol`: Human decision requests and answers across CLI, active Pi UI, durable state, and optional messenger notifications.
- `github-pr-review-goals`: Built-in recurring goal type for checking and addressing GitHub PR review comments/check failures until quiet.

### Modified Capabilities

None.

## Impact

- New project under `/Users/user/Projects/pi-goal-runner` packaged as a Pi extension/package.
- Affected systems: Pi extension APIs, local filesystem state, subprocess management, git worktrees, GitHub CLI/API, optional PiRelay notification bridge.
- Runtime dependencies should remain minimal; prefer Node built-ins and `gh` CLI for GitHub operations before adding npm dependencies.
- Security considerations: subprocesses run with local user permissions; project-local agent prompts require explicit trust; goal state must not persist secrets, full transcripts, or bot tokens.
