// Strategy-translation pass, item 2 (docs/IMPROVEMENT_PLAN.md Track G.19):
// "smart-money accumulation/divergence." Genuinely different from the two
// prior wallet-crowd ideas already tested and negatived in this project:
//
// - consensusSignal.ts asked "does agreement among the FULL tracked-wallet
//   pool (mostly mediocre) carry signal" -- clean negative (50.8% win,
//   -5.0% ROI, docs/AUDIT.md 2026-08-17).
// - ouOverBias.ts asked "is one wallet's own edge a market-wide
//   inefficiency" -- clean negative.
//
// This asks a third, different question: does a market where price is
// quietly flat (or moving the OPPOSITE direction) while 2+ of this
// project's HIGHEST-QUALITY-SCORED wallets (not just any tracked wallet --
// computeQualityScore/computeWalletScore from src/scoring/walletScore.ts)
// independently net-buy the same outcome within a real trailing window,
// predict the eventual resolution better than the market's own price
// already implies?
//
// Operational definitions (concrete, decided before writing the detection
// code, not tuned after seeing results):
// - "highest-quality-scored wallet" = a tracked wallet that (a) computeWalletScore
//   assigns ZERO of its hard veto flags (one-shot/dormant/election-only/
//   highly-concentrated/uncopyable-high-frequency/insufficient-sample --
//   the same bar this project already uses to call a wallet a real
//   candidate, docs/AUDIT.md's "Net result" wallet-sourcing conclusion) and
//   (b) whose qualityScore is used to RANK the survivors -- this is a
//   different, stricter pool than consensusSignal.ts's "all 68 tracked
//   wallets, most of them known-mediocre" design, which is exactly the
//   thing that test found had no signal.
// - "accumulation" = 2+ DISTINCT quality-pool wallets each place a real BUY
//   fill on the SAME (conditionId, outcome), with every qualifying fill
//   falling within ACCUMULATION_WINDOW_SECONDS of the EARLIEST fill on that
//   market (first-touch + window, the same convention
//   legacy/backtestLadder.ts and volatilityBreakout.ts already use for
//   "first touch").
// - "divergence" = the outcome's own price, measured from the first
//   qualifying fill to the last (the signal point), moved by no more than
//   DIVERGENCE_THRESHOLD -- i.e. flat or moving against the accumulation,
//   not a price that already rallied to meet the wallets' conviction. Price
//   is read directly off the quality wallets' own real fill prices (true
//   CLOB execution prices at the instant of each fill), not a separate
//   prices-history pull -- avoids an extra rate-limited API call per
//   candidate market for what would be a materially identical reading.
// - The "signal point" (what a hypothetical follower watching 2+ quality
//   wallets could actually have acted on) is the LAST qualifying fill's
//   price/timestamp within the window -- not the first, and not the
//   wallets' average -- since a follower can only detect "2+ wallets agree"
//   once the second one has actually filled.
// - Predicts better than "the market's own priced-in probability" is
//   answered directly by ROI: buying at the signal price and holding to
//   resolution nets a positive return in expectation only if the true
//   resolution rate exceeds what that price implied. No separate
//   calibration metric needed -- computeStrategyResult's ROI/bootstrap CI
//   already answers exactly this.
//
// Critical methodological rule (non-negotiable, see
// docs/IMPROVEMENT_PLAN.md item 26's post-mortem on volatilityBreakout.ts's
// own flaw): every result below goes through
// src/backtesting/statistics.ts's computeStrategyResult, grouped by real
// eventKey, for the same effectiveIndependentSampleCount/bootstrap-CI
// sample-inflation guard as every trustworthy finding in this project. No
// hand-rolled bucket/win-rate count anywhere in this file.
//
// Cost-bounding note: scoring all ~69 tracked wallets' FULL history via
// computeWalletScore (which resolves every unique market a wallet ever
// touched, one rate-limited API call at a time) would take many hours.
// cheapPrefilter() below replicates computeWalletScore's flag logic
// directly against RAW activity (dormancy, raw-event count as a one-shot
// proxy, stake concentration, election share via the already-pure
// categorize(), high-frequency median gap) -- every one of those is
// computable with zero extra API calls beyond the activity pull every
// wallet needs anyway. Only wallets that would plausibly survive the real
// flags pay for the expensive per-market resolution pass. This is a
// documented engineering shortcut to bound live-API cost, not a
// statistical claim -- the real, final flags/score always come from
// computeWalletScore itself for any wallet that reaches it.

