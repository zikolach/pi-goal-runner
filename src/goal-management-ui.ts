import type { GoalRecord } from "./types.js";
import { getGoalActionAvailability } from "./goal-operations.js";
import { getGoalDisplayMetadata } from "./adapters/registry.js";

export type GoalManagerView = "list" | "detail" | "confirm-cancel";

export interface GoalManagerCallbacks {
  loadGoals(): Promise<GoalRecord[]>;
  loadGoal(goalId: string): Promise<GoalRecord | undefined>;
  pauseGoal(goalId: string): Promise<{ ok: boolean; reason?: string }>;
  resumeGoal(goalId: string): Promise<{ ok: boolean; reason?: string }>;
  cancelGoal(goalId: string): Promise<{ ok: boolean; reason?: string }>;
  runGoalNow(goalId: string): Promise<{ ok: boolean; reason?: string }>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}


interface GoalManagerComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

interface ConfirmMessage {
  prompt: string;
  yesHint: string;
  noHint: string;
}

function normalizeKey(data: string): string {
  const trimmed = data.trim();
  const lower = trimmed.toLowerCase();

  if (data === "\u001b[A" || lower === "up") return "up";
  if (data === "\u001b[B" || lower === "down") return "down";
  if (trimmed.length === 1 && trimmed.charCodeAt(0) === 27) return "escape";
  if (trimmed === "\u001b" || lower === "escape" || lower === "esc") return "escape";
  if (data === "\r" || data === "\n" || lower === "enter") return "enter";
  if (lower === "ctrl+c") return "ctrl+c";

  if (trimmed === "") return "unknown";
  return lower;
}

