import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyArchetype } from "../src/scoring/archetypeClassifier";
import { computeWalletScore } from "../src/scoring/walletScore";
import { computeStrategyResult } from "../src/backtesting/statistics";
import { defaultBacktestConfig } from "../src/backtesting/engine";
import type { Activity } from "../src/api/client";
import type { BacktestTrial } from "../src/domain/types";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const wallet = { address: "0xw", label: "test-wallet" };
const config = defaultBacktestConfig();

function trial(overrides: Partial<BacktestTrial>): BacktestTrial {
  return {
    walletAddress: "0xw",
    conditionId: "c1",
    outcome: "Yes",
    eventKey: "e1",
    category: "other",
    entryTimestamp: NOW,
    entryPrice: 0.5,
    usdcStaked: 4,
    shares: 8,
    resolved: true,
    won: true,
    netReturn: 2,
    ...overrides,
  };
}

function activityRow(overrides: Partial<Activity>): Activity {
  return {
    timestamp: NOW,
    conditionId: "c1",
    type: "TRADE",
    size: 8,
    usdcSize: 4,
    price: 0.5,
    side: "BUY",
    outcome: "Yes",
    title: "t",
    slug: "s",
    proxyWallet: "0xw",
    transactionHash: "0xh",
    ...overrides,
  };
}

function classify(trials: BacktestTrial[], activity: Activity[]) {
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  return classifyArchetype(score, trials, activity);
}

test("a wallet with zero resolved trials classifies as unclassified with zero confidence", () => {
  const c = classify([], []);
  assert.equal(c.archetype, "unclassified");
  assert.equal(c.confidence, 0);
});

test("a wallet with 2 distinct events classifies as one-shot-bet", () => {
  const trials = [
    trial({ conditionId: "c1", eventKey: "e1", entryTimestamp: NOW - 2 * DAY }),
    trial({ conditionId: "c2", eventKey: "e2", entryTimestamp: NOW - DAY }),
  ];
  const activity = [activityRow({ conditionId: "c1", timestamp: NOW - 2 * DAY }), activityRow({ conditionId: "c2", timestamp: NOW - DAY })];
  const c = classify(trials, activity);
  assert.equal(c.archetype, "one-shot-bet");
  assert.ok(c.confidence > 0);
});

test("many markets clustered into few events classifies as ladder-harvester", () => {
  // 5 real events ("months"), 6 rungs (markets) each -- 30 trials, 30
  // distinct markets, 5 distinct events (> the one-shot threshold of 3) ->
  // 6 markets/event.
  const trials: BacktestTrial[] = [];
  const activity: Activity[] = [];
  for (let e = 0; e < 5; e++) {
    for (let m = 0; m < 6; m++) {
      const conditionId = `c${e}-${m}`;
      const ts = NOW - (30 - (e * 6 + m)) * DAY;
      trials.push(trial({ conditionId, eventKey: `event-${e}`, entryTimestamp: ts, category: "crypto/commodity" }));
      activity.push(activityRow({ conditionId, timestamp: ts }));
    }
  }
  const c = classify(trials, activity);
  assert.equal(c.archetype, "ladder-harvester");
});

test("few, large, concentrated bets classify as whale-conviction", () => {
  // 4 distinct events (clears the one-shot threshold) but 90%+ of stake
  // sits in one of them, at a large-dollar average size.
  const bigEvent = Array.from({ length: 3 }, (_, i) =>
    trial({ conditionId: `big${i}`, eventKey: "big-event", usdcStaked: 500, netReturn: 150, entryTimestamp: NOW - (6 - i) * DAY })
  );
  const smallEvents = Array.from({ length: 3 }, (_, i) =>
    trial({ conditionId: `small${i}`, eventKey: `small-event-${i}`, usdcStaked: 50, netReturn: 10, entryTimestamp: NOW - (3 - i) * DAY })
  );
  const trials = [...bigEvent, ...smallEvents];
  const activity = trials.map((t) => activityRow({ conditionId: t.conditionId, timestamp: t.entryTimestamp, usdcSize: t.usdcStaked }));
  const c = classify(trials, activity);
  assert.equal(c.archetype, "whale-conviction");
});

test("few, large, sports-dominant bets classify as live-sports-whale, not whale-conviction", () => {
  // Same shape as the whale-conviction test (few, large bets) but every
  // trial is in the "sports" category and spread across distinct events --
  // no single event dominates stake, so the whale-conviction concentration
  // check alone wouldn't fire; the category dominance should still route
  // this to live-sports-whale ahead of the generic whale-conviction rule.
  const trials = Array.from({ length: 8 }, (_, i) =>
    trial({
      conditionId: `c${i}`,
      eventKey: `e${i}`,
      category: "sports",
      usdcStaked: 500,
      netReturn: 150,
      entryTimestamp: NOW - (8 - i) * DAY,
    })
  );
  const activity = trials.map((t) => activityRow({ conditionId: t.conditionId, timestamp: t.entryTimestamp, usdcSize: t.usdcStaked }));
  const c = classify(trials, activity);
  assert.equal(c.archetype, "live-sports-whale");
});

