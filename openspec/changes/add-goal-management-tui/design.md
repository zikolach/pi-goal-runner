## Context

The goal runner currently provides durable automation through text commands handled by `handleGoalCommand()` and an extension command registered as `/goal`. The extension also maintains a lightweight status indicator and a pending-decision widget. This works for scripting and quick status checks, but it is cumbersome for interactive management because users must remember subcommands and copy goal IDs.

Pi supports command-scoped custom TUI components through `ctx.ui.custom()`, including keyboard handling, themed rendering, and components such as `SelectList`. The goal manager can therefore live inside the existing extension without changing the persisted goal schema.

The TUI must respect the existing goal state model and scheduler semantics. It should not bypass durable state transitions or launch workers through a separate path.

## Goals / Non-Goals

**Goals:**

- Provide a modal, keyboard-driven goal manager for Pi interactive sessions.
- Show a concise goal list and a formatted selected-goal detail view.
- Support safe lifecycle actions from the detail view: pause/resume, cancel with confirmation, and run now.
- Add in-TUI equivalents for high-value command flows: status inspection, pending-decision answering, manual tick trigger, richer run-history visibility, list filtering/sorting, and quick navigation metadata links.
- Reuse shared goal operations so text commands and TUI actions do not drift.
- Keep the feature bounded and compatible with existing CLI and daemon behavior.

**Non-Goals:**

- Full-screen dashboard or continuously live-updating event monitor.
- Editing goal configuration such as quiet window, validation commands, or repository metadata.
- Creating new goals through the TUI.
- Killing or interrupting an already-running worker process.
- Replacing the existing `/goal` text command surface.

### Functional Enhancements for the Interactive Manager

- **Status parity:** detail rows should present all fields returned by `/goal status` in a compact layout for fast read-only inspection.
- **Decision flow:** if pending decisions exist, the selected goal detail should expose them with a way to select and answer from the modal.
- **Manual tick:** list and detail views should include an action to trigger one scheduler tick equivalent to `/goal tick` semantics.
- **Run history depth:** in addition to “last run summary”, the modal should expose the latest run validation outcomes and any summary output for debugging.
- **List ergonomics:** add filters and sort mode toggle (state, next check, id, status/validity) to reduce terminal traversal for many goals.
- **Target navigation context:** show PR/worktree URL/path in detail in clear text so operators can quickly jump using copy/paste.

## Decisions

### Modal first, not full dashboard

Use a command-scoped modal opened with `/goals` and optionally `/goal ui`. The initial modal has two primary views: list and detail. This keeps interaction predictable and avoids long-lived UI context ownership.

Alternatives considered:
- Full two-pane dashboard: richer, but more rendering complexity and less necessary for first use.
- Command-palette-only actions: fast, but weaker for understanding state and less discoverable.

### Shared operations layer for lifecycle actions

Extract or introduce small shared operations for pause, resume, cancel, and run-now behavior. The existing text command adapter should call these operations, and the TUI should call the same operations directly.

Rationale: Text command parsing should remain an adapter. Business behavior belongs in testable functions that do not depend on UI formatting.

### Run now means scheduler-compatible observation

The TUI `run now` action sets the selected goal up for immediate scheduling and invokes scheduler behavior for that goal in the same semantic path used by normal ticks. It must not force-launch a worker when the PR has no actionable feedback.

Rationale: The scheduler already owns observation, quiet-window policy, locks, worktree setup, and worker launch rules. The TUI should trigger that machinery rather than duplicate it.

### Confirmation for destructive actions

Cancel requires an explicit confirmation view. Pause/resume and run-now can execute immediately because they are reversible or non-destructive.

### TUI rendering remains data-driven and width-safe

The component should render from `GoalRecord` snapshots, truncate lines with ANSI-safe utilities, and refresh from `GoalStore` after every action. It should call `tui.requestRender()` after state changes.

### Command-scoped context only

The modal must not store command/session contexts beyond its `ctx.ui.custom()` lifecycle. Background interval behavior remains separate from this change, except that the TUI should not add new long-lived context captures.

## Risks / Trade-offs

- **Action semantics can surprise users** → Use clear labels: `refresh` only reloads UI state, while `run now` observes/executes scheduler behavior.
- **Running workers cannot be killed** → Disable run-now for currently running goals and do not advertise cancel as a process kill.
- **Table rendering can overflow narrow terminals** → Use width-aware truncation and compact fallbacks.
- **TUI and CLI behavior could drift** → Share lifecycle operations and cover them with tests.
- **Additional Pi TUI imports may affect packaging** → Prefer existing Pi package APIs and declare any required dependency explicitly if TypeScript/runtime resolution needs it.

## Migration Plan

No persisted state migration is required. The change adds new UI entrypoints and shared operation helpers while preserving existing goal records and text commands.

Rollback is straightforward: remove the TUI command registration and component files; existing goal state and CLI commands remain valid.

## Open Questions

- Should the canonical interactive command be `/goals`, `/goal ui`, or both?
- Should run-now operate only on one selected goal, or should the modal also expose a global tick later?
- Should completed/dormant goals be resumable from the TUI in the first version, or remain read-only?
