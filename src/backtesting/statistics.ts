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
const BOOTSTRAP_SEED = 0x5eed2026;

// mulberry32: tiny, fast, well-distributed 32-bit PRNG -- plenty for
// bootstrap index draws, and seedable, unlike Math.random.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Exported so other modules that need the same basic stats (e.g.
// scoring/walletScore.ts's consistency check, research/volatilityBreakout.ts's
// compression detection) share one implementation instead of hand-rolling
// their own — this file's own header already states that's the point of
// putting shared computation here (code-review finding, 2026-09-08).
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function stdev(xs: number[]): number {
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
  return eventClusteredRoiCI(trials, 0.95);
}

// The same event-clustered bootstrap at an arbitrary two-sided confidence
// level -- exported for research/comparisons.ts's Bonferroni-style rough
// guide (e.g. a 1 - 0.05/16 interval when 16 buckets were compared). Wide
// levels put very few resamples in each tail, so callers asking for more
// than 95% should pass more resamples. At confidence=0.95 and the default
// resample count this is exactly the computation computeStrategyResult
// reports (the epsilon only guards float error in the tail index).
export function eventClusteredRoiCI(trials: BacktestTrial[], confidence: number, resamples = BOOTSTRAP_RESAMPLES): [number, number] | null {
  if (!(confidence > 0 && confidence < 1)) throw new Error(`confidence must be in (0, 1), got ${confidence}`);
  if (trials.length < MIN_SAMPLE_SIZE) return null;
  const eventGroups = new Map<string, BacktestTrial[]>();
  for (const t of trials) {
    const group = eventGroups.get(t.eventKey);
    if (group) group.push(t);
    else eventGroups.set(t.eventKey, [t]);
  }
  // Deterministic since 2026-09-24 (item 52): Math.random made identical
  // trials score differently run to run (vito3corleone 57/58/59), which
  // can flip a wallet across the qualityScore 50 cap. Events are ordered by
  // key (so trial arrival order -- e.g. DB vs API row order -- can't change
  // which event a draw picks) and drawn with a fixed-seed PRNG. Per-event
  // sums are precomputed once; each draw then just adds two numbers.
  const events = [...eventGroups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => ({
      staked: group.reduce((sum, t) => sum + t.usdcStaked, 0),
      net: group.reduce((sum, t) => sum + t.netReturn, 0),
    }));
  // A single cluster can't be resampled into a meaningful interval — every
  // draw is the same event repeated, so the "CI" would just be a point.
  if (events.length < 2) return null;

  const random = mulberry32(BOOTSTRAP_SEED);
  const rois: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let staked = 0;
    let net = 0;
    for (let j = 0; j < events.length; j++) {
      const event = events[Math.floor(random() * events.length)];
      staked += event.staked;
      net += event.net;
    }
    rois.push(staked > 0 ? net / staked : 0);
  }
  rois.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  const lo = rois[Math.min(resamples - 1, Math.floor(resamples * tail + 1e-9))];
  const hi = rois[Math.min(resamples - 1, Math.floor(resamples * (1 - tail) + 1e-9))];
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
    sortinoLike:
      negativePerTrialReturn.length > 1 && stdev(negativePerTrialReturn) > 0 ? mean(perTrialReturn) / stdev(negativePerTrialReturn) : null,
    roiBootstrapCI: bootstrapRoiCI(resolved),
    categoryBreakdown,
    meetsMinimumSample: n >= MIN_SAMPLE_SIZE,
  };
}