import "dotenv/config";
import { getActivityFromStart, type Activity } from "../api/client";
import { TRACKED_WALLETS, type TrackedWallet } from "../wallets";
import { buildTrials, defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../backtesting/statistics";
import { computeWalletScore } from "../scoring/walletScore";
import { categorize } from "./categorize";
import type { BacktestConfig, BacktestTrial, WalletScore } from "../domain/types";

// -- Cheap pre-filter thresholds -- deliberately mirror computeWalletScore's
// own veto-flag constants (src/scoring/walletScore.ts) so the proxy prunes
// the same wallets the real scoring would anyway. Not exported from
// walletScore.ts today, so duplicated here rather than changing that file's
// public surface for a one-off research script.
const DORMANT_DAYS = 30;
const ONE_SHOT_MAX_EVENTS = 3;
const ELECTION_SHARE_THRESHOLD = 0.7;
const CONCENTRATION_THRESHOLD = 0.5;
const HIGH_FREQUENCY_MEDIAN_GAP_SECONDS = 5;
const HIGH_FREQUENCY_MIN_FILLS = 50;

// -- Accumulation/divergence detection thresholds -- starting points, not
// sensitivity-tuned, flagged honestly the same way volatilityBreakout.ts
// flags its own DETECTION_OPTS (docs/AUDIT.md §3's "unvalidated heuristic"
// discipline: state the magic numbers plainly rather than hide them).
export const ACCUMULATION_WINDOW_SECONDS = 72 * 3600; // 3 days
export const MIN_QUALITY_WALLETS_AGREEING = 2;
export const DIVERGENCE_THRESHOLD = 0.03; // 3 cents -- "flat" price move
const QUALITY_SCORE_MIN = 50; // matches computeQualityScore's own profitability-floor cap boundary

function median(xs: number[]): number {
  if (xs.length === 0) return Infinity;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function eventKeyFor(a: Activity): string {
  return a.eventSlug && a.eventSlug.length > 0 ? a.eventSlug : a.slug;
}

export interface PrefilterResult {
  pass: boolean;
  reason?: string;
}

// Pure, testable: replicates computeWalletScore's veto flags directly off
// raw activity, with zero extra API calls, to decide whether a wallet is
// worth the expensive full resolution pass. See file header for why this
// exists and why it's a proxy, not the final answer.
export function cheapPrefilter(activity: Activity[], nowSeconds: number = Math.floor(Date.now() / 1000)): PrefilterResult {
  const trades = activity.filter((a) => a.type === "TRADE");
  if (trades.length === 0) return { pass: false, reason: "no trade activity" };

  const lastTs = Math.max(...trades.map((a) => a.timestamp));
  const daysSinceLast = (nowSeconds - lastTs) / 86400;
  if (daysSinceLast > DORMANT_DAYS) return { pass: false, reason: `dormant (${daysSinceLast.toFixed(0)}d since last trade)` };

  const buys = trades.filter((a) => a.side === "BUY");
  if (buys.length === 0) return { pass: false, reason: "no BUY activity" };

  const distinctRawEvents = new Set(buys.map(eventKeyFor)).size;
  if (distinctRawEvents <= ONE_SHOT_MAX_EVENTS) return { pass: false, reason: `one-shot proxy (${distinctRawEvents} raw events)` };

  const stakeByEvent = new Map<string, number>();
  for (const b of buys) stakeByEvent.set(eventKeyFor(b), (stakeByEvent.get(eventKeyFor(b)) ?? 0) + b.usdcSize);
  const totalStake = [...stakeByEvent.values()].reduce((s, x) => s + x, 0);
  const topStake = stakeByEvent.size ? Math.max(...stakeByEvent.values()) : 0;
  if (totalStake > 0 && topStake / totalStake > CONCENTRATION_THRESHOLD) {
    return { pass: false, reason: "highly-concentrated proxy" };
  }

  const politicsCount = buys.filter((b) => categorize(b.title) === "politics").length;
  if (politicsCount / buys.length > ELECTION_SHARE_THRESHOLD) return { pass: false, reason: "election-only proxy" };

  const tradeTimestamps = trades.map((a) => a.timestamp).sort((a, b) => a - b);
  const gaps = tradeTimestamps.slice(1).map((t, i) => t - tradeTimestamps[i]);
  const medianGap = median(gaps);
  if (trades.length >= HIGH_FREQUENCY_MIN_FILLS && medianGap < HIGH_FREQUENCY_MEDIAN_GAP_SECONDS) {
    return { pass: false, reason: "uncopyable-high-frequency proxy" };
  }

  return { pass: true };
}

export interface QualityPoolEntry {
  wallet: TrackedWallet;
  score: WalletScore;
  trials: BacktestTrial[]; // resolved BUY trials only (hold-to-resolution, per buildTrials)
}

export interface AccumulationCluster {
  conditionId: string;
  outcome: string;
  eventKey: string;
  category: string;
  distinctWallets: string[];
  basePrice: number;
  baseTimestamp: number;
  signalPrice: number;
  signalTimestamp: number;
  priceMove: number; // signalPrice - basePrice, signed
  won: boolean;
}

interface PoolTrial {
  walletAddress: string;
  trial: BacktestTrial;
}

// Pure, testable: groups quality-pool BUY trials by (conditionId, outcome),
// applies the first-touch+window accumulation rule, and requires
// >=MIN_QUALITY_WALLETS_AGREEING distinct wallets within the window. No
// resolution treatment or price-move filtering here -- that's applied by
// the caller so tests can inspect the full candidate set including the
// non-divergent ("trend-following") clusters too.
export function findAccumulationClusters(poolTrials: PoolTrial[], windowSeconds: number = ACCUMULATION_WINDOW_SECONDS): AccumulationCluster[] {
  const byMarket = new Map<string, PoolTrial[]>();
  for (const item of poolTrials) {
    const key = `${item.trial.conditionId}:${item.trial.outcome}`;
    const group = byMarket.get(key);
    if (group) group.push(item);
    else byMarket.set(key, [item]);
  }

  const clusters: AccumulationCluster[] = [];
  for (const items of byMarket.values()) {
    const sorted = [...items].sort((a, b) => a.trial.entryTimestamp - b.trial.entryTimestamp);
    const base = sorted[0];
    const windowItems = sorted.filter((i) => i.trial.entryTimestamp - base.trial.entryTimestamp <= windowSeconds);
    const distinctWallets = new Set(windowItems.map((i) => i.walletAddress));
    if (distinctWallets.size < MIN_QUALITY_WALLETS_AGREEING) continue;

    const signal = windowItems[windowItems.length - 1];
    clusters.push({
      conditionId: base.trial.conditionId,
      outcome: base.trial.outcome,
      eventKey: base.trial.eventKey,
      category: base.trial.category,
      distinctWallets: [...distinctWallets],
      basePrice: base.trial.entryPrice,
      baseTimestamp: base.trial.entryTimestamp,
      signalPrice: signal.trial.entryPrice,
      signalTimestamp: signal.trial.entryTimestamp,
      priceMove: signal.trial.entryPrice - base.trial.entryPrice,
      won: signal.trial.won === true,
    });
  }
  return clusters;
}

// Pure, testable: turns an accumulation cluster into a BacktestTrial as if
// a follower bought in at the signal price the moment the 2nd (or later)
// quality wallet's fill confirmed the accumulation -- $1 stake per cluster,
// same convention as consensusSignal.ts/ouOverBias.ts.
export function clusterToTrial(c: AccumulationCluster, walletTag: string): BacktestTrial {
  const shares = c.signalPrice > 0 ? 1 / c.signalPrice : 0;
  const netReturn = c.won ? shares - 1 : -1;
  return {
    walletAddress: walletTag,
    conditionId: c.conditionId,
    outcome: c.outcome,
    eventKey: c.eventKey,
    category: c.category,
    entryTimestamp: c.signalTimestamp,
    entryPrice: c.signalPrice,
    usdcStaked: 1,
    shares,
    resolved: true,
    won: c.won,
    netReturn,
  };
}

function baseConfig(strategyName: string, entryRule: string): BacktestConfig {
  return {
    strategyName,
    strategyVersion: "1",
    datasetCutoff: Math.floor(Date.now() / 1000),
    walletAddresses: [],
    entryRule,
    exitRule: "hold-to-resolution",
    observationDelaySeconds: 0,
    executionDelaySeconds: 0,
    feeBps: 0,
    slippageBps: 0,
    resolutionTreatment: "hold-to-resolution",
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function printResult(label: string, trials: BacktestTrial[], entryRule: string): void {
  if (trials.length === 0) {
    console.log(`\n[${label}] no trials`);
    return;
  }
  const r = computeStrategyResult(trials, baseConfig(label, entryRule));
  console.log(`\n[${label}]`);
  console.log(
    `  trials=${r.trialCount}  distinctEvents=${r.distinctEvents}  effectiveIndependentSampleCount=${r.effectiveIndependentSampleCount.toFixed(1)}`
  );
  console.log(`  winRate=${pct(r.winRate)}  netPnl=$${r.netPnl.toFixed(2)}  roi=${pct(r.roi)}`);
  console.log(`  95% ROI CI: ${r.roiBootstrapCI ? `[${pct(r.roiBootstrapCI[0])}, ${pct(r.roiBootstrapCI[1])}]` : "n/a (too few independent events)"}`);
  if (r.distinctEvents < MIN_SAMPLE_SIZE) console.log(`  [below MIN_SAMPLE_SIZE=${MIN_SAMPLE_SIZE} independent events -- provisional]`);
}

// -- Live orchestration below (network calls, not unit-tested directly --
// the pure functions above are) --

async function buildQualityPool(): Promise<QualityPoolEntry[]> {
  const pool: QualityPoolEntry[] = [];
  for (const wallet of TRACKED_WALLETS) {
    let activity: Activity[];
    try {
      activity = await getActivityFromStart(wallet.address, wallet.historyPages ?? 10);
    } catch (err) {
      console.log(`[${wallet.label}] activity pull failed: ${(err as Error).message}`);
      continue;
    }

    const pre = cheapPrefilter(activity);
    if (!pre.pass) {
      console.log(`[${wallet.label}] skip (cheap pre-filter): ${pre.reason}`);
      continue;
    }

    console.log(`[${wallet.label}] passes cheap pre-filter (${activity.length} activity rows) -- resolving full history...`);
    const datasetCutoff = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : Math.floor(Date.now() / 1000);
    const config = defaultBacktestConfig({
      walletAddresses: [wallet.address],
      datasetCutoff,
      strategyName: "smart-money-divergence-quality-pool",
    });
    const trials = await buildTrials(wallet.address, activity, config);
    const strategyResult = computeStrategyResult(trials, config);
    const score = computeWalletScore(wallet, activity, trials, strategyResult);

    console.log(
      `[${wallet.label}] qualityScore=${score.qualityScore}/100  flags=${score.flags.length ? score.flags.join(",") : "(none)"}  ` +
        `events=${score.distinctEvents}  winRate=${pct(score.winRate)}  roi=${pct(score.roi)}`
    );

    if (score.flags.length > 0) {
      console.log(`  -> excluded from quality pool (real flags present)`);
      continue;
    }
    if (score.qualityScore < QUALITY_SCORE_MIN) {
      console.log(`  -> excluded from quality pool (qualityScore below ${QUALITY_SCORE_MIN})`);
      continue;
    }
    pool.push({ wallet, score, trials: trials.filter((t) => t.resolved) });
  }
  pool.sort((a, b) => b.score.qualityScore - a.score.qualityScore);
  return pool;
}

export async function main() {
  console.log(
    `Building quality-scored wallet pool from ${TRACKED_WALLETS.length} tracked wallets ` +
      `(cheap activity-only pre-filter first, full computeWalletScore only for survivors)...`
  );
  const pool = await buildQualityPool();

  console.log(`\n=== Quality pool: ${pool.length} wallets, zero veto flags, qualityScore>=${QUALITY_SCORE_MIN} ===`);
  for (const entry of pool) {
    console.log(
      `  ${entry.wallet.label.padEnd(40)} qualityScore=${entry.score.qualityScore}  events=${entry.score.distinctEvents}  ` +
        `winRate=${pct(entry.score.winRate)}  roi=${pct(entry.score.roi)}`
    );
  }

  if (pool.length < MIN_QUALITY_WALLETS_AGREEING) {
    console.log(
      `\nFewer than ${MIN_QUALITY_WALLETS_AGREEING} wallets survive the quality bar -- ` +
        `cannot test "2+ quality wallets accumulate" at all with the current tracked-wallet pool. Stopping.`
    );
    return;
  }

  const poolTrials: PoolTrial[] = pool.flatMap((entry) => entry.trials.map((trial) => ({ walletAddress: entry.wallet.address, trial })));
  console.log(`\n${poolTrials.length} total resolved BUY trials across the quality pool.`);

  const clusters = findAccumulationClusters(poolTrials);
  console.log(
    `${clusters.length} markets where >=${MIN_QUALITY_WALLETS_AGREEING} distinct quality wallets bought the same outcome ` +
      `within ${(ACCUMULATION_WINDOW_SECONDS / 3600).toFixed(0)}h of each other.`
  );

  const divergent = clusters.filter((c) => c.priceMove <= DIVERGENCE_THRESHOLD);
  const trendFollowing = clusters.filter((c) => c.priceMove > DIVERGENCE_THRESHOLD);
  console.log(
    `  ${divergent.length} divergent (price flat/opposite, move <= ${DIVERGENCE_THRESHOLD}) vs ` +
      `${trendFollowing.length} trend-following (price already moved up >${DIVERGENCE_THRESHOLD} with the accumulation).`
  );

  printResult(
    "ALL quality-wallet accumulation clusters (no divergence filter)",
    clusters.map((c) => clusterToTrial(c, "quality-pool-accumulation-any")),
    `buy at signal price when >=${MIN_QUALITY_WALLETS_AGREEING} quality wallets accumulate the same outcome within ${ACCUMULATION_WINDOW_SECONDS}s`
  );

  printResult(
    "DIVERGENT accumulation (price flat/opposite while quality wallets accumulate) -- the actual hypothesis",
    divergent.map((c) => clusterToTrial(c, "quality-pool-divergence")),
    `buy at signal price when >=${MIN_QUALITY_WALLETS_AGREEING} quality wallets accumulate the same outcome within ${ACCUMULATION_WINDOW_SECONDS}s while price move <= ${DIVERGENCE_THRESHOLD}`
  );

  printResult(
    "Trend-following accumulation (control -- price already moved with the wallets)",
    trendFollowing.map((c) => clusterToTrial(c, "quality-pool-trend-following")),
    `buy at signal price when >=${MIN_QUALITY_WALLETS_AGREEING} quality wallets accumulate the same outcome within ${ACCUMULATION_WINDOW_SECONDS}s while price move > ${DIVERGENCE_THRESHOLD}`
  );

  // Breakdown by cluster size -- does a 3rd+ quality wallet joining make the
  // divergence signal stronger, the same "does more agreement mean a
  // stronger signal" question consensusSignal.ts asked of the full pool.
  for (const minWallets of [2, 3, 4]) {
    const subset = divergent.filter((c) => c.distinctWallets.length >= minWallets);
    if (subset.length < 5) continue;
    printResult(
      `Divergent, >=${minWallets} quality wallets agreeing`,
      subset.map((c) => clusterToTrial(c, "quality-pool-divergence")),
      "see above"
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
