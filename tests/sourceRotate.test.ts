import { test } from "node:test";
import assert from "node:assert/strict";
import { ROTATION, tagForWeek } from "../src/cli/sourceRotate";

test("tagForWeek is stable within a week and visits every tag once per cycle", () => {
  const week = 7 * 86400 * 1000;
  const start = 2900 * week;
  assert.equal(tagForWeek(start), tagForWeek(start + week - 1));
  const seen = new Set<string>();
  for (let i = 0; i < ROTATION.length; i++) seen.add(tagForWeek(start + i * week));
  assert.equal(seen.size, ROTATION.length);
});
