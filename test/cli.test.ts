import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDaemonInterval } from "../src/cli.js";

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
