// Runtime validation tests using real (captured) API payloads — see
// docs/AUDIT.md §2/§9. The REWARD-row fixture is here because it's the
// exact shape that broke an earlier, over-strict version of this schema in
// production (npm run track:once against the live API) before the schema
// was loosened — see the comment on ActivitySchema.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ActivityResponseSchema, MarketsLookupResponseSchema, HoldersResponseSchema } from "../src/api/schemas";

const activityFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/activity.sample.json"), "utf8"));
const holdersFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/holders.sample.json"), "utf8"));

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

// A real /markets response for a wallet sourced from the monthly leaderboard
// (2026-08-14 follow-up session) omitted endDate entirely and broke
// wallet-score for 4 of 15 wallets under an earlier, over-strict version of
// this schema — same "some real markets omit fields the type implies are
// always present" pattern as the REWARD-row case above.
const minimalMarket = {
  id: "1",
  conditionId: "0xabc",
  question: "Will X happen?",
  slug: "will-x-happen",
  closed: true,
};

test("accepts a real market response missing endDate", () => {
  const parsed = MarketsLookupResponseSchema.parse([minimalMarket]);
  assert.equal(parsed[0].endDate, undefined);
});

test("still rejects a market response missing a required field", () => {
  const malformed = [{ ...minimalMarket, conditionId: undefined }];
  assert.throws(() => MarketsLookupResponseSchema.parse(malformed));
});

// Real /holders response (2026-09-15, wallet-sourcing track) — one group
// per outcome token, extra fields (bio, profileImage, verified, etc.) that
// this schema doesn't declare must be silently ignored, not rejected.
test("accepts a real /holders response with two outcome-token groups", () => {
  const parsed = HoldersResponseSchema.parse(holdersFixture);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].holders.length, 3);
  assert.equal(parsed[0].holders[0].proxyWallet, "0x58b3380f71bd6c706dd398a5e60bde55fa3a653c");
  assert.ok(parsed[0].holders[0].amount > parsed[0].holders[1].amount, "holders should already be sorted descending by amount");
});

test("accepts a holder with an empty pseudonym/name (unverified/private profile)", () => {
  const parsed = HoldersResponseSchema.parse(holdersFixture);
  const privateHolder = parsed[1].holders[0];
  assert.equal(privateHolder.pseudonym, "");
  assert.equal(privateHolder.name, "");
});

test("rejects a /holders response missing a required field", () => {
  const malformed = [{ ...holdersFixture[0], holders: [{ ...holdersFixture[0].holders[0], amount: undefined }] }];
  assert.throws(() => HoldersResponseSchema.parse(malformed));
});

// Real behavior confirmed live 2026-09-15: a market close to resolution
// (all outcome tokens already fully settled/redeemed) returns a bare
// `null` body instead of `[]` -- must not crash the caller.
test("normalizes a null /holders response (fully-settled market) to an empty array", () => {
  const parsed = HoldersResponseSchema.parse(null);
  assert.deepEqual(parsed, []);
});
