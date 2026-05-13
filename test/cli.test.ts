import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonInterval } from "../src/cli.js";

test("daemon interval rejects tight-loop values", () => {
  assert.equal(parseDaemonInterval(undefined), 60_000);
  assert.equal(parseDaemonInterval("1000"), 1_000);
  assert.throws(() => parseDaemonInterval("0"), />= 1000/);
  assert.throws(() => parseDaemonInterval("-1"), />= 1000/);
  assert.throws(() => parseDaemonInterval("nope"), />= 1000/);
});
