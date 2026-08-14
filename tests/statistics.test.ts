import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../src/backtesting/statistics";
import { defaultBacktestConfig } from "../src/backtesting/engine";
import type { BacktestTrial } from "../src/domain/types";

function trial(overrides: Partial<BacktestTrial>): BacktestTrial {
  return {
    walletAddress: "0xw",
    conditionId: "c1",
    outcome: "Yes",
    eventKey: "e1",
    category: "other",
    entryTimestamp: 100,
    entryPrice: 0.5,
    usdcStaked: 4,
    shares: 8,
    resolved: true,
    won: true,
    netReturn: 2,
    ...overrides,
  };
}

const config = defaultBacktestConfig();

test("basic win/loss aggregation matches hand-computed numbers", () => {
  const trials = [
    trial({ conditionId: "c1", outcome: "Yes", eventKey: "e1", entryTimestamp: 100, usdcStaked: 4, won: true, netReturn: 2 }),
    trial({ conditionId: "c2", outcome: "Yes", eventKey: "e2", entryTimestamp: 200, usdcStaked: 4, won: false, netReturn: -4 }),
  ];
  const r = computeStrategyResult(trials, config);
  assert.equal(r.trialCount, 2);
  assert.equal(r.totalStaked, 8);
  assert.equal(r.netPnl, -2);
  assert.equal(r.roi, -0.25);
  assert.equal(r.winRate, 0.5);
  assert.equal(r.avgWin, 2);
  assert.equal(r.avgLoss, -4);
  assert.equal(r.profitFactor, 0.5); // grossWin 2 / grossLoss 4
  assert.equal(r.maxDrawdownPct, 0.5); // peak 2, trough -2, drawdown 4, /totalStaked 8
});

test("unresolved trials are excluded from every stat", () => {
  const trials = [
    trial({ resolved: true, won: true, netReturn: 2, usdcStaked: 4 }),
    trial({ resolved: false, won: null, netReturn: 0, usdcStaked: 4 }),
  ];
  const r = computeStrategyResult(trials, config);
  assert.equal(r.trialCount, 1);
  assert.equal(r.totalStaked, 4);
});

test("effectiveIndependentSampleCount counts distinct events, not distinct markets or fills", () => {
  const trials = Array.from({ length: 5 }, (_, i) => trial({ conditionId: `c${i}`, eventKey: "same-event" }));
  const r = computeStrategyResult(trials, config);
  assert.equal(r.distinctMarkets, 5);
  assert.equal(r.distinctEvents, 1);
  assert.equal(r.effectiveIndependentSampleCount, 1);
});

test("below the minimum sample size, bootstrap CI is null and meetsMinimumSample is false", () => {
  const trials = Array.from({ length: MIN_SAMPLE_SIZE - 1 }, (_, i) => trial({ conditionId: `c${i}`, eventKey: `e${i}` }));
  const r = computeStrategyResult(trials, config);
  assert.equal(r.meetsMinimumSample, false);
  assert.equal(r.roiBootstrapCI, null);
});

test("at or above the minimum sample size, bootstrap CI is a real interval around the true ROI", () => {
  // 20 trials, all identical +50% ROI -> bootstrap CI should collapse tightly around 0.5.
  const trials = Array.from({ length: MIN_SAMPLE_SIZE }, (_, i) =>
    trial({ conditionId: `c${i}`, eventKey: `e${i}`, usdcStaked: 10, netReturn: 5 })
  );
  const r = computeStrategyResult(trials, config);
  assert.equal(r.meetsMinimumSample, true);
  assert.ok(r.roiBootstrapCI);
  const [lo, hi] = r.roiBootstrapCI!;
  assert.ok(lo <= 0.5 && hi >= 0.5, `expected CI to contain 0.5, got [${lo}, ${hi}]`);
});

test("bootstrap CI resamples events, not trials: a handful of correlated events gives a wider CI than the same trial count spread across many independent events", () => {
  // Same 40 trials, same overall win/loss mix and ROI either way — only the
  // number of distinct events (eventKey) differs. Mirrors the real
  // 0x_exit-wallet finding: 253 markets that were really only 16 events.
  // Events differ sharply from each other (all-win, all-lose, mostly-win,
  // mostly-lose) so which events a resample happens to draw matters a lot
  // -- if every event had the same internal mix, clustering wouldn't
  // introduce any between-event variance for the bootstrap to pick up.
  const winsPerEvent = [10, 0, 8, 2]; // sums to 20/40 = 50% overall, same either way
  const clusteredTrials: BacktestTrial[] = [];
  for (let e = 0; e < 4; e++) {
    for (let i = 0; i < 10; i++) {
      const won = i < winsPerEvent[e];
      clusteredTrials.push(
        trial({ conditionId: `c${e}-${i}`, eventKey: `event${e}`, usdcStaked: 10, won, netReturn: won ? 8 : -10 })
      );
    }
  }
  const spreadTrials: BacktestTrial[] = clusteredTrials.map((t, i) => ({ ...t, eventKey: `event${i}` }));

  const clusteredResult = computeStrategyResult(clusteredTrials, config);
  const spreadResult = computeStrategyResult(spreadTrials, config);

  assert.equal(clusteredResult.distinctEvents, 4);
  assert.equal(spreadResult.distinctEvents, 40);
  // Same trials, same aggregate ROI either way -- only the clustering differs.
  assert.equal(clusteredResult.roi, spreadResult.roi);

  assert.ok(clusteredResult.roiBootstrapCI);
  assert.ok(spreadResult.roiBootstrapCI);
  const clusteredWidth = clusteredResult.roiBootstrapCI![1] - clusteredResult.roiBootstrapCI![0];
  const spreadWidth = spreadResult.roiBootstrapCI![1] - spreadResult.roiBootstrapCI![0];
  assert.ok(
    clusteredWidth > spreadWidth,
    `expected the 4-event CI (width ${clusteredWidth.toFixed(3)}) to be wider than the 40-event CI (width ${spreadWidth.toFixed(3)})`
  );
});

test("bootstrap CI is null when every trial shares a single event (one cluster can't be resampled into an interval)", () => {
  const trials = Array.from({ length: MIN_SAMPLE_SIZE }, (_, i) => trial({ conditionId: `c${i}`, eventKey: "only-event" }));
  const r = computeStrategyResult(trials, config);
  assert.equal(r.distinctEvents, 1);
  assert.equal(r.roiBootstrapCI, null);
});

test("profitFactor is null when there are no losing trials (avoids division by zero)", () => {
  const trials = [trial({ won: true, netReturn: 2 }), trial({ won: true, netReturn: 3 })];
  const r = computeStrategyResult(trials, config);
  assert.equal(r.profitFactor, null);
});

test("categoryBreakdown groups net P&L and win rate per category", () => {
  const trials = [
    trial({ category: "sports", conditionId: "c1", eventKey: "e1", won: true, netReturn: 2 }),
    trial({ category: "sports", conditionId: "c2", eventKey: "e2", won: false, netReturn: -1 }),
    trial({ category: "politics", conditionId: "c3", eventKey: "e3", won: true, netReturn: 5 }),
  ];
  const r = computeStrategyResult(trials, config);
  assert.equal(r.categoryBreakdown.sports.n, 2);
  assert.equal(r.categoryBreakdown.sports.netPnl, 1);
  assert.equal(r.categoryBreakdown.sports.winRate, 0.5);
  assert.equal(r.categoryBreakdown.politics.n, 1);
  assert.equal(r.categoryBreakdown.politics.winRate, 1);
});
