import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWalletScore, computeProfitConcentration, computeConsistencyScore, computeQualityScore } from "../src/scoring/walletScore";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../src/backtesting/statistics";
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

// Enough distinct, well-spread-out resolved trials to clear MIN_SAMPLE_SIZE
// without tripping any of the other flags under test, unless a test
// specifically stacks more trials on top.
function baselineTrials(n: number, spacingSeconds = DAY): BacktestTrial[] {
  return Array.from({ length: n }, (_, i) =>
    trial({ conditionId: `c${i}`, eventKey: `e${i}`, entryTimestamp: NOW - (n - i) * spacingSeconds })
  );
}

function baselineActivity(n: number, spacingSeconds = DAY): Activity[] {
  return Array.from({ length: n }, (_, i) => activityRow({ conditionId: `c${i}`, timestamp: NOW - (n - i) * spacingSeconds }));
}

test("a wallet with 2 distinct events is flagged one-shot", () => {
  const trials = [
    trial({ conditionId: "c1", eventKey: "e1", entryTimestamp: NOW - 2 * DAY }),
    trial({ conditionId: "c2", eventKey: "e2", entryTimestamp: NOW - DAY }),
  ];
  const activity = [activityRow({ conditionId: "c1", timestamp: NOW - 2 * DAY }), activityRow({ conditionId: "c2", timestamp: NOW - DAY })];
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(score.flags.includes("one-shot"));
});

test("a wallet with many distinct events is not flagged one-shot", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE);
  const activity = baselineActivity(MIN_SAMPLE_SIZE);
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(!score.flags.includes("one-shot"));
});

test("a wallet inactive for over 30 days is flagged dormant", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE);
  // Last real trade was 60 days ago -> daysSinceLastActivity > 30.
  const activity = Array.from({ length: MIN_SAMPLE_SIZE }, (_, i) =>
    activityRow({ conditionId: `c${i}`, timestamp: NOW - 60 * DAY - (MIN_SAMPLE_SIZE - i) * DAY })
  );
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(score.flags.includes("dormant"));
  assert.ok(score.daysSinceLastActivity > 30);
});

test("a wallet active within the last 30 days is not flagged dormant", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE);
  const activity = baselineActivity(MIN_SAMPLE_SIZE); // most recent row is "today"
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(!score.flags.includes("dormant"));
});

test("a wallet whose trials are >70% politics is flagged election-only", () => {
  const trials = Array.from({ length: MIN_SAMPLE_SIZE }, (_, i) =>
    trial({
      conditionId: `c${i}`,
      eventKey: `e${i}`,
      category: i < MIN_SAMPLE_SIZE - 2 ? "politics" : "sports", // 18/20 = 90% politics
      entryTimestamp: NOW - (MIN_SAMPLE_SIZE - i) * DAY,
    })
  );
  const activity = baselineActivity(MIN_SAMPLE_SIZE);
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(score.flags.includes("election-only"));
  assert.ok(score.electionShare > 0.7);
});

test("a wallet with a mixed category spread is not flagged election-only", () => {
  const trials = Array.from({ length: MIN_SAMPLE_SIZE }, (_, i) =>
    trial({
      conditionId: `c${i}`,
      eventKey: `e${i}`,
      category: i % 2 === 0 ? "politics" : "sports",
      entryTimestamp: NOW - (MIN_SAMPLE_SIZE - i) * DAY,
    })
  );
  const activity = baselineActivity(MIN_SAMPLE_SIZE);
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(!score.flags.includes("election-only"));
});

test("a wallet with over half its stake in one event is flagged highly-concentrated", () => {
  const bigEvent = Array.from({ length: 5 }, (_, i) =>
    trial({ conditionId: `big${i}`, eventKey: "big-event", usdcStaked: 100, entryTimestamp: NOW - (MIN_SAMPLE_SIZE - i) * DAY })
  );
  const restCount = MIN_SAMPLE_SIZE - bigEvent.length;
  const rest = Array.from({ length: restCount }, (_, i) =>
    trial({ conditionId: `r${i}`, eventKey: `e${i}`, usdcStaked: 10, entryTimestamp: NOW - (restCount - i) * DAY })
  );
  const trials = [...bigEvent, ...rest];
  const activity = baselineActivity(MIN_SAMPLE_SIZE);
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(score.flags.includes("highly-concentrated"));
  assert.ok(score.concentrationTopEventShare > 0.5);
});

