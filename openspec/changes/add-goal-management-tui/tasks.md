## 1. Shared Operations

- [x] 1.1 Add shared goal lifecycle operation helpers for pause, resume, cancel, and action availability.
- [x] 1.2 Add a run-now helper that makes one selected goal due immediately and invokes scheduler-compatible processing without force-launching workers.
- [x] 1.3 Update existing `/goal` text command handlers to reuse shared lifecycle helpers while preserving current output.
- [x] 1.4 Add unit tests for action availability and shared lifecycle helpers.

## 2. TUI Component Structure

- [x] 2.1 Add a goal management TUI module with modal state for list, detail, and cancel confirmation views.
- [x] 2.2 Implement width-safe goal list rendering with state, id, summary or PR target, next check, and hints.
- [x] 2.3 Implement selected-goal detail rendering with formatted metadata, latest progress, last run summary, pending-decision count, and worktree or target information.
- [x] 2.4 Implement keyboard handling for up/down navigation, enter detail, back, refresh, close, pause/resume, run-now, and cancel confirmation.
- [x] 2.5 Add rendering tests for empty list, populated list, detail view, narrow width truncation, and state-specific action hints.

## 3. Extension Integration

- [x] 3.1 Extend the Pi extension context types to include custom TUI capability detection and `ctx.ui.custom()` usage.
- [x] 3.2 Register the interactive goal manager command, using `/goals` as the primary entrypoint and `/goal ui` if supported by the existing parser shape.
- [x] 3.3 Add non-interactive fallback behavior that notifies the user without mutating goal state.
- [x] 3.4 Ensure modal actions refresh the goal store snapshot and request TUI re-render after state changes.

## 4. Scheduler and State Behavior

- [x] 4.1 Verify run-now does not start a second worker for a running goal.
- [x] 4.2 Verify refresh reloads persisted state without invoking scheduler behavior or modifying schedules.
- [x] 4.3 Verify cancel requires confirmation and escape/no leaves state unchanged.
- [x] 4.4 Verify completed, dormant, cancelled, running, paused, failed, and active goals advertise only valid actions.

## 5. Documentation and Validation

- [x] 5.1 Document `/goals` usage, keyboard shortcuts, and action semantics in README.
- [x] 5.2 Run `npm run typecheck` and fix any TypeScript issues.
- [x] 5.3 Run `npm test` and ensure all existing and new tests pass.
- [x] 5.4 Run `openspec validate add-goal-management-tui --strict`.
