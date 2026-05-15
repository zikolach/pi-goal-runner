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
  const raw = String(data);

  const csiUMatch = raw.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
  if (csiUMatch) {
    const codepoint = Number.parseInt(csiUMatch[1] ?? "", 10);
    const modifier = Number.isFinite(Number.parseInt(csiUMatch[4] ?? "", 10)) ? Number.parseInt(csiUMatch[4] ?? "", 10) - 1 : 0;
    const normalized = normalizeCodepointForName(codepoint);

    if (normalized === 27) return "escape";
    if (normalized === 13 || normalized === 10) return "enter";
    if (normalized === 9) return "tab";
    if (normalized === 8) return "backspace";
    if (normalized === -1) return "up";
    if (normalized === -2) return "down";
    if (normalized === -3) return "right";
    if (normalized === -4) return "left";

    if (normalized >= 97 && normalized <= 122) {
      const key = String.fromCodePoint(normalized);
      if (modifier & 4) return `ctrl+${key}`;
      if (modifier & 1) return key.toUpperCase();
      return key;
    }

    if (normalized >= 48 && normalized <= 57) {
      const key = String.fromCodePoint(normalized);
      if (modifier & 4) return `ctrl+${key}`;
      return key;
    }
  }

  const arrowMatch = raw.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
  if (arrowMatch) {
    const key = arrowMatch[3];
    if (key === "A") return "up";
    if (key === "B") return "down";
    if (key === "C") return "right";
    if (key === "D") return "left";
  }

  const codepointMatch = raw.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (codepointMatch) {
    const codepoint = Number.parseInt(codepointMatch[2] ?? "", 10);
    const modifier = Number.parseInt(codepointMatch[1] ?? "", 10) - 1;
    if (codepoint === 27) return "escape";
    if (codepoint === 99 && (modifier & 4)) return "ctrl+c";
  }

  const normalized = raw.trim();
  const lower = normalized.toLowerCase();

  if (raw === "\r" || raw === "\n" || lower === "enter" || lower === "return") {
    return "enter";
  }

  if (raw === "\u0003" || lower === "ctrl+c" || lower === "control+c" || lower === "ctrlc") {
    return "ctrl+c";
  }

  if (lower === "up" || lower === "down") {
    return lower;
  }

  if (lower === "escape" || lower === "esc" || normalized === "\x1b" || (normalized.length === 1 && normalized.charCodeAt(0) === 27)) {
    return "escape";
  }

  if (raw.length === 2 && raw.charCodeAt(0) === 27 && raw.charCodeAt(1) >= 1 && raw.charCodeAt(1) <= 26) {
    const lowerCode = String.fromCharCode((raw.charCodeAt(1) ?? 0) + 96);
    return `ctrl+${lowerCode}`;
  }

  const directLegacy = {
    "\x1b": "escape",
    "\x1b[A": "up",
    "\x1bOA": "up",
    "\x1b[B": "down",
    "\x1bOB": "down",
    "\x1b[C": "right",
    "\x1bOC": "right",
    "\x1b[D": "left",
    "\x1bOD": "left",
    "\x1b[H": "home",
    "\x1bOH": "home",
    "\x1b[F": "end",
    "\x1bOF": "end",
    "\x1b[2~": "insert",
    "\x1b[3~": "delete",
    "\x1b[5~": "pageup",
    "\x1b[6~": "pagedown",
  }[raw];
  if (directLegacy) {
    return directLegacy;
  }

  if (raw.startsWith("\x1b")) {
    return "escape";
  }

  if (normalized === "") {
    return "unknown";
  }
  return lower;
}

function normalizeCodepointForName(codepoint: number): number {
  const kittyEquivalent: Record<number, number> = {
    57399: 48,
    57400: 49,
    57401: 50,
    57402: 51,
    57403: 52,
    57404: 53,
    57405: 54,
    57406: 55,
    57407: 56,
    57408: 57,
    57409: 46,
    57410: 47,
    57411: 42,
    57412: 45,
    57413: 43,
    57415: 61,
    57416: 44,
    57417: -4,
    57418: -3,
    57419: -1,
    57420: -2,
    57421: -12,
    57422: -13,
    57423: -14,
    57424: -15,
    57425: -11,
    57426: -10,
  };

  return kittyEquivalent[codepoint] ?? codepoint;
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
  const normalized = String(value).replace(/\r\n?/g, "\n");
  const logicalLines = normalized.split("\n");
  const lines: string[] = [];

  for (const logicalLine of logicalLines) {
    if (logicalLine.length === 0) {
      lines.push("");
      continue;
    }

    let remaining = logicalLine;
    while (remaining.length > width) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    lines.push(remaining);
  }

  return lines.length === 0 ? [""] : lines;
}

function renderRows(headers: string[], rows: string[][], width: number, shrinkOrder: number[] = [], wrap = false): string[] {
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
    if (wrap) {
      const chunks = row.map((cell, index) => {
        if (index === 0) {
          return [truncateLine(cell ?? "", columns[index] ?? 1)];
        }
        return wrapCell(cell ?? "", columns[index] ?? 1);
      });
      const rowHeight = Math.max(...chunks.map((chunk) => chunk.length));
      for (let line = 0; line < rowHeight; line++) {
        const lineCells = row.map((_, index) => chunks[index]?.at(line) ?? "");
        body.push(renderRow(lineCells));
      }
    } else {
      const line = row.map((cell, index) => truncateLine((cell ?? "").replace(/\r?\n/g, " "), columns[index] ?? 1));
      body.push(renderRow(line));
    }
  }

  return [
    headerLine,
    dividerLine,
    ...body,
  ].map((line) => truncateLine(line, width));
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
  private detailLineCount = 0;

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
    const lines = this.view === "list" ? this.renderList(contentWidth) : this.renderDetail(contentWidth);
    if (this.view === "detail") {
      this.detailLineCount = Math.max(this.detailLineCount, lines.length);
      return toDialogLines(lines, width);
    }

    if (this.detailLineCount > 0 && lines.length < this.detailLineCount && width > 2) {
      const bodyHeight = Math.max(0, this.detailLineCount - lines.length);
      lines.push(...Array(bodyHeight).fill(""));
    }

    return toDialogLines(lines, width);
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
    lines.push(...renderRows(headers, rows, width, [5, 4, 3, 2, 1, 0], false));
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

    lines.push(...renderRows(["Property", "Value"], table, width, [1], true));
    lines.push("");
    lines.push(truncateLine("b/esc back  r refresh  p:pause/resume  c:cancel  n:run now", width));
    return lines;
  }

  private get selectedGoal(): GoalRecord | undefined {
    return this.goals[this.selectedIndex];
  }
}
