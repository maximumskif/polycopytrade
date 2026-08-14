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
import { computeStrategyResult } from "../backtesting/statistics";
import type { BacktestTrial, StrategyResult, WalletFlag, WalletScore } from "../domain/types";
import type { TrackedWallet } from "../wallets";

const DORMANT_DAYS = 30;
const ONE_SHOT_MAX_EVENTS = 3;
const ELECTION_SHARE_THRESHOLD = 0.7;
const CONCENTRATION_THRESHOLD = 0.5;
const HIGH_FREQUENCY_MEDIAN_GAP_SECONDS = 5;
const HIGH_FREQUENCY_MIN_FILLS = 50;

function median(xs: number[]): number {
  if (xs.length === 0) return Infinity;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

  return {
    address: wallet.address,
    label: wallet.label,
    flags,
    distinctEvents: strategyResult.distinctEvents,
    activitySpanDays,
    daysSinceLastActivity,
    concentrationTopEventShare,
    electionShare,
    netPnl: strategyResult.netPnl,
    roi: strategyResult.roi,
    winRate: strategyResult.winRate,
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
