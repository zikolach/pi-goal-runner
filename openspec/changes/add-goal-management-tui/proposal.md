## Why

Goal runner currently exposes durable PR automation primarily through text commands and a small status indicator. As goals become long-lived and recoverable, users need a faster interactive way to inspect goal state, choose a goal, and perform common lifecycle actions without remembering command syntax or copying IDs.

## What Changes

- Add an interactive modal TUI for goal management, opened from Pi with a dedicated command such as `/goals` and/or `/goal ui`.
- Show goals in a navigable list with concise tabular summary information: state, id, target/summary, next check, and pending-decision/run hints.
- Allow keyboard navigation with up/down, enter to view a selected goal, refresh, and escape/q to close.
- Add a selected-goal detail view with nicely formatted metadata, latest progress, last run summary, pending decisions, and valid action hints.
- Support safe lifecycle actions from the detail view: pause/resume, cancel with confirmation, and run/trigger now through scheduler-compatible behavior.
- Add direct in-TUI equivalents for text-only operations, including status snapshots, pending decision inspection/answering, manual scheduler tick, and detailed run-history/validation views.
- Add list-level filtering/sorting controls to narrow large goal sets by state, urgency, and id ordering.
- Surface goal metadata paths/links (PR URL and worktree path) as first-class, quick-reference detail fields.
- Preserve existing `/goal ...` text command behavior and CLI behavior.

## Capabilities

### New Capabilities
- `goal-management-tui`: Interactive modal UI for listing, inspecting, and managing durable goals inside Pi.

### Modified Capabilities
- None.

## Impact

- Affects the Pi extension entrypoint (`src/extension.ts`) by registering an interactive goal-management command.
- Adds TUI component code for list/detail/confirmation modal behavior.
- May introduce runtime usage of Pi TUI components/utilities such as `SelectList`, keyboard matching, and ANSI-safe truncation.
- Adds or refactors shared goal operation helpers so CLI/text commands and TUI actions share pause/resume/cancel/run-now behavior.
- Adds tests for action enablement, formatting, and operations while keeping existing goal-runner tests passing.
- Updates README usage documentation for the interactive goal manager.