test("a wallet with stake spread evenly across events is not flagged highly-concentrated", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE); // each trial is its own event, equal stake
  const activity = baselineActivity(MIN_SAMPLE_SIZE);
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(!score.flags.includes("highly-concentrated"));
});

test("a wallet with 50+ trades spaced under 5 seconds apart is flagged uncopyable-high-frequency", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE);
  const activity = Array.from({ length: 60 }, (_, i) => activityRow({ conditionId: `c${i % 20}`, timestamp: NOW - (60 - i) * 2 }));
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(score.flags.includes("uncopyable-high-frequency"));
});

test("a wallet trading at ordinary human cadence is not flagged uncopyable-high-frequency", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE);
  const activity = baselineActivity(MIN_SAMPLE_SIZE); // one day apart
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(!score.flags.includes("uncopyable-high-frequency"));
});

test("a wallet below the minimum trial sample size is flagged insufficient-sample", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE - 1);
  const activity = baselineActivity(MIN_SAMPLE_SIZE - 1);
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(score.flags.includes("insufficient-sample"));
  assert.equal(result.meetsMinimumSample, false);
});

test("a wallet at or above the minimum trial sample size is not flagged insufficient-sample", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE);
  const activity = baselineActivity(MIN_SAMPLE_SIZE);
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(!score.flags.includes("insufficient-sample"));
});

test("a clean, diversified, active, low-frequency wallet with enough sample gets zero flags", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE);
  const activity = baselineActivity(MIN_SAMPLE_SIZE);
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.deepEqual(score.flags, []);
});

test("non-TRADE activity rows are excluded from the high-frequency cadence check", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE);
  // Interleave 40 REWARD rows one second apart (should be ignored) with the
  // normal day-spaced TRADE rows -- must not trip uncopyable-high-frequency.
  const rewards = Array.from({ length: 40 }, (_, i) => activityRow({ type: "REWARD", side: "", conditionId: "", timestamp: NOW - i }));
  const activity = [...baselineActivity(MIN_SAMPLE_SIZE), ...rewards];
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);
  assert.ok(!score.flags.includes("uncopyable-high-frequency"));
});

// ---------------------------------------------------------------------
// Wallet Quality Score (docs/IMPROVEMENT_PLAN.md's "profit-directed" work):
// composite score + its two new supporting metrics, profit concentration
// and rolling-window consistency.
// ---------------------------------------------------------------------

test("computeProfitConcentration: one event carrying all the profit scores near 1", () => {
  const trials = [
    trial({ conditionId: "big", eventKey: "big-event", netReturn: 1000 }),
    trial({ conditionId: "a", eventKey: "ea", netReturn: 5 }),
    trial({ conditionId: "b", eventKey: "eb", netReturn: -3 }), // losses excluded from the profit-share denominator
  ];
  const { topEventShare, top3EventShare } = computeProfitConcentration(trials);
  assert.ok(topEventShare > 0.98, `expected topEventShare near 1, got ${topEventShare}`);
  assert.equal(top3EventShare, 1); // only 2 events had positive P&L at all, both counted in "top 3"
});

test("computeProfitConcentration: profit spread evenly across many events scores low", () => {
  const trials = Array.from({ length: 20 }, (_, i) => trial({ conditionId: `c${i}`, eventKey: `e${i}`, netReturn: 10 }));
  const { topEventShare } = computeProfitConcentration(trials);
  assert.ok(topEventShare < 0.1, `expected an even split to score low, got ${topEventShare}`);
});

