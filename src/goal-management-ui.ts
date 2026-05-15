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
  if (data === "\u001b[A") return "up";
  if (data === "\u001b[B") return "down";
  if (data === "\u001b" || trimmed === "esc" || trimmed === "escape") return "escape";
  if (data === "\r" || data === "\n" || trimmed.toLowerCase() === "enter") return "enter";
  if (trimmed === "") return "unknown";
  return trimmed.toLowerCase();
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

function buildSummaryLine(goal: GoalRecord): string {
  const summary = `${goal.state} ${goal.id} ${goalTargetLine(goal)} next:${goal.schedule.nextCheckAt}`;
  const hints = buildActionHints(goal);
  return hints.length ? `${summary} [${hints.join(" | ")}]` : summary;
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
      return [
        truncateLine(`Cancel goal ${goal.id}`, width),
        truncateLine(prompt.prompt, width),
        truncateLine(`Yes=${prompt.yesHint}, No=${prompt.noHint}`, width),
        "",
        truncateLine("y:confirm • n/esc:keep", width),
      ];
    }

    if (this.view === "list") return this.renderList(width);
    return this.renderDetail(width);
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
    if (key === "escape" || key === "q") {
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

    if (key === "escape" || key === "b") {
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
    const lines: string[] = ["", truncateLine("Goal manager", width), ""];
    if (!this.goals.length) {
      lines.push(truncateLine("No goals found.", width));
      lines.push(truncateLine("Press r to refresh, q/esc to close.", width));
      return lines;
    }
    lines.push(truncateLine("↑/↓:move  enter:detail  r:refresh  q/esc:close", width));
    for (const [index, goal] of this.goals.entries()) {
      const line = `${index === this.selectedIndex ? ">" : " "} ${buildSummaryLine(goal)}`;
      lines.push(truncateLine(line, width));
    }
    return lines;
  }

  private renderDetail(width: number): string[] {
    const goal = this.selectedGoal;
    if (!goal) return this.renderList(width);
    const hints = buildActionHints(goal);
    const lines: string[] = [];
    const display = getGoalDisplayMetadata(goal);
    const lastRun = fallbackText(goal.lastRunSummary ?? goal.runHistory.at(-1)?.summary, "none");
    lines.push(truncateLine(`Goal ${goal.id}`, width));
    lines.push(truncateLine(`State: ${goal.state}`, width));
    lines.push(truncateLine(`Type: ${goal.type}`, width));
    lines.push(truncateLine(`Summary: ${fallbackText(goal.summary, "")}`, width));
    lines.push(truncateLine(`Target: ${fallbackText(display.target, goal.summary)}`, width));
    lines.push(truncateLine(`Worktree: ${fallbackText(display.workspace, "none")}`, width));
    lines.push(truncateLine(`Next check: ${fallbackText(goal.schedule.nextCheckAt, "none")}`, width));
    lines.push(truncateLine(`Latest progress: ${fallbackText(goal.latestProgress, "none")}`, width));
    lines.push(truncateLine(`Last run: ${fallbackText(lastRun, "none")}`, width));
    lines.push(truncateLine(`Pending decisions: ${goal.pendingDecisions.filter((decision) => decision.status === "pending").length}`, width));
    lines.push(truncateLine(`Actions: ${hints.length ? hints.join(" | ") : "(none)"}`, width));
    lines.push(truncateLine(`Detail: b/esc back  r refresh  ${hints.join("  ")}`, width));
    if (hints.length) lines.push(truncateLine(`p:pause/resume  c:cancel  n:run now`, width));
    return lines;
  }

  private get selectedGoal(): GoalRecord | undefined {
    return this.goals[this.selectedIndex];
  }
}