function truncateLine(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return value.slice(0, 1);
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function fallbackText(value: string | undefined, fallback = "?"): string {
  return value ? String(value) : fallback;
}

function goalTargetLine(goal: GoalRecord): string {
  const display = getGoalDisplayMetadata(goal);
  return display.target ?? goal.summary;
}

function buildActionHints(goal: GoalRecord): string[] {
  const availability = getGoalActionAvailability(goal);
  const hints: string[] = [];
  if (availability.canPause) hints.push("p:pause");
  if (availability.canResume) hints.push("p:resume");
  if (availability.canCancel) hints.push("c:cancel");
  if (availability.canRunNow) hints.push("n:run now");
  return hints;
}

function renderCell(value: string, width: number): string {
  const normalized = truncateLine(String(value), width);
  return normalized.padEnd(width, " ");
}

function wrapCell(value: string, width: number): string[] {
  if (width <= 1) return [truncateLine(String(value), width)];
  const normalized = String(value);
  if (normalized.length === 0) return [""];
  const lines: string[] = [];
  let remaining = normalized;
  while (remaining.length > width) {
    lines.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  lines.push(remaining);
  return lines;
}

function renderRows(headers: string[], rows: string[][], width: number, shrinkOrder: number[] = []): string[] {
  if (!headers.length) return [];
  const columnCount = headers.length;
  const separatorWidth = Math.max(0, columnCount - 1) * 3;
  const contentWidth = Math.max(1, width - separatorWidth);
  const columns: number[] = headers.map((header) => Math.max(1, header.length));

  for (const row of rows) {
    for (let index = 0; index < columnCount; index++) {
      const cell = row[index] ?? "";
      columns[index] = Math.max(columns[index], Math.min(cell.length, contentWidth));
    }
  }

  let total = columns.reduce((sum, value) => sum + value, 0);
  if (total > contentWidth) {
    let overflow = total - contentWidth;
    const order = shrinkOrder.length ? shrinkOrder : Array.from({ length: columnCount }, (_, index) => index);
    while (overflow > 0) {
      let changed = false;
      for (const index of order) {
        if (overflow <= 0) break;
        if (columns[index] > 1) {
          columns[index] -= 1;
          overflow -= 1;
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
    total = columns.reduce((sum, value) => sum + value, 0);
    if (total > contentWidth) {
      const fallback = Math.max(1, Math.floor(contentWidth / columnCount));
      for (let index = 0; index < columnCount; index++) columns[index] = fallback;
      let extra = contentWidth - fallback * columnCount;
      for (let index = 0; index < columnCount && extra > 0; index++) {
        columns[index] += 1;
        extra -= 1;
      }
    }
  }

  const renderRow = (cells: string[]): string => {
    return cells
      .map((cell, index) => renderCell(cell, columns[index] ?? 1))
      .join(" | ");
  };

  const headerLine = renderRow(headers);
  const dividerLine = columns.map((columnWidth) => "─".repeat(Math.max(1, columnWidth))).join("─┼─");

  const body: string[] = [];
  for (const row of rows) {
    const chunks = row.map((cell, index) => wrapCell(cell ?? "", columns[index] ?? 1));
    const rowHeight = Math.max(...chunks.map((chunk) => chunk.length));
    for (let line = 0; line < rowHeight; line++) {
      const lineCells = row.map((_, index) => chunks[index]?.at(line) ?? "");
      body.push(renderRow(lineCells));
    }
  }

  return [
    headerLine,
    dividerLine,
    ...body,
  ].map((line) => truncateLine(line, contentWidth));
}

function toDialogLines(lines: string[], width: number): string[] {
  if (width <= 2) {
    return lines.map((line) => truncateLine(line, width));
  }
  const innerWidth = Math.max(1, width - 2);
  const top = `╭${"─".repeat(innerWidth)}╮`;
  const bottom = `╰${"─".repeat(innerWidth)}╯`;
  const body = lines.map((line) => `│${truncateLine(line, innerWidth).padEnd(innerWidth, " ")}│`);
  return [top, ...body, bottom];
}

export class GoalManagerDialog implements GoalManagerComponent {
  private goals: GoalRecord[];
  private view: GoalManagerView = "list";
  private selectedIndex = 0;
  private confirm?: ConfirmMessage;

  constructor(
    initialGoals: GoalRecord[],
    private callbacks: GoalManagerCallbacks,
    private requestRender: () => void,
    private done: () => void,
  ) {
    this.goals = [...initialGoals];
  }

  render(width: number): string[] {
    if (this.view === "confirm-cancel" && this.selectedGoal) {
      const goal = this.selectedGoal;
      const prompt = this.confirm ?? { prompt: `Cancel ${goal.id}?`, yesHint: "y", noHint: "n/esc" };
      return toDialogLines([
        truncateLine(`Cancel goal ${goal.id}`, width),
        truncateLine(prompt.prompt, width),
        truncateLine(`Yes=${prompt.yesHint}, No=${prompt.noHint}`, width),
        "",
        truncateLine("y:confirm • n/esc:keep", width),
      ], width);
    }

    const contentWidth = Math.max(1, width - 2);
    if (this.view === "list") return toDialogLines(this.renderList(contentWidth), width);
    return toDialogLines(this.renderDetail(contentWidth), width);
  }

  handleInput(data: string): void {
    const key = normalizeKey(data);
    if (this.view === "list") {
      this.handleListInput(key);
      return;
    }
    if (this.view === "detail") {
      this.handleDetailInput(key);
      return;
    }
    if (this.view === "confirm-cancel") {
      void this.handleConfirmInput(key);
      return;
    }
  }

  invalidate(): void {
    // no cache retained
  }

  private async reloadGoals(): Promise<void> {
    this.goals = await this.callbacks.loadGoals();
    if (this.selectedIndex >= this.goals.length) this.selectedIndex = Math.max(0, this.goals.length - 1);
    this.requestRender();
  }

  private async reloadSelectedGoal(): Promise<void> {
    const selectedId = this.selectedGoal?.id;
    if (!selectedId) return;
    const updated = await this.callbacks.loadGoal(selectedId);
    if (!updated) {
      this.view = "list";
      await this.reloadGoals();
      return;
    }
    const index = this.goals.findIndex((goal) => goal.id === updated.id);
    if (index >= 0) this.goals[index] = updated;
    this.requestRender();
  }

  private handleListInput(key: string): void {
    if (key === "up") {
      if (!this.goals.length) return;
      this.selectedIndex = (this.selectedIndex - 1 + this.goals.length) % this.goals.length;
      this.requestRender();
      return;
    }
    if (key === "down") {
      if (!this.goals.length) return;
      this.selectedIndex = (this.selectedIndex + 1) % this.goals.length;
      this.requestRender();
      return;
    }
    if (key === "enter") {
      if (!this.selectedGoal) return;
      this.view = "detail";
      this.requestRender();
      return;
    }
    if (key === "r") {
      void this.reloadGoals();
      return;
    }
    if (key === "escape" || key === "q" || key === "ctrl+c") {
      this.done();
      return;
    }
  }

  private handleDetailInput(key: string): void {
    const goal = this.selectedGoal;
    if (!goal) {
      this.view = "list";
      this.requestRender();
      return;
    }
    const availability = getGoalActionAvailability(goal);

    if (key === "escape" || key === "q" || key === "b" || key === "ctrl+c") {
      this.view = "list";
      this.requestRender();
      return;
    }
    if (key === "r") {
      void this.reloadSelectedGoal();
      return;
    }
    if (key === "p") {
      if (availability.canPause) {
        void this.runAction(goal.id, this.callbacks.pauseGoal, "pause");
      } else if (availability.canResume) {
        void this.runAction(goal.id, this.callbacks.resumeGoal, "resume");
      }
      return;
    }
    if (key === "c" && availability.canCancel) {
      this.view = "confirm-cancel";
      this.confirm = { prompt: `Cancel ${goal.id}?`, yesHint: "y", noHint: "n/esc" };
      this.requestRender();
      return;
    }
    if (key === "n" && availability.canRunNow) {
      void this.runAction(goal.id, this.callbacks.runGoalNow, "run now");
      return;
    }
  }

  private async handleConfirmInput(key: string): Promise<void> {
    if (!this.selectedGoal) {
      this.view = "detail";
      this.requestRender();
      return;
    }
    if (key === "y" || key === "enter") {
      const result = await this.callbacks.cancelGoal(this.selectedGoal.id);
      if (!result.ok) {
        this.callbacks.notify(result.reason ?? "Could not cancel goal", "warning");
      }
      this.view = "detail";
      this.confirm = undefined;
      await this.reloadSelectedGoal();
      return;
    }
    if (key === "n" || key === "escape") {
      this.view = "detail";
      this.confirm = undefined;
      this.requestRender();
      return;
    }
  }

  private async runAction(
    goalId: string,
    action: (goalId: string) => Promise<{ ok: boolean; reason?: string }>,
    label: string,
  ): Promise<void> {
    const result = await action(goalId);
    if (!result.ok) {
      this.callbacks.notify(`${label} failed: ${result.reason ?? "goal is unavailable"}`, "warning");
    }
    await this.reloadSelectedGoal();
  }

  private renderList(width: number): string[] {
    const lines: string[] = ["Goal manager", ""];
    if (!this.goals.length) {
      lines.push(truncateLine("No goals found.", width));
      lines.push(truncateLine("Press r to refresh, q/esc to close.", width));
      return lines;
    }

    const headers = ["Sel", "ID", "State", "Target", "Next check", "Actions"];
    const rows = this.goals.map((goal, index) => {
      const hints = buildActionHints(goal);
      return [
        index === this.selectedIndex ? ">" : " ",
        goal.id,
        goal.state,
        goalTargetLine(goal),
        goal.schedule.nextCheckAt,
        hints.length ? hints.join(",") : "(none)",
      ];
    });

    lines.push("");
    lines.push(...renderRows(headers, rows, width, [5, 4, 3, 2, 1, 0]));
    lines.push("", truncateLine("↑/↓:move  enter:detail  r:refresh  q/esc:close", width));
    return lines;
  }

  private renderDetail(width: number): string[] {
    const goal = this.selectedGoal;
    if (!goal) return this.renderList(width);
    const hints = buildActionHints(goal);
    const lines: string[] = ["", `Goal ${goal.id}`, ""]; 

    const table = [
      ["State", goal.state],
      ["Type", goal.type],
      ["Summary", fallbackText(goal.summary, "")],
      ["Target", goalTargetLine(goal)],
      ["Worktree", fallbackText(getGoalDisplayMetadata(goal).workspace, "none")],
      ["Next check", fallbackText(goal.schedule.nextCheckAt, "none")],
      ["Latest progress", fallbackText(goal.latestProgress, "none")],
      ["Last run", fallbackText(goal.lastRunSummary ?? goal.runHistory.at(-1)?.summary, "none")],
      ["Pending decisions", String(goal.pendingDecisions.filter((decision) => decision.status === "pending").length)],
      ["Actions", hints.length ? hints.join(",") : "(none)"],
    ];

    lines.push(...renderRows(["Property", "Value"], table, width, [1, 0]));
    lines.push("");
    lines.push(truncateLine("b/esc back  r refresh  p:pause/resume  c:cancel  n:run now", width));
    return lines;
  }

  private get selectedGoal(): GoalRecord | undefined {
    return this.goals[this.selectedIndex];
  }
}