test("computeProfitConcentration: a wallet with no net-positive events returns zero, not NaN", () => {
  const trials = [trial({ conditionId: "a", eventKey: "ea", netReturn: -5, won: false })];
  const { topEventShare, top3EventShare } = computeProfitConcentration(trials);
  assert.equal(topEventShare, 0);
  assert.equal(top3EventShare, 0);
});

test("computeConsistencyScore: fewer than 2 weekly windows of history returns null, not a penalized score", () => {
  const trials = [
    trial({ conditionId: "a", eventKey: "ea", entryTimestamp: NOW - 2 * 3600 }),
    trial({ conditionId: "b", eventKey: "eb", entryTimestamp: NOW - 3600 }),
  ];
  assert.equal(computeConsistencyScore(trials, config), null);
});

test("computeConsistencyScore: an edge that decays from strongly positive to negative scores lower than one that improves", () => {
  const oldest = NOW - 21 * DAY;
  const trialAt = (daysFromOldest: number, netReturn: number) =>
    trial({
      conditionId: `c${daysFromOldest}-${netReturn}`,
      eventKey: `e${daysFromOldest}-${netReturn}`,
      entryTimestamp: oldest + daysFromOldest * DAY,
      usdcStaked: 10,
      netReturn,
      won: netReturn > 0,
    });

  // Three weekly buckets each: decaying goes +80% -> 0% -> -80% ROI (Phase
  // 1f's 0x_exit shape); improving is the mirror image.
  const decaying = [trialAt(0, 8), trialAt(1, 8), trialAt(7, 0), trialAt(8, 0), trialAt(14, -8), trialAt(15, -8)];
  const improving = [trialAt(0, -8), trialAt(1, -8), trialAt(7, 0), trialAt(8, 0), trialAt(14, 8), trialAt(15, 8)];

  const decayingScore = computeConsistencyScore(decaying, config);
  const improvingScore = computeConsistencyScore(improving, config);
  assert.ok(decayingScore !== null && improvingScore !== null);
  assert.ok(improvingScore! > decayingScore!, `expected improving (${improvingScore}) > decaying (${decayingScore})`);
});

test("computeQualityScore: a profitable, diversified, low-drawdown wallet scores well above a losing, concentrated one", () => {
  const goodTrials = baselineTrials(30); // all winners, one event each, spread over ~30 days
  const goodResult = computeStrategyResult(goodTrials, config);
  const goodConcentration = computeProfitConcentration(goodTrials);
  const goodConsistency = computeConsistencyScore(goodTrials, config);
  const good = computeQualityScore(goodResult, goodConcentration, goodConsistency);

  const badTrials = [
    ...Array.from({ length: 25 }, (_, i) =>
      trial({
        conditionId: `bad${i}`,
        eventKey: "one-big-loss",
        usdcStaked: 20,
        netReturn: -15,
        won: false,
        entryTimestamp: NOW - (30 - i) * DAY,
      })
    ),
  ];
  const badResult = computeStrategyResult(badTrials, config);
  const badConcentration = computeProfitConcentration(badTrials);
  const badConsistency = computeConsistencyScore(badTrials, config);
  const bad = computeQualityScore(badResult, badConcentration, badConsistency);

  assert.ok(good.score > bad.score, `expected good (${good.score}) > bad (${bad.score})`);
  assert.ok(good.score >= 0 && good.score <= 100);
  assert.ok(bad.score >= 0 && bad.score <= 100);
});

test("computeWalletScore populates the new quality-score fields alongside the existing flags", () => {
  const trials = baselineTrials(MIN_SAMPLE_SIZE);
  const activity = baselineActivity(MIN_SAMPLE_SIZE);
  const result = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, result);

  assert.ok(score.qualityScore >= 0 && score.qualityScore <= 100);
  assert.ok(score.profitConcentrationTopEventShare >= 0 && score.profitConcentrationTopEventShare <= 1);
  assert.ok(score.profitConcentrationTop3EventShare >= score.profitConcentrationTopEventShare);
  assert.ok(score.qualityScoreComponents.roiLowerBound > 0.5); // baselineTrials is all winners at +50% ROI
});
