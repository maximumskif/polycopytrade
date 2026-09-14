import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cheapPrefilter,
  findAccumulationClusters,
  clusterToTrial,
  ACCUMULATION_WINDOW_SECONDS,
  DIVERGENCE_THRESHOLD,
  type AccumulationCluster,
} from "../src/research/smartMoneyDivergence";
import type { Activity } from "../src/api/client";
import type { BacktestTrial } from "../src/domain/types";

const NOW = 1_000_000_000;

function activity(overrides: Partial<Activity>): Activity {
  return {
    timestamp: NOW,
    conditionId: "c1",
    type: "TRADE",
    size: 10,
    usdcSize: 5,
    price: 0.5,
    side: "BUY",
    outcome: "Yes",
    title: "Some game vs. Other game",
    slug: "some-market",
    eventSlug: "some-event",
    proxyWallet: "0xw",
    transactionHash: "0xhash",
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// cheapPrefilter
// ---------------------------------------------------------------------

test("cheapPrefilter: no trade activity fails", () => {
  const result = cheapPrefilter([activity({ type: "REWARD", side: "" })], NOW);
  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /no trade activity/);
});

test("cheapPrefilter: dormant (last trade > 30 days ago) fails", () => {
  const oldTs = NOW - 40 * 86400;
  const rows = Array.from({ length: 6 }, (_, i) => activity({ timestamp: oldTs + i, conditionId: `c${i}`, eventSlug: `e${i}` }));
  const result = cheapPrefilter(rows, NOW);
  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /dormant/);
});

test("cheapPrefilter: one-shot proxy (<=3 distinct raw events) fails", () => {
  const rows = [
    activity({ conditionId: "c1", eventSlug: "e1", timestamp: NOW }),
    activity({ conditionId: "c2", eventSlug: "e2", timestamp: NOW }),
    activity({ conditionId: "c3", eventSlug: "e3", timestamp: NOW }),
  ];
  const result = cheapPrefilter(rows, NOW);
  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /one-shot/);
});

test("cheapPrefilter: highly-concentrated proxy (>50% stake in one event) fails", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => activity({ conditionId: `big${i}`, eventSlug: "big-event", usdcSize: 1000, timestamp: NOW })),
    activity({ conditionId: "small1", eventSlug: "e-small1", usdcSize: 10, timestamp: NOW }),
    activity({ conditionId: "small2", eventSlug: "e-small2", usdcSize: 10, timestamp: NOW }),
    activity({ conditionId: "small3", eventSlug: "e-small3", usdcSize: 10, timestamp: NOW }),
    activity({ conditionId: "small4", eventSlug: "e-small4", usdcSize: 10, timestamp: NOW }),
  ];
  const result = cheapPrefilter(rows, NOW);
  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /highly-concentrated/);
});

test("cheapPrefilter: election-only proxy (>70% politics-titled BUYs) fails", () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) =>
      activity({ conditionId: `p${i}`, eventSlug: `pe${i}`, title: "Will the President win?", timestamp: NOW })
    ),
    ...Array.from({ length: 2 }, (_, i) => activity({ conditionId: `s${i}`, eventSlug: `se${i}`, title: "Team A vs. Team B", timestamp: NOW })),
  ];
  const result = cheapPrefilter(rows, NOW);
  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /election-only/);
});

test("cheapPrefilter: uncopyable-high-frequency proxy (>=50 fills, median gap < 5s) fails", () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    activity({ conditionId: `c${i % 10}`, eventSlug: `e${i % 10}`, timestamp: NOW + i * 2 })
  );
  const result = cheapPrefilter(rows, NOW + 200);
  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /high-frequency/);
});

test("cheapPrefilter: a diversified, active, non-concentrated, non-election, normal-speed wallet passes", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    activity({
      conditionId: `c${i}`,
      eventSlug: `e${i}`,
      title: "Team A vs. Team B",
      usdcSize: 100,
      timestamp: NOW - i * 3600,
    })
  );
  const result = cheapPrefilter(rows, NOW);
  assert.equal(result.pass, true);
  assert.equal(result.reason, undefined);
});

// ---------------------------------------------------------------------
// findAccumulationClusters
// ---------------------------------------------------------------------

function trial(overrides: Partial<BacktestTrial>): BacktestTrial {
  return {
    walletAddress: "0xw",
    conditionId: "c1",
    outcome: "Yes",
    eventKey: "e1",
    category: "sports",
    entryTimestamp: NOW,
    entryPrice: 0.5,
    usdcStaked: 4,
    shares: 8,
    resolved: true,
    won: true,
    netReturn: 4,
    ...overrides,
  };
}

