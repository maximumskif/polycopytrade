import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setFetchImplForTests, __resetFetchImplForTests } from "../src/api/client";
import {
  estimateFollowerFill,
  summarizeDelayDegradation,
  type FollowerFillEstimate,
  type LeaderFill,
} from "../src/backtesting/followerExecution";

afterEach(() => {
  __resetFetchImplForTests();
});

function fakeResponse(body: unknown): Response {
  return { status: 200, ok: true, statusText: "OK", json: async () => body } as unknown as Response;
}

function fakeMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    conditionId: "c1",
    question: "q",
    slug: "s",
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["1", "0"]),
    clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
    endDate: "2026-01-01T00:00:00Z",
    closed: true,
    ...overrides,
  };
}

function estimate(overrides: Partial<FollowerFillEstimate> = {}): FollowerFillEstimate {
  return {
    conditionId: "c1",
    outcome: "Yes",
    leaderTimestamp: 1000,
    leaderPrice: 0.2,
    won: true,
    followerPriceByDelay: { 5: 0.22, 15: 0.23, 30: 0.25, 60: 0.28 },
    ...overrides,
  };
}

test("estimateFollowerFill picks the correct outcome's token and reads the price at/after each delay", async () => {
  __setFetchImplForTests(async (url) => {
    const s = url.toString();
    if (s.includes("/markets")) return fakeResponse([fakeMarket()]);
    if (s.includes("prices-history")) {
      assert.ok(s.includes("market=yes-token"), `expected the Yes-side token id in the URL, got: ${s}`);
      return fakeResponse({
        history: [
          { t: 970, p: 0.19 }, // before the fill -- must never be picked as a "later" price
          { t: 1006, p: 0.21 }, // first point at/after +5s (1005)
          { t: 1016, p: 0.22 }, // first point at/after +15s
          { t: 1050, p: 0.24 }, // first point at/after +30s and +60s falls later
          { t: 1070, p: 0.27 },
        ],
      });
    }
    throw new Error(`unexpected URL in test: ${s}`);
  });

  const fill: LeaderFill = { conditionId: "c1", outcome: "Yes", timestamp: 1000, price: 0.2, won: true };
  const result = await estimateFollowerFill(fill);

  assert.ok(result);
  assert.equal(result!.followerPriceByDelay[5], 0.21);
  assert.equal(result!.followerPriceByDelay[15], 0.22);
  assert.equal(result!.followerPriceByDelay[30], 0.24);
  assert.equal(result!.followerPriceByDelay[60], 0.27);
});

test("estimateFollowerFill returns null follower prices for delays with no later tick in the window", async () => {
  __setFetchImplForTests(async (url) => {
    const s = url.toString();
    if (s.includes("/markets")) return fakeResponse([fakeMarket()]);
    if (s.includes("prices-history")) return fakeResponse({ history: [{ t: 990, p: 0.2 }] }); // only a pre-fill tick
    throw new Error(`unexpected URL: ${s}`);
  });

  const fill: LeaderFill = { conditionId: "c1", outcome: "Yes", timestamp: 1000, price: 0.2, won: true };
  const result = await estimateFollowerFill(fill);

  assert.ok(result);
  for (const delay of [5, 15, 30, 60] as const) {
    assert.equal(result!.followerPriceByDelay[delay], null);
  }
});

test("estimateFollowerFill uses the No-side token when the fill's outcome is No", async () => {
  __setFetchImplForTests(async (url) => {
    const s = url.toString();
    if (s.includes("/markets")) return fakeResponse([fakeMarket()]);
    if (s.includes("prices-history")) {
      assert.ok(s.includes("market=no-token"), `expected the No-side token id, got: ${s}`);
      return fakeResponse({ history: [{ t: 1005, p: 0.81 }] });
    }
    throw new Error(`unexpected URL: ${s}`);
  });

  const fill: LeaderFill = { conditionId: "c1", outcome: "No", timestamp: 1000, price: 0.8, won: false };
  const result = await estimateFollowerFill(fill);
  assert.ok(result);
  assert.equal(result!.outcome, "No");
});

test("estimateFollowerFill returns null when the market can't be found (both closed and open lookups miss)", async () => {
  __setFetchImplForTests(async () => fakeResponse([]));
  const fill: LeaderFill = { conditionId: "unknown", outcome: "Yes", timestamp: 1000, price: 0.5, won: true };
  const result = await estimateFollowerFill(fill);
  assert.equal(result, null);
});

test("summarizeDelayDegradation excludes trials with no observed follower price at that delay", () => {
  const estimates = [
    estimate({ followerPriceByDelay: { 5: 0.22, 15: null, 30: 0.25, 60: 0.28 } }),
    estimate({ followerPriceByDelay: { 5: 0.24, 15: 0.26, 30: 0.28, 60: 0.3 } }),
  ];
  const summary = summarizeDelayDegradation(estimates);
  const at15 = summary.find((s) => s.delaySeconds === 15)!;
  assert.equal(at15.sampleSize, 1); // only the second estimate had a real price at 15s
  assert.equal(at15.avgFollowerEntryPrice, 0.26);
});

test("summarizeDelayDegradation: a follower entering at a worse (higher) price than the leader shows lower ROI", () => {
  // Leader buys at 20c and wins; follower's price has drifted up to 30c by
  // the time they'd actually execute -- same win, strictly worse ROI.
  const estimates = [estimate({ leaderPrice: 0.2, won: true, followerPriceByDelay: { 5: 0.3, 15: 0.3, 30: 0.3, 60: 0.3 } })];
  const summary = summarizeDelayDegradation(estimates);
  const at5 = summary.find((s) => s.delaySeconds === 5)!;
  assert.ok(at5.followerRoi < at5.leaderRoi, `expected follower ROI (${at5.followerRoi}) < leader ROI (${at5.leaderRoi})`);
  assert.ok(Math.abs(at5.avgPriceSlippage - 0.1) < 1e-9);
});

test("summarizeDelayDegradation gives a zeroed-out row (not a crash) when no fill has a price at a given delay", () => {
  const estimates = [estimate({ followerPriceByDelay: { 5: 0.22, 15: null, 30: null, 60: null } })];
  const summary = summarizeDelayDegradation(estimates);
  const at60 = summary.find((s) => s.delaySeconds === 60)!;
  assert.equal(at60.sampleSize, 0);
  assert.equal(at60.followerRoi, 0);
});
