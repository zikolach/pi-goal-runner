import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { goalArgsFromCli, MAX_DAEMON_INTERVAL_MS, parseDaemonInterval, runDaemonTick } from "../src/cli.js";

test("daemon interval rejects timer-clamped tight-loop values", () => {
  assert.equal(parseDaemonInterval(undefined), 60_000);
  assert.equal(parseDaemonInterval("1000"), 1_000);
  assert.equal(parseDaemonInterval(String(MAX_DAEMON_INTERVAL_MS)), MAX_DAEMON_INTERVAL_MS);
  assert.throws(() => parseDaemonInterval("0"), /between 1000/);
  assert.throws(() => parseDaemonInterval("-1"), /between 1000/);
  assert.throws(() => parseDaemonInterval("nope"), /between 1000/);
  assert.throws(() => parseDaemonInterval(String(MAX_DAEMON_INTERVAL_MS + 1)), /between 1000/);
  assert.throws(
    () => parseDaemonInterval("0"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /daemon mode/i);
      return true;
    },
  );
});

test("cli goal command preserves argv token boundaries", () => {
  const argv = ["watch-pr", "owner/repo", "1", "--validation", "npm test"];
  assert.deepEqual(goalArgsFromCli("goal", argv), argv);
  assert.deepEqual(goalArgsFromCli("watch-pr", ["owner/repo", "1", "--validation", "npm test"]), ["watch-pr", "owner/repo", "1", "--validation", "npm test"]);
});

test("generated cli declarations do not include a shebang", async () => {
  const declaration = await readFile("dist/src/cli.d.ts", "utf8");
  assert.equal(declaration.startsWith("#!"), false);
});

test("daemon tick logs scheduler failures instead of throwing", async () => {
  const errors: unknown[][] = [];
  await runDaemonTick(
    {} as Parameters<typeof runDaemonTick>[0],
    async () => {
      throw new Error("transient gh failure");
    },
    { log: () => undefined, error: (...args: unknown[]) => errors.push(args) },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.join(" ") ?? "", /transient gh failure/);
});
