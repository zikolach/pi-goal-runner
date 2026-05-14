import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDaemonInterval, runDaemonTick } from "../src/cli.js";

test("daemon interval rejects tight-loop values", () => {
  assert.equal(parseDaemonInterval(undefined), 60_000);
  assert.equal(parseDaemonInterval("1000"), 1_000);
  assert.throws(() => parseDaemonInterval("0"), />= 1000/);
  assert.throws(() => parseDaemonInterval("-1"), />= 1000/);
  assert.throws(() => parseDaemonInterval("nope"), />= 1000/);
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
