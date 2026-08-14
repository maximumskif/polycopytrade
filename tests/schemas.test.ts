// Runtime validation tests using real (captured) API payloads — see
// docs/AUDIT.md §2/§9. The REWARD-row fixture is here because it's the
// exact shape that broke an earlier, over-strict version of this schema in
// production (npm run track:once against the live API) before the schema
// was loosened — see the comment on ActivitySchema.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ActivityResponseSchema } from "../src/api/schemas";

const activityFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/activity.sample.json"), "utf8"));

test("accepts a real TRADE row", () => {
  const parsed = ActivityResponseSchema.parse(activityFixture);
  assert.equal(parsed[0].type, "TRADE");
  assert.equal(parsed[0].side, "SELL");
});

test("accepts a real REWARD row (empty side/conditionId/outcome) without rejecting the whole batch", () => {
  const parsed = ActivityResponseSchema.parse(activityFixture);
  const reward = parsed.find((a) => a.type === "REWARD");
  assert.ok(reward);
  assert.equal(reward!.side, "");
  assert.equal(reward!.conditionId, "");
});

test("rejects a response missing a required field", () => {
  const malformed = [{ ...activityFixture[0], timestamp: undefined }];
  assert.throws(() => ActivityResponseSchema.parse(malformed));
});

test("rejects a response where a numeric field arrives as the wrong type", () => {
  const malformed = [{ ...activityFixture[0], price: "0.5" }]; // string, not number
  assert.throws(() => ActivityResponseSchema.parse(malformed));
});
