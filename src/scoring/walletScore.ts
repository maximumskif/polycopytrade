// Replaces "leaderboard rank" as the basis for judging a wallet
// (docs/AUDIT.md's "Wallet evaluation" ask) with checks the project has
// already learned to do BY HAND, over and over, across Phase 1b-1g:
// distinguish a one-shot election bet from a repeatable trader, flag
// dormant wallets, flag concentration in one event. Encodes that manual
// process as reusable, tested code instead of a fresh ad-hoc read each time.
//
// Split into a pure `computeWalletScore` (testable with synthetic data, no
// network) and an async `scoreWallet` orchestrator (pulls real activity +
// runs it through the Phase 2 engine) — the same pattern as
// engine.ts/statistics.ts.

import { getActivityFromStart, type Activity } from "../api/client";
import { buildTrials, defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE, mean } from "../backtesting/statistics";
import { computeRollingWindowResults } from "../backtesting/rollingWindow";
import type { BacktestConfig, BacktestTrial, StrategyResult, WalletFlag, WalletQualityScoreComponents, WalletScore } from "../domain/types";
import type { TrackedWallet } from "../wallets";

const DORMANT_DAYS = 30;
const ONE_SHOT_MAX_EVENTS = 3;
const ELECTION_SHARE_THRESHOLD = 0.7;
const CONCENTRATION_THRESHOLD = 0.5;
const HIGH_FREQUENCY_MEDIAN_GAP_SECONDS = 5;
const HIGH_FREQUENCY_MIN_FILLS = 50;
const CONSISTENCY_WINDOW_SECONDS = 7 * 86400; // weekly, matching Phase 1f's original hand-built "net P&L by week" cadence

