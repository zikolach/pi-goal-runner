# pi-goal-runner

Durable recurring automation goals for [Pi](https://pi.dev), starting with GitHub PR review loops.

## Install

```bash
pi install git:github.com/zikolach/pi-goal-runner
# or for local development
pi -e /path/to/pi-goal-runner
```

The package registers a `/goal` Pi command and a `pi-goal-runner` CLI after build/install.

## Commands

```text
/goal list
/goal status <goal-id>
/goal pause <goal-id>
/goal resume <goal-id>
/goal cancel <goal-id>
/goal decisions
/goal answer <decision-id> <choice>
/goal watch-pr <owner/repo|url> <pr-number|url> [--quiet-ms N] [--validation "npm test"] [--auto-resolve]
/goal tick
/goal ui
/goals
```

`/goal watch-pr` validates GitHub authentication and PR metadata through `gh`. The scheduler observes review threads and checks before launching a worker.

## Interactive Goal Manager

`/goals` opens a modal, table-style goal manager in interactive Pi sessions. `/goal ui` is also supported as an alias.

Keybindings:
- `↑` / `↓`: navigate goal list
- `enter`: open selected goal detail
- `q` / `esc`: close modal from list
- `b` / `esc`: return to list from detail
- `r`: refresh goals (list or selected detail)
- `p`: pause/resume selected goal
- `c`: request cancel (requires confirmation)
- `n`: run selected goal now
- `y` / `enter`: confirm cancel
- `n` / `esc`: abort cancel confirmation

Action availability is state-aware (for example, running/cancelled/completed goals do not expose pause/resume/run actions that are invalid in those states).

## Architecture

`pi-goal-runner` is intended to run durable fuzzy goals: a user describes a desired ongoing outcome, the scheduler periodically reconsiders that goal, and an AI worker decides whether it can make useful progress. GitHub PR review follow-up is the first built-in goal type, not the whole architecture.

```text
/goal command, Pi timer, or CLI daemon
              │
              ▼
┌────────────────────────────┐
│ Durable goal store         │
│ state.json + events.jsonl  │
└─────────────┬──────────────┘
              │ due goals
              ▼
┌────────────────────────────┐
│ Scheduler                  │
│ when to reconsider a goal  │
└─────────────┬──────────────┘
              │ adapter request
              ▼
┌────────────────────────────┐
│ Goal adapter               │
│ GitHub PR review today;    │
│ more goal types later      │
└─────────────┬──────────────┘
              │ worker inputs
              ▼
┌────────────────────────────┐
│ AI worker subprocess       │
│ attempts progress or asks  │
│ for a decision             │
└─────────────┬──────────────┘
              │ JSONL events
              ▼
┌────────────────────────────┐
│ Durable goal store         │
└────────────────────────────┘
```

The core loop is deliberately small:

```text
scheduler tick
  ├─ skip goals that are paused, terminal, locked, waiting, or not due
  ├─ collect current context for each due goal
  ├─ decide whether useful work is possible now
  ├─ launch a worker when action is warranted
  ├─ record progress, decisions, completions, or failures as events
  └─ reschedule with backoff, wait for a decision, or mark the goal quiet/complete
```

The scheduler is intentionally adapter-driven internally. Core code owns durable lifecycle concerns such as due checks, locks, decisions, backoff, event persistence, notifications, and worker subprocess handling. Goal adapters own goal-type-specific behavior such as external observation, actionability, prompt construction, workspace preparation details, completion side effects, and display metadata. The only built-in adapter today is GitHub PR review; this package does not yet expose a public third-party plugin API.

### Current implementation map

| Layer | Modules | Notes |
| --- | --- | --- |
| Entrypoints | `src/extension.ts`, `src/cli.ts` | Pi `/goal` command, session timer, and `pi-goal-runner tick/daemon`. |
| Durable state | `src/state/*` | One directory per goal under `~/.pi/agent/goals` by default, with atomic state writes, event logs, path validation, and locks. |
| Scheduling policy | `src/scheduler.ts`, `src/policy.ts` | Due-goal selection, backoff, quiet windows, lock handling, and failure recovery. |
| Goal adapters | `src/adapters/*`, `src/github/*` | Internal adapter boundary and first concrete adapter for GitHub PR review goals. |
| Worker protocol | `src/worker/*` | Prompt construction, optional worktree setup, subprocess launch, bounded stdout ingestion, and JSONL event handling. |
| Decisions | `src/decisions.ts` | Durable pending questions that can be answered later with `/goal answer`. |
| Notifications | `src/notifications.ts` | Best-effort notifications that never determine core goal health. |
| GitHub PR adapter | `src/github/*` | First concrete adapter: observe review threads/checks, build PR-review context, and optionally reply/resolve addressed threads. |

### Worker event protocol

Workers report state changes through newline-delimited JSON events on stdout:

- `progress`: human-readable status update
- `decision`: durable question for the user before continuing
- `complete`: successful, quiet, or stale completion summary
- `failure`: retryable or terminal failure information

Events are appended to `events.jsonl` before being folded into `state.json`, so the event log remains useful for debugging even after daemon restarts or worker failures.

### About the GitHub PR focus

The repository currently contains PR-specific fields and modules because GitHub PR review follow-up was the first concrete use case. The intended direction is to keep extracting generic goal-runner behavior into the core and leave PR review logic in a replaceable adapter layer.

## Security model

- Goal state is stored outside the LLM transcript under `~/.pi/agent/goals` by default.
- State contains structured summaries, timestamps, decisions, and run metadata. It must not contain credentials, bot tokens, or full transcripts.
- Subprocess workers run with your local user permissions.
- Repository-mutating goals use an isolated git worktree recorded in the goal state by default; same-path execution must be explicitly configured in goal metadata.
- Automatic GitHub reply/resolve is opt-in with `--auto-resolve` and requires pushed commit evidence from a worker completion event.
- Notification sinks are optional; failures are recorded as nonfatal events and decisions remain pending.

## Scheduler modes

While Pi is open, the extension starts a lightweight timer (default 60s) and runs scheduler ticks. Configure with:

```bash
PI_GOAL_RUNNER_INTERVAL_MS=60000
PI_GOAL_RUNNER_DRY_RUN=1 # observe and mark launch intent without spawning workers
```

Outside Pi, run:

```bash
npm run build
pi-goal-runner daemon
# or one tick
pi-goal-runner tick
```

### Worker worktrees

GitHub PR workers are prepared in per-goal linked worktrees under the state root, for example `~/.pi/agent/goals/worktrees/<goal-id>`. These worktrees are checked out in detached HEAD mode at the observed PR head (or a safe local revision when the observed SHA is unavailable). Detached checkout avoids Git's "branch already checked out" restriction and keeps daemon-triggered edits away from your active repository checkout.

The worker prompt carries push-target metadata separately from checkout state: repository owner/name, push remote, target PR branch, current worktree path, and checked-out head SHA. When a worker fixes a PR from detached HEAD, it is instructed to push with `git push <remote> HEAD:<branch>` without force by default and to report the pushed commit SHA in its completion event.

Completed worker changes are not copied back into your original checkout. The handoff is remote-first: isolated worker worktree → remote PR branch → your local checkout when you explicitly fetch or pull. For example, after a successful worker run you can update a local PR branch with `git fetch origin && git switch <branch> && git pull --ff-only`, or update `main` after the PR merges with `git switch main && git pull --ff-only`. This keeps daemon-triggered edits from overwriting or mixing with local human work.

Reusable isolated worktrees are refreshed before launch. If an isolated worktree contains uncommitted tracked or untracked files, the scheduler records a retryable failure instead of resetting or deleting those changes. If a stored worktree path points at the user's active checkout, it is migrated back to the managed per-goal worktree on the next run unless the goal explicitly opts into `same_path` mode. Manual cleanup can use normal Git commands such as `git worktree list`, `git worktree remove <path>`, and `git worktree prune`.

Worker execution uses `pi --print` by default and sends the explicit goal prompt on stdin. Override with:

```bash
PI_GOAL_WORKER_COMMAND=pi
PI_GOAL_WORKER_ARGS="--print"
```

## Notifications and PiRelay hook

By default notifications are no-op. To integrate with PiRelay or another messenger bridge, provide a command that reads JSON from the file path in the `PI_GOAL_NOTIFICATION_FILE` environment variable:

```bash
PI_GOAL_NOTIFY_COMMAND=/path/to/notify-script
# or
PIRELAY_NOTIFY_COMMAND=/path/to/pirelay-notify
```

Decision requests remain durable even when notification delivery fails.

## Development

```bash
npm install
npm run typecheck
npm test
npm run openspec:validate
```