test("a single large order fragmented into many near-instant fills still classifies as whale-conviction, not sniper/scalper", () => {
  // Regression test for the real bug found validating against 0xE30E7
  // (2026-09-15): a $50,000 real order that data-api's /activity reports as
  // 50 separate $1,000 fills 1 second apart (same conditionId/outcome/side,
  // well inside clusterFills's 120s merge window) must still be read as ONE
  // large order, not 50 small "trials" with a near-zero median gap.
  const bigOrderFills = Array.from({ length: 50 }, (_, i) =>
    trial({ conditionId: "big", eventKey: "big-event", usdcStaked: 1000, netReturn: 300, entryTimestamp: NOW - 3600 + i })
  );
  const bigOrderActivity = Array.from({ length: 50 }, (_, i) =>
    activityRow({ conditionId: "big", timestamp: NOW - 3600 + i, usdcSize: 1000 })
  );
  // 3 more small, distinct-event trials just to clear the one-shot
  // threshold (>3 distinct events) without affecting the concentration math.
  const smallTrials = Array.from({ length: 3 }, (_, i) =>
    trial({ conditionId: `small${i}`, eventKey: `small-event-${i}`, usdcStaked: 50, netReturn: 5, entryTimestamp: NOW - (3 - i) * DAY })
  );
  const smallActivity = smallTrials.map((t) =>
    activityRow({ conditionId: t.conditionId, timestamp: t.entryTimestamp, usdcSize: t.usdcStaked })
  );

  const trials = [...bigOrderFills, ...smallTrials];
  const activity = [...bigOrderActivity, ...smallActivity];
  const c = classify(trials, activity);
  assert.equal(c.archetype, "whale-conviction");
});

test("few, small, high-ROI trades not concentrated in one event classify as sniper", () => {
  const trials = Array.from({ length: 6 }, (_, i) =>
    trial({ conditionId: `c${i}`, eventKey: `e${i}`, usdcStaked: 10, netReturn: 8, entryTimestamp: NOW - (6 - i) * DAY })
  );
  const activity = trials.map((t) => activityRow({ conditionId: t.conditionId, timestamp: t.entryTimestamp, usdcSize: t.usdcStaked }));
  const c = classify(trials, activity);
  assert.equal(c.archetype, "sniper");
});

test("high-frequency sports-dominant trading classifies as sports-scalper", () => {
  const trials = Array.from({ length: 60 }, (_, i) =>
    trial({ conditionId: `c${i}`, eventKey: `e${i}`, category: "sports", entryTimestamp: NOW - (60 - i) * DAY })
  );
  // 60 TRADE rows 2 seconds apart -> trips uncopyable-high-frequency.
  const activity = Array.from({ length: 60 }, (_, i) => activityRow({ conditionId: `c${i}`, timestamp: NOW - (60 - i) * 2 }));
  const c = classify(trials, activity);
  assert.equal(c.archetype, "sports-scalper");
});

test("ordinary-cadence sports-dominant trading classifies as sports-systematic", () => {
  const trials = Array.from({ length: 25 }, (_, i) =>
    trial({ conditionId: `c${i}`, eventKey: `e${i}`, category: "sports", entryTimestamp: NOW - (25 - i) * DAY })
  );
  const activity = trials.map((t) => activityRow({ conditionId: t.conditionId, timestamp: t.entryTimestamp }));
  const c = classify(trials, activity);
  assert.equal(c.archetype, "sports-systematic");
});

test("a mixed-category, moderate-frequency, unconcentrated wallet classifies as unclassified rather than forcing a guess", () => {
  const categories = ["sports", "politics", "crypto/commodity", "weather", "other"];
  const trials = Array.from({ length: 25 }, (_, i) =>
    trial({ conditionId: `c${i}`, eventKey: `e${i}`, category: categories[i % categories.length], entryTimestamp: NOW - (25 - i) * DAY })
  );
  const activity = trials.map((t) => activityRow({ conditionId: t.conditionId, timestamp: t.entryTimestamp }));
  const c = classify(trials, activity);
  assert.equal(c.archetype, "unclassified");
  assert.equal(c.confidence, 0);
});

test("every classification's reasons array is non-empty and explains the match", () => {
  const trials = [
    trial({ conditionId: "c1", eventKey: "e1", entryTimestamp: NOW - 2 * DAY }),
    trial({ conditionId: "c2", eventKey: "e2", entryTimestamp: NOW - DAY }),
  ];
  const activity = trials.map((t) => activityRow({ conditionId: t.conditionId, timestamp: t.entryTimestamp }));
  const c = classify(trials, activity);
  assert.ok(c.reasons.length > 0);
});
