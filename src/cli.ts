import { pathToFileURL } from "node:url";
import { createGoalStore } from "./state/store.js";
import { handleGoalCommand } from "./commands.js";
import { schedulerTick } from "./scheduler.js";

export async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const store = createGoalStore();
  await store.init();
  if (command === "daemon") {
    const intervalMs = parseDaemonInterval(process.env.PI_GOAL_RUNNER_INTERVAL_MS);
    console.log(`pi-goal-runner daemon interval=${intervalMs}ms`);
    for (;;) {
      const result = await schedulerTick(store);
      console.log(new Date().toISOString(), JSON.stringify(result));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (command === "tick") {
    const result = await schedulerTick(store);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const text = command === "goal" ? args.join(" ") : [command, ...args].join(" ");
  console.log(await handleGoalCommand(store, text, { cwd: process.cwd() }));
}

export function parseDaemonInterval(value: string | undefined): number {
  const intervalMs = Number(value ?? "60000");
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
    throw new Error("PI_GOAL_RUNNER_INTERVAL_MS must be a number >= 1000 for daemon mode");
  }
  return intervalMs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
