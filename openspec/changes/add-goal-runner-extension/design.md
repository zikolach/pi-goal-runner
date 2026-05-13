## Context

Pi supports extensions, session lifecycle events, local commands, session replacement commands, custom tools, and subprocess-based subagent examples. Those primitives are enough to build recurring automation, but Pi does not provide a durable goal scheduler out of the box.

The target use case is a recurring objective such as: "watch PR #41, address review comments/check failures when they appear, keep polling with backoff, and stop after no actionable feedback has appeared for a quiet window." This work should not occupy the user's main interactive Pi session, and it should not rely on implicit chat memory.

## Goals / Non-Goals

**Goals:**

- Provide a Pi package/extension that manages durable automation goals.
- Support a first goal type for GitHub PR review loops.
- Keep goal memory in structured state rather than relying on an LLM transcript.
- Run actual agent work in isolated subprocesses and dedicated git worktrees.
- Stream progress, completion, failures, and decision requests back through structured events.
- Let an active Pi session inspect goals and answer pending decisions.
- Allow optional notification adapters, including PiRelay, to surface high-signal events.

**Non-Goals:**

- Replacing Pi's built-in session model or adding core Pi scheduler APIs.
- Building a hosted service.
- Running untrusted project-local agents without explicit user approval.
- Persisting full LLM transcripts, secrets, bot tokens, or arbitrary subprocess stdout forever.
- Guaranteeing execution while the host machine is asleep or offline.

## Decisions

### Store goal state outside the transcript

Goal state SHALL live in a durable state directory, for example `~/.pi/agent/goals/<goal-id>/state.json` plus append-only `events.jsonl`.

Rationale: recurrence/backoff/quiet-window behavior must survive Pi restarts and should be inspectable without replaying an LLM chat. The transcript can contain summaries, but it is not the scheduler source of truth.

### Use explicit context seeding for each worker run

Each worker subprocess receives a generated prompt containing the goal definition, current observed state, previous run summary, relevant repository/PR metadata, and stop criteria.

Rationale: explicit context prevents stale implicit memory and makes runs reproducible. It also allows a fresh subprocess/session to perform useful work without occupying the main session.

### Execute in isolated worktrees

Goals that modify repositories SHALL run in a dedicated git worktree and acquire a goal lock before writing.

Rationale: scheduled agents must not dirty the user's main working tree or race with a manual Pi session. Worktrees also make cleanup and rollback clearer.

### Communicate through structured events

Worker subprocesses SHALL emit JSONL events such as `progress`, `decision`, `complete`, and `failure`. The supervisor writes those events to durable state and forwards selected events to active UI/notification sinks.

Rationale: stdout text is easy for subprocesses, but free-form logs are hard to automate. A minimal event protocol makes progress widgets, messenger notifications, and decision waits deterministic.

### Separate scheduler from worker

A scheduler/supervisor decides whether a goal is due and actionable. A worker agent only runs when the scheduler has observed a reason to act.

Rationale: polling GitHub is cheap and deterministic; LLM work is expensive and should be launched only when necessary.

### Human decisions are durable requests

When a worker needs input, it writes a pending decision record and exits or blocks according to goal policy. Users answer through local Pi commands or an optional notification bridge.

Rationale: the user may not have Pi open when the decision is requested. Durable decisions make the system robust across restarts and remote notifications.

### Prefer `gh` CLI for GitHub integration first

The PR watcher should use `gh` CLI/API for authentication and GitHub operations before adding runtime npm dependencies.

Rationale: users already configure `gh` for repository work, and it avoids storing additional secrets in goal-runner state.

## Risks / Trade-offs

- **Subprocess can modify files unexpectedly** → Run in a dedicated worktree, hold a lock, and require explicit goal configuration.
- **Goal loops can run forever** → Require quiet-window, max-attempt, cancellation, and backoff policies.
- **LLM may over-act on stale observations** → Scheduler passes fresh observations and requires worker to re-check before push/reply/resolve.
- **Decision requests can be missed** → Persist pending decisions and expose `/goal decisions` plus optional PiRelay notification.
- **Multiple Pi instances can race** → Use filesystem locks around state updates and worker execution.
- **Secrets can leak into state** → Store only redacted summaries, metadata, timestamps, event types, and short safe messages.

## Migration Plan

1. Create the package skeleton, extension entrypoint, and state directory helpers.
2. Add local goal commands with no worker execution.
3. Add durable scheduler/backoff state and event log.
4. Add subprocess execution with JSONL event ingestion.
5. Add GitHub PR review goal observation and worker prompt generation.
6. Add optional PiRelay notification sink.

Rollback is straightforward before publishing: remove the package/extension and delete the goal state directory. Goal worktrees are separate and can be removed manually.

## Open Questions

- Should scheduled execution be driven by a long-lived Node daemon, by a Pi extension timer while Pi is open, or both?
- Should the first implementation use `pi --print`, `pi --mode rpc`, or the subagent example as the worker transport?
- What default quiet window is best for PR review goals: 30 minutes, 2 hours, or user-specified only?
- Should automatic push/reply/resolve be opt-in per goal, or enabled by default for review-loop goals?
