import type { DecisionRecord, GoalRecord, GoalState, RunSummary, ValidationResult } from "./types.js";
import { getGoalActionAvailability } from "./goal-operations.js";
import { getGoalDisplayMetadata } from "./adapters/registry.js";

export type GoalManagerView = "list" | "detail" | "decisions" | "decision-answer" | "confirm-cancel";

export interface GoalManagerCallbacks {
  loadGoals(): Promise<GoalRecord[]>;
  loadGoal(goalId: string): Promise<GoalRecord | undefined>;
  pauseGoal(goalId: string): Promise<{ ok: boolean; reason?: string }>;
  resumeGoal(goalId: string): Promise<{ ok: boolean; reason?: string }>;
  cancelGoal(goalId: string): Promise<{ ok: boolean; reason?: string }>;
  runGoalNow(goalId: string): Promise<{ ok: boolean; reason?: string }>;
  answerDecision(goalId: string, decisionId: string, choice: string): Promise<{ ok: boolean; reason?: string }>;
  runSchedulerTick(): Promise<{ ok: boolean; summary: string; reason?: string; messages: string[] }>;
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

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const INVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function truncateLine(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(value) <= width) return value;
  if (width === 1) return value.slice(0, 1);
  const target = Math.max(0, width - 1);
  let visible = 0;
  let output = "";
  for (let index = 0; index < value.length;) {
    if (value[index] === "\x1b") {
      const match = value.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    if (visible >= target) break;
    output += value[index];
    visible += 1;
    index += 1;
  }
  return `${output}…${value.includes("\x1b[") ? RESET : ""}`;
}

function padLine(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function highlightLine(value: string): string {
  return `${INVERSE}${value}${RESET}`;
}

function fallbackText(value: string | undefined, fallback = "?"): string {
  return value ? String(value) : fallback;
}

const STATE_FILTERS = ["all", "active", "paused", "running", "needs_decision", "failed", "completed", "dormant", "cancelled"] as const;
type StateFilter = (typeof STATE_FILTERS)[number];

const SORT_MODES = ["state", "next", "id", "target", "actions"] as const;
type SortMode = (typeof SORT_MODES)[number];

const LIST_COLUMNS = ["id", "state", "target", "next", "actions"] as const;
type ListColumn = (typeof LIST_COLUMNS)[number];

const LIST_COLUMN_LABELS: Record<ListColumn, string> = {
  id: "ID",
  state: "State",
  target: "Target",
  next: "Next check",
  actions: "Actions",
};

const STATE_SORT_ORDER: Record<GoalState, number> = {
  active: 1,
  running: 2,
  needs_decision: 3,
  failed: 4,
  dormant: 5,
  paused: 6,
  cancelled: 7,
  completed: 8,
};

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function compareIsoDate(a?: string, b?: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return compareStrings(a, b);
}

function countPendingDecisions(goal: GoalRecord): number {
  return goal.pendingDecisions.filter((decision) => decision.status === "pending").length;
}

function getPendingDecisions(goal: GoalRecord): DecisionRecord[] {
  return goal.pendingDecisions.filter((decision) => decision.status === "pending");
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
  return padLine(normalized, width);
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

function wrappedLines(value: string, width: number): string[] {
  return wrapCell(value, width).map((line) => truncateLine(line, width));
}

function wrappedPrefixedLines(prefix: string, value: string, width: number): string[] {
  if (width <= prefix.length + 1) return wrappedLines(`${prefix}${value}`, width);
  const bodyWidth = Math.max(1, width - prefix.length);
  return wrapCell(value, bodyWidth).map((line, index) => truncateLine(`${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`, width));
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

function renderHorizontalTable(
  headers: string[],
  rows: string[][],
  width: number,
  selectedRowIndex: number,
  selectedColumnIndex: number,
): string[] {
  if (!headers.length) return [];
  const columnWidths = headers.map((header, index) => {
    const maxCell = rows.reduce((max, row) => Math.max(max, visibleLength((row[index] ?? "").replace(/\r?\n/g, " "))), visibleLength(header));
    const cap = header === "ID" || header === "Decision" ? 18 : header === "Target" || header === "Prompt" ? 24 : 24;
    return Math.max(3, Math.min(cap, maxCell));
  });

  const visibleIndexes = selectVisibleColumns(columnWidths, width, selectedColumnIndex);
  const headerCells = headers.map((header, index) => index === selectedColumnIndex ? `${header}▲` : header);
  const visibleWidths = visibleIndexes.map((index) => Math.max(columnWidths[index] ?? 3, visibleLength(headerCells[index] ?? "")));

  const renderVisibleRow = (cells: string[]): string => visibleIndexes
    .map((index, localIndex) => renderCell((cells[index] ?? "").replace(/\r?\n/g, " "), visibleWidths[localIndex] ?? 3))
    .join(" | ");

  const headerLine = renderVisibleRow(headerCells);
  const dividerLine = visibleWidths.map((columnWidth) => "─".repeat(Math.max(1, columnWidth))).join("─┼─");
  const body = rows.map((row, index) => {
    const line = truncateLine(renderVisibleRow(row), width);
    return index === selectedRowIndex ? highlightLine(padLine(line, width)) : line;
  });
  return [headerLine, dividerLine, ...body].map((line) => truncateLine(line, width));
}

function selectVisibleColumns(columnWidths: number[], width: number, selectedColumnIndex: number): number[] {
  if (!columnWidths.length) return [];
  const selected = Math.max(0, Math.min(selectedColumnIndex, columnWidths.length - 1));
  const separator = 3;
  let indexes = [selected];
  let used = columnWidths[selected] ?? 3;
  let left = selected - 1;
  let right = selected + 1;

  while (left >= 0 || right < columnWidths.length) {
    const tryLeft = left >= 0 ? (columnWidths[left] ?? 3) + separator : Number.POSITIVE_INFINITY;
    const tryRight = right < columnWidths.length ? (columnWidths[right] ?? 3) + separator : Number.POSITIVE_INFINITY;
    const preferLeft = tryLeft <= tryRight;
    if (preferLeft && used + tryLeft <= width) {
      indexes = [left, ...indexes];
      used += tryLeft;
      left -= 1;
      continue;
    }
    if (right < columnWidths.length && used + tryRight <= width) {
      indexes = [...indexes, right];
      used += tryRight;
      right += 1;
      continue;
    }
    if (!preferLeft && left >= 0 && used + tryLeft <= width) {
      indexes = [left, ...indexes];
      used += tryLeft;
      left -= 1;
      continue;
    }
    break;
  }

  return indexes;
}

function toDialogLines(lines: string[], width: number): string[] {
  if (width <= 2) {
    return lines.map((line) => truncateLine(line, width));
  }
  const innerWidth = Math.max(1, width - 2);
  const top = `╭${"─".repeat(innerWidth)}╮`;
  const bottom = `╰${"─".repeat(innerWidth)}╯`;
  const body = lines.map((line) => `│${padLine(truncateLine(line, innerWidth), innerWidth)}│`);
  return [top, ...body, bottom];
}

function goalMetadataRows(goal: GoalRecord): string[][] {
  const display = getGoalDisplayMetadata(goal);

  const rows: string[][] = [
    ["ID", goal.id],
    ["Type", goal.type],
    ["State", goal.state],
    ["Summary", fallbackText(goal.summary, "")],
    ["Target", goalTargetLine(goal)],
    ["Next check", fallbackText(goal.schedule.nextCheckAt, "none")],
    ["Latest progress", fallbackText(goal.latestProgress, "none")],
    ["Last run", fallbackText(goal.lastRunSummary ?? goal.runHistory.at(-1)?.summary, "none")],
    ["Pending decisions", String(countPendingDecisions(goal))],
  ];

  if (goal.github?.prUrl) {
    rows.push(["PR URL", goal.github.prUrl]);
  }

  if (display.workspace) {
    rows.push(["Worktree", display.workspace]);
  }

  if (goal.github?.repository?.worktreePath && goal.github.repository.worktreePath !== display.workspace) {
    rows.push(["Worktree path", goal.github.repository.worktreePath]);
  }

  return rows;
}

function runHistoryRows(runHistory: RunSummary[] | undefined): string[][] {
  const latestRun = runHistory?.at(-1);
  if (!latestRun) return [];

  const rows: string[][] = [
    ["Latest run id", latestRun.id],
    ["Latest run status", latestRun.status],
    ["Latest run started", fallbackText(latestRun.startedAt, "none")],
    ["Latest run completed", fallbackText(latestRun.completedAt, "pending")],
    ["Latest run output", fallbackText(latestRun.summary, "none")],
  ];

  const validation = latestRun.validationResults ?? [];
  for (let index = 0; index < validation.length; index++) {
    const result = validation[index];
    if (!result) continue;
    rows.push([`Validation ${index + 1} command`, validationResultCommand(result)]);
    rows.push([`Validation ${index + 1} status`, result.status]);
    if (result.output) rows.push([`Validation ${index + 1} output`, result.output]);
  }
  return rows;
}

function validationResultCommand(result: ValidationResult): string {
  return fallbackText(result.command, "");
}

export class GoalManagerDialog implements GoalManagerComponent {
  private goals: GoalRecord[];
  private view: GoalManagerView = "list";
  private selectedIndex = 0;
  private selectedGoalId?: string;
  private selectedFilterIndex = 0;
  private selectedSortIndex = 0;
  private selectedListColumnIndex = 1;
  private selectedDecisionColumnIndex = 0;
  private detailScrollOffset = 0;
  private listLineCount = 0;
  private selectedDecisionIndex = 0;
  private selectedDecisionId?: string;
  private confirm?: ConfirmMessage;
  private lastTickSummary = "";

  constructor(
    initialGoals: GoalRecord[],
    private callbacks: GoalManagerCallbacks,
    private requestRender: () => void,
    private done: () => void,
  ) {
    this.goals = [...initialGoals];
    this.selectedGoalId = this.goals[0]?.id;
  }

  render(width: number): string[] {
    const lines = this.renderCurrentView(Math.max(1, width - 2));
    return toDialogLines(lines, width);
  }

  private renderCurrentView(width: number): string[] {
    if (this.view === "list") return this.renderList(width);
    if (this.view === "detail") return this.renderDetail(width);
    if (this.view === "decisions") return this.renderDecisions(width);
    if (this.view === "decision-answer") return this.renderDecisionAnswer(width);

    return this.renderConfirm(width);
  }

  private renderConfirm(width: number): string[] {
    const goal = this.selectedGoal;
    if (!goal) return [""];
    const prompt = this.confirm ?? { prompt: `Cancel ${goal.id}?`, yesHint: "y", noHint: "n/esc" };
    return [
      truncateLine(`Cancel goal ${goal.id}`, width),
      truncateLine(prompt.prompt, width),
      truncateLine(`Yes=${prompt.yesHint}, No=${prompt.noHint}`, width),
      "",
      truncateLine("y:confirm • n/q/esc:keep", width),
    ];
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
    if (this.view === "decisions") {
      this.handleDecisionsInput(key);
      return;
    }
    if (this.view === "decision-answer") {
      this.handleDecisionAnswerInput(key);
      return;
    }
    if (this.view === "confirm-cancel") {
      void this.handleConfirmInput(key);
    }
  }

  private async runSchedulerTick(): Promise<void> {
    const result = await this.callbacks.runSchedulerTick();
    if (!result.ok) {
      this.callbacks.notify(result.reason ?? "Tick failed", "warning");
      this.lastTickSummary = result.summary;
    } else {
      this.lastTickSummary = result.summary;
    }
    if (result.messages.length > 0 && !result.ok) {
      for (const message of result.messages) {
        this.callbacks.notify(message, "warning");
      }
    }
    await this.reloadGoals();
    this.requestRender();
  }

  private async answerDecision(goalId: string, decision: DecisionRecord, choice: string): Promise<void> {
    const result = await this.callbacks.answerDecision(goalId, decision.id, choice);
    if (!result.ok) {
      this.callbacks.notify(result.reason ?? "Could not answer decision", "warning");
      this.requestRender();
      return;
    }

    await this.reloadSelectedGoal();
    const goal = this.selectedGoal;
    const pending = goal ? getPendingDecisions(goal) : [];
    if (pending.length > 0) {
      this.view = "decisions";
      this.syncDecisionSelection(pending);
    } else {
      this.view = "detail";
    }
    this.requestRender();
  }

  private handleListInput(key: string): void {
    const goals = this.visibleGoals();
    this.syncSelection(goals);

    if (key === "up") {
      if (!goals.length) return;
      this.selectedIndex = (this.selectedIndex - 1 + goals.length) % goals.length;
      this.selectedGoalId = goals[this.selectedIndex]?.id;
      this.requestRender();
      return;
    }

    if (key === "down") {
      if (!goals.length) return;
      this.selectedIndex = (this.selectedIndex + 1) % goals.length;
      this.selectedGoalId = goals[this.selectedIndex]?.id;
      this.requestRender();
      return;
    }

    if (key === "left") {
      this.selectedListColumnIndex = Math.max(0, this.selectedListColumnIndex - 1);
      this.requestRender();
      return;
    }

    if (key === "right") {
      this.selectedListColumnIndex = Math.min(LIST_COLUMNS.length - 1, this.selectedListColumnIndex + 1);
      this.requestRender();
      return;
    }

    if (key === "enter") {
      if (!this.selectedGoal) return;
      this.view = "detail";
      this.detailScrollOffset = 0;
      this.requestRender();
      return;
    }

    if (key === "r") {
      void this.reloadGoals();
      return;
    }

    if (key === "f") {
      this.selectedFilterIndex = (this.selectedFilterIndex + 1) % STATE_FILTERS.length;
      this.selectedGoalId = undefined;
      this.syncSelection(this.visibleGoals());
      this.requestRender();
      return;
    }

    if (key === "s") {
      const column = LIST_COLUMNS[this.selectedListColumnIndex] ?? "state";
      const sortMode = column === "next" ? "next" : column;
      this.selectedSortIndex = SORT_MODES.indexOf(sortMode as SortMode);
      this.syncSelection(this.visibleGoals());
      this.requestRender();
      return;
    }

    if (key === "t") {
      void this.runSchedulerTick();
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

    if (key === "up") {
      this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1);
      this.requestRender();
      return;
    }

    if (key === "down") {
      this.detailScrollOffset += 1;
      this.requestRender();
      return;
    }

    if (key === "pageup") {
      this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 5);
      this.requestRender();
      return;
    }

    if (key === "pagedown") {
      this.detailScrollOffset += 5;
      this.requestRender();
      return;
    }

    if (key === "home") {
      this.detailScrollOffset = 0;
      this.requestRender();
      return;
    }

    if (key === "end") {
      this.detailScrollOffset = Number.MAX_SAFE_INTEGER;
      this.requestRender();
      return;
    }

    if (key === "d") {
      if (countPendingDecisions(goal) > 0) {
        this.selectedDecisionIndex = 0;
        this.selectedDecisionId = undefined;
        this.view = "decisions";
        this.requestRender();
      }
      return;
    }

    if (key === "t") {
      void this.runSchedulerTick();
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
      this.confirm = { prompt: `Cancel ${goal.id}?`, yesHint: "y", noHint: "n/q/esc" };
      this.requestRender();
      return;
    }

    if (key === "n" && availability.canRunNow) {
      void this.runAction(goal.id, this.callbacks.runGoalNow, "run now");
      return;
    }
  }

  private handleDecisionsInput(key: string): void {
    const goal = this.selectedGoal;
    if (!goal) {
      this.view = "detail";
      this.requestRender();
      return;
    }

    const pending = getPendingDecisions(goal);
    this.syncDecisionSelection(pending);

    if (key === "up") {
      if (!pending.length) return;
      this.selectedDecisionIndex = (this.selectedDecisionIndex - 1 + pending.length) % pending.length;
      this.selectedDecisionId = pending[this.selectedDecisionIndex]?.id;
      this.requestRender();
      return;
    }

    if (key === "down") {
      if (!pending.length) return;
      this.selectedDecisionIndex = (this.selectedDecisionIndex + 1) % pending.length;
      this.selectedDecisionId = pending[this.selectedDecisionIndex]?.id;
      this.requestRender();
      return;
    }

    if (key === "left") {
      this.selectedDecisionColumnIndex = Math.max(0, this.selectedDecisionColumnIndex - 1);
      this.requestRender();
      return;
    }

    if (key === "right") {
      this.selectedDecisionColumnIndex = Math.min(2, this.selectedDecisionColumnIndex + 1);
      this.requestRender();
      return;
    }

    if (key === "escape" || key === "q" || key === "b" || key === "ctrl+c") {
      this.view = "detail";
      this.requestRender();
      return;
    }

    if (key === "r") {
      void this.reloadSelectedGoal();
      return;
    }

    if (key === "enter") {
      if (!pending.length) return;
      this.view = "decision-answer";
      this.requestRender();
      return;
    }
  }

  private handleDecisionAnswerInput(key: string): void {
    const goal = this.selectedGoal;
    const pending = goal ? getPendingDecisions(goal) : [];
    this.syncDecisionSelection(pending);
    const decision = pending.at(this.selectedDecisionIndex);

    if (!goal || !decision) {
      this.view = "decisions";
      this.requestRender();
      return;
    }

    if (key === "escape" || key === "q" || key === "b" || key === "ctrl+c") {
      this.view = "decisions";
      this.requestRender();
      return;
    }

    if (key === "r") {
      void this.reloadSelectedGoal();
      return;
    }

    const match = key.match(/^[1-9]$/);
    if (!match) return;

    const optionIndex = Number.parseInt(match[0], 10) - 1;
    const choice = decision.options.at(optionIndex);
    if (!choice) {
      this.callbacks.notify("No such option", "warning");
      return;
    }
    void this.answerDecision(goal.id, decision, choice.id);
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
    if (key === "n" || key === "escape" || key === "q" || key === "ctrl+c") {
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

  private async reloadGoals(): Promise<void> {
    this.goals = await this.callbacks.loadGoals();
    this.syncSelection(this.visibleGoals());
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
    this.syncSelection(this.visibleGoals());
    this.requestRender();
  }

  private visibleGoals(): GoalRecord[] {
    const filtered = this.stateFilter === "all" ? [...this.goals] : this.goals.filter((goal) => goal.state === this.stateFilter);
    return this.sortGoals(filtered);
  }

  private get stateFilter(): StateFilter {
    return STATE_FILTERS.at(this.selectedFilterIndex) ?? "all";
  }

  private get sortMode(): SortMode {
    return SORT_MODES.at(this.selectedSortIndex) ?? "state";
  }

  private get sortModeLabel(): string {
    if (this.sortMode === "state") return "state";
    if (this.sortMode === "next") return "next";
    if (this.sortMode === "target") return "target";
    if (this.sortMode === "actions") return "actions";
    return "id";
  }

  private syncSelection(visibleGoals: GoalRecord[]): void {
    if (!visibleGoals.length) {
      this.selectedIndex = 0;
      this.selectedGoalId = undefined;
      this.selectedDecisionIndex = 0;
      this.selectedDecisionId = undefined;
      return;
    }

    if (this.selectedGoalId) {
      const current = visibleGoals.findIndex((goal) => goal.id === this.selectedGoalId);
      if (current >= 0) {
        this.selectedIndex = current;
        return;
      }
    }

    if (!Number.isFinite(this.selectedIndex) || this.selectedIndex < 0 || this.selectedIndex >= visibleGoals.length) {
      this.selectedIndex = 0;
    }

    this.selectedGoalId = visibleGoals[this.selectedIndex]?.id;
  }

  private syncDecisionSelection(pendingDecisions: DecisionRecord[]): void {
    if (!pendingDecisions.length) {
      this.selectedDecisionIndex = 0;
      this.selectedDecisionId = undefined;
      return;
    }

    if (this.selectedDecisionId) {
      const current = pendingDecisions.findIndex((decision) => decision.id === this.selectedDecisionId);
      if (current >= 0) {
        this.selectedDecisionIndex = current;
        return;
      }
    }

    if (this.selectedDecisionIndex < 0 || this.selectedDecisionIndex >= pendingDecisions.length) this.selectedDecisionIndex = 0;
    this.selectedDecisionId = pendingDecisions[this.selectedDecisionIndex]?.id;
  }

  private sortGoals(goals: GoalRecord[]): GoalRecord[] {
    return goals.sort((a, b) => {
      if (this.sortMode === "state") {
        const byState = STATE_SORT_ORDER[a.state] - STATE_SORT_ORDER[b.state];
        if (byState !== 0) return byState;
      }

      if (this.sortMode === "next") {
        const byNext = compareIsoDate(a.schedule.nextCheckAt, b.schedule.nextCheckAt);
        if (byNext !== 0) return byNext;
      }

      if (this.sortMode === "target") {
        const byTarget = compareStrings(goalTargetLine(a), goalTargetLine(b));
        if (byTarget !== 0) return byTarget;
      }

      if (this.sortMode === "actions") {
        const byActions = compareStrings(buildActionHints(a).join(","), buildActionHints(b).join(","));
        if (byActions !== 0) return byActions;
      }

      const byId = compareStrings(a.id, b.id);
      if (byId !== 0) return byId;

      return compareStrings(goalTargetLine(a), goalTargetLine(b));
    });
  }

  private renderList(width: number): string[] {
    const lines: string[] = ["Goal manager", ""];
    const goals = this.visibleGoals();
    this.syncSelection(goals);

    if (!goals.length) {
      lines.push(truncateLine("No goals found.", width));
      lines.push(truncateLine(`Filter: ${this.stateFilter}`, width));
      lines.push(truncateLine("Press r to refresh, f cycle filter, s sort, t tick, q/esc to close", width));
      if (this.lastTickSummary) lines.push(truncateLine(`Last tick: ${this.lastTickSummary}`, width));
      return this.rememberListLines(lines);
    }

    if (width < 48) {
      lines.push(...this.renderCompactGoalList(goals, width));
      lines.push("");
      lines.push(truncateLine(`Filter: ${this.stateFilter} Sort: ${this.sortModeLabel}`, width));
      lines.push(truncateLine("↑/↓ move  enter detail", width));
      lines.push(truncateLine("←/→ column  s sort column", width));
      lines.push(truncateLine("f filter  r refresh  t tick", width));
      lines.push(truncateLine("q/esc close", width));
      if (this.lastTickSummary) lines.push(truncateLine(`Last tick: ${this.lastTickSummary}`, width));
      return this.rememberListLines(lines);
    }

    const headers = LIST_COLUMNS.map((column) => LIST_COLUMN_LABELS[column]);
    const rows = goals.map((goal) => {
      const hints = buildActionHints(goal);
      return [
        goal.id,
        goal.state,
        goalTargetLine(goal),
        goal.schedule.nextCheckAt,
        hints.length ? hints.join(",") : "(none)",
      ];
    });

    lines.push("");
    lines.push(...renderHorizontalTable(headers, rows, width, this.selectedIndex, this.selectedListColumnIndex));
    lines.push("");
    lines.push(truncateLine(`Filter: ${this.stateFilter}   Sort: ${this.sortModeLabel}   Column: ${LIST_COLUMN_LABELS[LIST_COLUMNS[this.selectedListColumnIndex] ?? "state"]}`, width));
    lines.push(truncateLine("↑/↓:row  ←/→:column/scroll  s:sort column  enter:detail", width));
    lines.push(truncateLine("f:filter  r:refresh  t:tick  q/esc:close", width));
    if (this.lastTickSummary) lines.push(truncateLine(`Last tick: ${this.lastTickSummary}`, width));
    return this.rememberListLines(lines);
  }

  private rememberListLines(lines: string[]): string[] {
    this.listLineCount = lines.length;
    return lines;
  }

  private renderCompactGoalList(goals: GoalRecord[], width: number): string[] {
    const lines: string[] = [];
    const selectedGoal = goals[this.selectedIndex];
    const visible = selectedGoal ? [selectedGoal] : goals.slice(0, 1);

    for (const goal of visible) {
      const hints = buildActionHints(goal);
      lines.push(truncateLine(`> ${goal.id}`, width));
      lines.push(truncateLine(`  state: ${goal.state}`, width));
      lines.push(...wrappedPrefixedLines("  target: ", goalTargetLine(goal), width));
      lines.push(truncateLine(`  next: ${goal.schedule.nextCheckAt || "none"}`, width));
      lines.push(truncateLine(`  actions: ${hints.length ? hints.join(",") : "(none)"}`, width));
      if (goals.length > 1) lines.push(truncateLine(`  ${this.selectedIndex + 1}/${goals.length}`, width));
    }

    return lines;
  }

  private renderDetail(width: number): string[] {
    const goal = this.selectedGoal;
    if (!goal) return this.renderList(width);

    const content = width < 48 ? this.renderCompactDetailContent(goal, width) : this.renderDetailTableContent(goal, width);
    return this.renderScrollableDetail(goal, content, width);
  }

  private renderDetailTableContent(goal: GoalRecord, width: number): string[] {
    const hints = buildActionHints(goal);
    const display = getGoalDisplayMetadata(goal);
    const table = goalMetadataRows(goal);

    table.splice(3, 0, ["Actions", hints.length ? hints.join(",") : "(none)"]);
    table.push(...runHistoryRows(goal.runHistory));

    if (display.details?.length) {
      for (const detail of display.details) table.push([detail.label, detail.value]);
    }

    const lines = renderRows(["Property", "Value"], table, width, [1], true);
    if (countPendingDecisions(goal) > 0) {
      lines.push("");
      lines.push(truncateLine(`Pending decisions: ${countPendingDecisions(goal)} (press d)`, width));
    }
    return lines;
  }

  private renderCompactDetailContent(goal: GoalRecord, width: number): string[] {
    const hints = buildActionHints(goal);
    const display = getGoalDisplayMetadata(goal);
    const lines: string[] = [];
    const rows = goalMetadataRows(goal);
    rows.splice(3, 0, ["Actions", hints.length ? hints.join(",") : "(none)"]);
    rows.push(...runHistoryRows(goal.runHistory));

    if (display.details?.length) {
      for (const detail of display.details) rows.push([detail.label, detail.value]);
    }

    for (const [label, value] of rows) {
      lines.push(...wrappedPrefixedLines(`${label}: `, value, width));
    }

    if (countPendingDecisions(goal) > 0) {
      lines.push("");
      lines.push(truncateLine(`Pending decisions: ${countPendingDecisions(goal)} (d)`, width));
    }
    return lines;
  }

  private renderScrollableDetail(goal: GoalRecord, content: string[], width: number): string[] {
    const header = ["", `Goal ${goal.id}`, truncateLine("↑/↓ scroll • b back • d decisions • r refresh", width), ""];
    const footer = [
      "",
      truncateLine("p pause/resume  c cancel  n run-now  t tick", width),
    ];
    if (this.lastTickSummary) footer.push(truncateLine(`Last tick: ${this.lastTickSummary}`, width));

    const defaultLineCount = width >= 50 ? 22 : 12;
    const maxLineCount = width >= 50 ? 28 : 18;
    const targetLineCount = Math.max(defaultLineCount, Math.min(maxLineCount, this.listLineCount || defaultLineCount));
    const viewportHeight = Math.max(3, targetLineCount - header.length - footer.length - 1);
    const maxScroll = Math.max(0, content.length - viewportHeight);
    this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxScroll));
    const visible = content.slice(this.detailScrollOffset, this.detailScrollOffset + viewportHeight);
    const position = maxScroll > 0
      ? truncateLine(`Scroll ${this.detailScrollOffset + 1}-${Math.min(content.length, this.detailScrollOffset + viewportHeight)}/${content.length}`, width)
      : truncateLine(`Scroll 1-${content.length}/${content.length}`, width);
    return [...header, ...visible, position, ...footer];
  }

  private renderDecisions(width: number): string[] {
    const goal = this.selectedGoal;
    if (!goal) return this.renderList(width);

    const pending = getPendingDecisions(goal);
    const lines: string[] = ["", `Pending decisions for ${goal.id}`, ""];
    this.syncDecisionSelection(pending);

    if (!pending.length) {
      lines.push("No pending decisions.");
      lines.push("");
      lines.push(truncateLine("b/back  r refresh", width));
      return lines;
    }

    if (width < 48) {
      const decision = pending[this.selectedDecisionIndex];
      if (decision) {
        lines.push(truncateLine(`> ${decision.id}`, width));
        lines.push(truncateLine(`  ${decision.required ? "required" : "optional"}`, width));
        lines.push(...wrappedPrefixedLines("  prompt: ", decision.prompt, width));
        lines.push(truncateLine(`  ${this.selectedDecisionIndex + 1}/${pending.length}`, width));
      }
      lines.push("");
      lines.push(truncateLine("↑/↓ move  enter answer", width));
      lines.push(truncateLine("b back  r refresh", width));
      return lines;
    }

    const rows = pending.map((decision) => [
      decision.id,
      decision.prompt,
      decision.required ? "required" : "optional",
    ]);

    lines.push(...renderHorizontalTable(["Decision", "Prompt", "Required"], rows, width, this.selectedDecisionIndex, this.selectedDecisionColumnIndex));
    lines.push("");
    lines.push(truncateLine("↑/↓:row  ←/→:column/scroll  enter:answer  b/back  r:refresh", width));
    return lines;
  }

  private renderDecisionAnswer(width: number): string[] {
    const goal = this.selectedGoal;
    const pending = goal ? getPendingDecisions(goal) : [];
    const decision = pending.at(this.selectedDecisionIndex);

    if (!goal || !decision) {
      this.view = "decisions";
      return this.renderDecisions(width);
    }

    this.syncDecisionSelection(pending);

    const lines: string[] = ["", `Decision ${decision.id}`, `Goal ${goal.id}`, ""];
    lines.push(...wrappedPrefixedLines("Prompt: ", decision.prompt, width));
    lines.push("");

    if (!decision.options.length) {
      lines.push("No choices available.");
      lines.push("");
      lines.push(truncateLine("b/back  r refresh", width));
      return lines;
    }

    for (let index = 0; index < decision.options.length; index++) {
      const option = decision.options[index];
      if (!option) continue;
      lines.push(truncateLine(`${index + 1}: ${option.id} ${option.label}`, width));
    }

    lines.push("");
    lines.push(truncateLine("1-9: choose option  b/back  r/refresh", width));
    return lines;
  }

  invalidate(): void {
    // no cache retained
  }

  private get selectedGoal(): GoalRecord | undefined {
    const goals = this.visibleGoals();
    this.syncSelection(goals);
    return goals[this.selectedIndex];
  }
}