function median(xs: number[]): number {
  if (xs.length === 0) return Infinity;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// Maps an unbounded number to (0, 1), centered on 0.5 at x=0 -- used for
// ROI/risk-adjusted-return terms that have no natural [0,1] range. `scale`
// is "how big a value counts as strongly good/bad"; these are starting
// points to be tuned once the composite score has been run against real
// tracked wallets (docs/IMPROVEMENT_PLAN.md's validation step), not a
// theoretically-derived constant.
function squash(x: number, scale: number): number {
  return 0.5 + 0.5 * Math.tanh(x / scale);
}

// "Lucky wallet" detection (distinct from concentrationTopEventShare, which
// measures STAKE concentration): what fraction of this wallet's total
// realized PROFIT came from its single best / top-3 best events. A wallet
// can spread stake evenly across 50 events and still owe 90% of its P&L to
// one outsized win -- that's not a repeatable edge, per docs/AUDIT.md's
// one-shot-bet lesson generalized from stake to profit. Grouped by event
// (not fill or market) for the same sample-inflation reason every other
// metric in this project is (docs/AUDIT.md §7).
export function computeProfitConcentration(trials: BacktestTrial[]): { topEventShare: number; top3EventShare: number } {
  const resolved = trials.filter((t) => t.resolved);
  const pnlByEvent = new Map<string, number>();
  for (const t of resolved) pnlByEvent.set(t.eventKey, (pnlByEvent.get(t.eventKey) ?? 0) + t.netReturn);
  const positiveEventPnls = [...pnlByEvent.values()].filter((p) => p > 0).sort((a, b) => b - a);
  const totalPositive = positiveEventPnls.reduce((s, x) => s + x, 0);
  if (totalPositive <= 0) return { topEventShare: 0, top3EventShare: 0 };
  return {
    topEventShare: positiveEventPnls[0] / totalPositive,
    top3EventShare: positiveEventPnls.slice(0, 3).reduce((s, x) => s + x, 0) / totalPositive,
  };
}

// Is this wallet's edge stable over time, or does it look like Phase 1f's
// 0x_exit finding (wk0 +49.5% net decaying to wk3 -17.6%, the edge closing
// out within the wallet's own trading window)? Buckets into weekly windows
// (rollingWindow.ts) and blends how often a window is net-positive with
// whether the trend across the history is improving or decaying. Returns
// null with fewer than 2 windows -- a short history is an unanswered
// question, not evidence of instability, so it must not be scored as if it
// were bad.
export function computeConsistencyScore(trials: BacktestTrial[], config: BacktestConfig): number | null {
  const windows = computeRollingWindowResults(trials, config, CONSISTENCY_WINDOW_SECONDS).filter((w) => w.result.trialCount > 0);
  if (windows.length < 2) return null;

  const rois = windows.map((w) => w.result.roi);
  const positiveShare = rois.filter((r) => r >= 0).length / rois.length;

  const halfSize = Math.max(1, Math.floor(rois.length / 2));
  const trend = mean(rois.slice(-halfSize)) - mean(rois.slice(0, halfSize)); // positive = improving, negative = decaying
  const trendComponent = squash(trend, 0.5);

  return clamp01(0.5 * positiveShare + 0.5 * trendComponent);
}

// Composite 0-100 "how good is this wallet, given it already cleared the
// hard veto flags" score -- translates the blueprint's weighted wallet-
// quality formula onto metrics this project's backtesting engine already
// computes, rather than a copy of its original (DEX-specific) weights.
// Deliberately NOT a replacement for the flags: a wallet can score well
// here and still be un-copyable (e.g. uncopyable-high-frequency) --
// `flags` is still the hard gate, this is what to compare AMONG survivors.
export function computeQualityScore(
  strategyResult: StrategyResult,
  profitConcentration: { topEventShare: number; top3EventShare: number },
  consistencyScore: number | null
): { score: number; components: WalletQualityScoreComponents } {
  const roiLowerBound = strategyResult.roiBootstrapCI ? strategyResult.roiBootstrapCI[0] : strategyResult.roi;
  // sortinoLike is null both for "too good to have a meaningful downside"
  // and "not enough losing trials to compute one" -- sharpeLike as a
  // fallback, then a small fixed nudge from the sign of expected value if
  // even that's null (zero-variance return series), rather than treating
  // "no signal" as "bad."
  const riskAdjustedRaw =
    strategyResult.sortinoLike ??
    strategyResult.sharpeLike ??
    (strategyResult.expectedValuePerDollar > 0 ? 2 : strategyResult.expectedValuePerDollar < 0 ? -2 : 0);

  const components: WalletQualityScoreComponents = {
    roiLowerBound: squash(roiLowerBound, 0.5),
    riskAdjustedReturn: squash(riskAdjustedRaw, 2),
    consistency: consistencyScore ?? 0.5, // unknown history is neutral, not penalized
    profitConcentration: 1 - clamp01(profitConcentration.topEventShare),
    drawdown: 1 - clamp01(strategyResult.maxDrawdownPct),
    sampleSize: clamp01(strategyResult.effectiveIndependentSampleCount / (MIN_SAMPLE_SIZE * 2)),
  };

  const rawScore01 =
    0.3 * components.roiLowerBound +
    0.2 * components.riskAdjustedReturn +
    0.15 * components.consistency +
    0.15 * components.profitConcentration +
    0.1 * components.drawdown +
    0.1 * components.sampleSize;

  // Profitability floor: found live 2026-09-06 validating this against
  // SDTrading (real net -1.7% ROI, no veto flags) -- it scored 63/100
  // purely because near-zero concentration/drawdown and a huge sample
  // (each individually near-perfect) outweighed its two below-neutral
  // profitability terms. Hygiene should make a PROFITABLE wallet's edge
  // more trustworthy; it must not be able to rescue a wallet that's
  // actually losing money into "trade candidate" territory. Only caps when
  // BOTH profitability terms are below neutral (0.5) -- a wallet with just
  // one weak term (e.g. 0x1b20a0's wide-CI roiLowerBound=0.37 but
  // riskAdjustedReturn=0.54) is a real, uncertain-but-live candidate, not
  // the "clearly not profitable" case this guards against.
  const PROFITABILITY_FLOOR_CAP = 0.5;
  const bothProfitabilityTermsWeak = components.roiLowerBound < 0.5 && components.riskAdjustedReturn < 0.5;
  const score01 = bothProfitabilityTermsWeak ? Math.min(rawScore01, PROFITABILITY_FLOOR_CAP) : rawScore01;

  return { score: Math.round(score01 * 100), components };
}

export function computeWalletScore(
  wallet: { address: string; label: string },
  activity: Activity[],
  trials: BacktestTrial[],
  strategyResult: StrategyResult
): WalletScore {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const timestamps = activity.map((a) => a.timestamp);
  const activitySpanDays = timestamps.length ? (Math.max(...timestamps) - Math.min(...timestamps)) / 86400 : 0;
  const daysSinceLastActivity = timestamps.length ? (nowSeconds - Math.max(...timestamps)) / 86400 : Infinity;

  const resolvedTrials = trials.filter((t) => t.resolved);

  const stakedByEvent = new Map<string, number>();
  for (const t of resolvedTrials) stakedByEvent.set(t.eventKey, (stakedByEvent.get(t.eventKey) ?? 0) + t.usdcStaked);
  const totalStaked = [...stakedByEvent.values()].reduce((s, x) => s + x, 0);
  const topEventStake = stakedByEvent.size ? Math.max(...stakedByEvent.values()) : 0;
  const concentrationTopEventShare = totalStaked > 0 ? topEventStake / totalStaked : 0;

  const politicsCount = resolvedTrials.filter((t) => t.category === "politics").length;
  const electionShare = resolvedTrials.length ? politicsCount / resolvedTrials.length : 0;

  const tradeTimestamps = activity
    .filter((a) => a.type === "TRADE")
    .map((a) => a.timestamp)
    .sort((a, b) => a - b);
  const gaps = tradeTimestamps.slice(1).map((t, i) => t - tradeTimestamps[i]);
  const medianGapSeconds = median(gaps);

  const flags: WalletFlag[] = [];
  if (strategyResult.distinctEvents > 0 && strategyResult.distinctEvents <= ONE_SHOT_MAX_EVENTS) flags.push("one-shot");
  if (daysSinceLastActivity > DORMANT_DAYS) flags.push("dormant");
  if (electionShare > ELECTION_SHARE_THRESHOLD) flags.push("election-only");
  if (concentrationTopEventShare > CONCENTRATION_THRESHOLD) flags.push("highly-concentrated");
  if (tradeTimestamps.length >= HIGH_FREQUENCY_MIN_FILLS && medianGapSeconds < HIGH_FREQUENCY_MEDIAN_GAP_SECONDS) {
    flags.push("uncopyable-high-frequency");
  }
  if (!strategyResult.meetsMinimumSample) flags.push("insufficient-sample");

  const profitConcentration = computeProfitConcentration(resolvedTrials);
  const consistencyScore = computeConsistencyScore(trials, strategyResult.config);
  const { score: qualityScore, components: qualityScoreComponents } = computeQualityScore(
    strategyResult,
    profitConcentration,
    consistencyScore
  );

  return {
    address: wallet.address,
    label: wallet.label,
    flags,
    distinctEvents: strategyResult.distinctEvents,
    activitySpanDays,
    daysSinceLastActivity,
    concentrationTopEventShare,
    profitConcentrationTopEventShare: profitConcentration.topEventShare,
    profitConcentrationTop3EventShare: profitConcentration.top3EventShare,
    electionShare,
    medianGapSeconds,
    consistencyScore,
    netPnl: strategyResult.netPnl,
    roi: strategyResult.roi,
    winRate: strategyResult.winRate,
    qualityScore,
    qualityScoreComponents,
    strategyResult,
  };
}

export async function scoreWallet(wallet: TrackedWallet): Promise<WalletScore> {
  const activity = await getActivityFromStart(wallet.address, wallet.historyPages ?? 10);
  const datasetCutoff = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : Math.floor(Date.now() / 1000);
  const config = defaultBacktestConfig({ walletAddresses: [wallet.address], datasetCutoff });
  const trials = await buildTrials(wallet.address, activity, config);
  const strategyResult = computeStrategyResult(trials, config);
  return computeWalletScore(wallet, activity, trials, strategyResult);
}