test("findAccumulationClusters: two distinct wallets buying the same outcome within the window forms a cluster", () => {
  const poolTrials = [
    { walletAddress: "0xA", trial: trial({ entryTimestamp: NOW, entryPrice: 0.4 }) },
    { walletAddress: "0xB", trial: trial({ entryTimestamp: NOW + 3600, entryPrice: 0.42 }) },
  ];
  const clusters = findAccumulationClusters(poolTrials);
  assert.equal(clusters.length, 1);
  assert.deepEqual(new Set(clusters[0].distinctWallets), new Set(["0xA", "0xB"]));
  assert.equal(clusters[0].basePrice, 0.4);
  assert.equal(clusters[0].signalPrice, 0.42);
  assert.ok(Math.abs(clusters[0].priceMove - 0.02) < 1e-9);
});

test("findAccumulationClusters: a single wallet buying twice does not form a cluster (needs >=2 DISTINCT wallets)", () => {
  const poolTrials = [
    { walletAddress: "0xA", trial: trial({ entryTimestamp: NOW }) },
    { walletAddress: "0xA", trial: trial({ entryTimestamp: NOW + 100 }) },
  ];
  const clusters = findAccumulationClusters(poolTrials);
  assert.equal(clusters.length, 0);
});

test("findAccumulationClusters: a second wallet's fill outside the window is excluded from the cluster", () => {
  const poolTrials = [
    { walletAddress: "0xA", trial: trial({ entryTimestamp: NOW }) },
    { walletAddress: "0xB", trial: trial({ entryTimestamp: NOW + ACCUMULATION_WINDOW_SECONDS + 1 }) },
  ];
  const clusters = findAccumulationClusters(poolTrials);
  assert.equal(clusters.length, 0);
});

test("findAccumulationClusters: different outcomes on the same market are NOT merged into one cluster", () => {
  const poolTrials = [
    { walletAddress: "0xA", trial: trial({ outcome: "Yes", entryTimestamp: NOW }) },
    { walletAddress: "0xB", trial: trial({ outcome: "No", entryTimestamp: NOW + 10 }) },
  ];
  const clusters = findAccumulationClusters(poolTrials);
  assert.equal(clusters.length, 0);
});

test("findAccumulationClusters: signal is the LAST qualifying fill within the window, not the average", () => {
  const poolTrials = [
    { walletAddress: "0xA", trial: trial({ entryTimestamp: NOW, entryPrice: 0.3 }) },
    { walletAddress: "0xB", trial: trial({ entryTimestamp: NOW + 1000, entryPrice: 0.35 }) },
    { walletAddress: "0xC", trial: trial({ entryTimestamp: NOW + 2000, entryPrice: 0.5 }) },
  ];
  const clusters = findAccumulationClusters(poolTrials);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].signalPrice, 0.5);
  assert.equal(clusters[0].distinctWallets.length, 3);
});

test("findAccumulationClusters: custom windowSeconds parameter is honored", () => {
  const poolTrials = [
    { walletAddress: "0xA", trial: trial({ entryTimestamp: NOW }) },
    { walletAddress: "0xB", trial: trial({ entryTimestamp: NOW + 100 }) },
  ];
  assert.equal(findAccumulationClusters(poolTrials, 50).length, 0);
  assert.equal(findAccumulationClusters(poolTrials, 200).length, 1);
});

// ---------------------------------------------------------------------
// clusterToTrial
// ---------------------------------------------------------------------

function cluster(overrides: Partial<AccumulationCluster>): AccumulationCluster {
  return {
    conditionId: "c1",
    outcome: "Yes",
    eventKey: "e1",
    category: "sports",
    distinctWallets: ["0xA", "0xB"],
    basePrice: 0.4,
    baseTimestamp: NOW,
    signalPrice: 0.4,
    signalTimestamp: NOW,
    priceMove: 0,
    won: true,
    ...overrides,
  };
}

test("clusterToTrial: a win pays out 1/entryPrice - 1 (correct share-based payout, not a flat 1)", () => {
  const t = clusterToTrial(cluster({ signalPrice: 0.25, won: true }), "tag");
  assert.equal(t.entryPrice, 0.25);
  assert.equal(t.shares, 4);
  assert.equal(t.netReturn, 3); // 4 shares worth $1 each, minus the $1 staked
  assert.equal(t.usdcStaked, 1);
});

test("clusterToTrial: a loss returns -1 regardless of entry price", () => {
  const t = clusterToTrial(cluster({ signalPrice: 0.25, won: false }), "tag");
  assert.equal(t.netReturn, -1);
});

test("DIVERGENCE_THRESHOLD sanity: a flat/negative priceMove is <= threshold, a rally is not", () => {
  assert.ok(-0.01 <= DIVERGENCE_THRESHOLD);
  assert.ok(0 <= DIVERGENCE_THRESHOLD);
  assert.ok(!(0.1 <= DIVERGENCE_THRESHOLD));
});
