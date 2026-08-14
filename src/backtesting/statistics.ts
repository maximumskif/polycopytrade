// Pure statistics over a resolved BacktestTrial[] — the shared computation
// every backtest in the project should go through instead of each script
// hand-rolling its own summarize() (docs/AUDIT.md §3/§11: "two structurally
// different, inconsistent backtests" was a named problem).

import type { BacktestConfig, BacktestTrial, StrategyResult } from "../domain/types";

// Below this many resolved trials, a bootstrap CI and profit factor are
// unstable enough to be misleading — computed as null and flagged via
// meetsMinimumSample rather than reported as if they were reliable.
export const MIN_SAMPLE_SIZE = 20;
const BOOTSTRAP_RESAMPLES = 2000;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

// Peak-to-trough of the cumulative-P&L series in entry-timestamp order,
// expressed as a fraction of total capital staked. This is an
// approximation, not a true bankroll drawdown: it orders by ENTRY time
// because trials don't carry a resolution timestamp, so a trial's P&L is
// treated as "realized" in entry order rather than resolution order. Real
// money's actual drawdown timeline would differ. Documented rather than
// hidden — see docs/AUDIT.md's statistical-validity discussion.
function maxDrawdownPct(trialsInEntryOrder: BacktestTrial[], totalStaked: number): number {
  if (totalStaked === 0) return 0;
  let cumulative = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trialsInEntryOrder) {
    cumulative += t.netReturn;
    peak = Math.max(peak, cumulative);
    maxDD = Math.max(maxDD, peak - cumulative);
  }
  return maxDD / totalStaked;
}

// Resamples whole EVENTS (with every trial they contain), not individual
// trials. Resampling trials directly would treat, e.g., all 19 rungs of one
// month's WTI ladder as 19 independent draws, when they're really one
// correlated bet on where oil settled that month (see
// effectiveIndependentSampleCount / docs/AUDIT.md §7) — a trial-level
// bootstrap silently understates the true CI width by ignoring that
// correlation. A block/cluster bootstrap over events reflects the real
// effective sample size instead.
function bootstrapRoiCI(trials: BacktestTrial[]): [number, number] | null {
  if (trials.length < MIN_SAMPLE_SIZE) return null;
  const eventGroups = new Map<string, BacktestTrial[]>();
  for (const t of trials) {
    const group = eventGroups.get(t.eventKey);
    if (group) group.push(t);
    else eventGroups.set(t.eventKey, [t]);
  }
  const events = [...eventGroups.values()];
  // A single cluster can't be resampled into a meaningful interval — every
  // draw is the same event repeated, so the "CI" would just be a point.
  if (events.length < 2) return null;

  const rois: number[] = [];
  for (let i = 0; i < BOOTSTRAP_RESAMPLES; i++) {
    let staked = 0;
    let net = 0;
    for (let j = 0; j < events.length; j++) {
      const event = events[Math.floor(Math.random() * events.length)];
      for (const t of event) {
        staked += t.usdcStaked;
        net += t.netReturn;
      }
    }
    rois.push(staked > 0 ? net / staked : 0);
  }
  rois.sort((a, b) => a - b);
  const lo = rois[Math.floor(BOOTSTRAP_RESAMPLES * 0.025)];
  const hi = rois[Math.floor(BOOTSTRAP_RESAMPLES * 0.975)];
  return [lo, hi];
}

export function computeStrategyResult(trials: BacktestTrial[], config: BacktestConfig): StrategyResult {
  const resolved = trials.filter((t) => t.resolved).sort((a, b) => a.entryTimestamp - b.entryTimestamp);
  const n = resolved.length;

  const totalStaked = resolved.reduce((s, t) => s + t.usdcStaked, 0);
  const netPnl = resolved.reduce((s, t) => s + t.netReturn, 0);
  const grossReturned = totalStaked + netPnl;
  const wins = resolved.filter((t) => t.won === true);
  const losses = resolved.filter((t) => t.won === false);

  const perTrialReturn = resolved.map((t) => (t.usdcStaked > 0 ? t.netReturn / t.usdcStaked : 0));
  const winReturns = wins.map((t) => t.netReturn);
  const lossReturns = losses.map((t) => t.netReturn);
  const negativePerTrialReturn = perTrialReturn.filter((r) => r < 0);

  const grossWin = winReturns.reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(lossReturns.reduce((s, x) => s + x, 0));

  const distinctMarkets = new Set(resolved.map((t) => `${t.conditionId}:${t.outcome}`)).size;
  const distinctEvents = new Set(resolved.map((t) => t.eventKey)).size;

  const categoryBreakdown: StrategyResult["categoryBreakdown"] = {};
  for (const t of resolved) {
    const bucket = (categoryBreakdown[t.category] ??= { n: 0, netPnl: 0, winRate: 0 });
    bucket.n += 1;
    bucket.netPnl += t.netReturn;
  }
  for (const [cat, bucket] of Object.entries(categoryBreakdown)) {
    const catTrials = resolved.filter((t) => t.category === cat);
    const catWins = catTrials.filter((t) => t.won === true).length;
    bucket.winRate = catTrials.length ? catWins / catTrials.length : 0;
  }

  return {
    config,
    trialCount: n,
    distinctMarkets,
    distinctEvents,
    effectiveIndependentSampleCount: distinctEvents,
    totalStaked,
    grossReturned,
    netPnl,
    roi: totalStaked > 0 ? netPnl / totalStaked : 0,
    winRate: n > 0 ? wins.length / n : 0,
    expectedValuePerDollar: mean(perTrialReturn),
    avgWin: wins.length ? mean(winReturns) : 0,
    avgLoss: losses.length ? mean(lossReturns) : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownPct: maxDrawdownPct(resolved, totalStaked),
    volatility: stdev(perTrialReturn),
    sharpeLike: stdev(perTrialReturn) > 0 ? mean(perTrialReturn) / stdev(perTrialReturn) : null,
    sortinoLike: negativePerTrialReturn.length > 1 && stdev(negativePerTrialReturn) > 0 ? mean(perTrialReturn) / stdev(negativePerTrialReturn) : null,
    roiBootstrapCI: bootstrapRoiCI(resolved),
    categoryBreakdown,
    meetsMinimumSample: n >= MIN_SAMPLE_SIZE,
  };
}
