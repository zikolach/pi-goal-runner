import { pathToFileURL } from "node:url";
import { createGoalStore } from "./state/store.js";
import { handleGoalCommandArgs } from "./commands.js";
import { schedulerTick } from "./scheduler.js";
import { safeError } from "./redaction.js";

interface DaemonLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const store = createGoalStore();
  await store.init();
  if (command === "daemon") {
    const intervalMs = parseDaemonInterval(process.env.PI_GOAL_RUNNER_INTERVAL_MS);
    console.log(`pi-goal-runner daemon interval=${intervalMs}ms`);
    for (;;) {
      await runDaemonTick(store);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (command === "tick") {
    const result = await schedulerTick(store);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(await handleGoalCommandArgs(store, goalArgsFromCli(command, args), { cwd: process.cwd() }));
}

export const MAX_DAEMON_INTERVAL_MS = 2_147_483_647;

export function goalArgsFromCli(command: string, args: string[]): string[] {
  return command === "goal" ? args : [command, ...args];
}

export function parseDaemonInterval(value: string | undefined): number {
  const intervalMs = Number(value ?? "60000");
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000 || intervalMs > MAX_DAEMON_INTERVAL_MS) {
    throw new Error(`PI_GOAL_RUNNER_INTERVAL_MS must be a number between 1000 and ${MAX_DAEMON_INTERVAL_MS} milliseconds`);
  }
  return intervalMs;
}

export async function runDaemonTick(store: ReturnType<typeof createGoalStore>, tick: typeof schedulerTick = schedulerTick, logger: DaemonLogger = console): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    const result = await tick(store);
    logger.log(timestamp, JSON.stringify(result));
  } catch (error) {
    logger.error(timestamp, `scheduler tick failed: ${safeError(error)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
