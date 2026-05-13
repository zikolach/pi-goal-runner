#!/usr/bin/env node
import { createGoalStore } from "./state/store.js";
import { handleGoalCommand } from "./commands.js";
import { schedulerTick } from "./scheduler.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const store = createGoalStore();
  await store.init();
  if (command === "daemon") {
    const intervalMs = Number(process.env.PI_GOAL_RUNNER_INTERVAL_MS ?? "60000");
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
