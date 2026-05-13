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
```

`/goal watch-pr` validates GitHub authentication and PR metadata through `gh`. The scheduler observes review threads and checks before launching a worker.

## Security model

- Goal state is stored outside the LLM transcript under `~/.pi/agent/goals` by default.
- State contains structured summaries, timestamps, decisions, and run metadata. It must not contain credentials, bot tokens, or full transcripts.
- Subprocess workers run with your local user permissions.
- Repository-mutating goals use a dedicated git worktree recorded in the goal state.
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

Worker execution uses `pi --print` by default and sends the explicit goal prompt on stdin. Override with:

```bash
PI_GOAL_WORKER_COMMAND=pi
PI_GOAL_WORKER_ARGS="--print"
```

## Notifications and PiRelay hook

By default notifications are no-op. To integrate with PiRelay or another messenger bridge, provide a command that reads JSON from `PI_GOAL_NOTIFICATION` or stdin:

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
openspec validate add-goal-runner-extension --strict
```
