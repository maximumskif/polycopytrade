// Extends docs/IMPROVEMENT_PLAN.md Track G.19 item 1
// ("consensus-restricted-to-quality-wallets") one step further: does
// restricting to wallets that ALSO share the same ALGORITHMICALLY-derived
// archetype (src/scoring/archetypeClassifier.ts) produce a stronger
// aggregate backtested signal than the quality pool as a whole?
//
// A different question from smartMoneyDivergence.ts's "do quality wallets
// agree on the SAME market at the SAME time" -- this pools each cohort's
// own independent trades across DIFFERENT markets, testing whether wallets
// that trade the same STYLE (not the same market, not at the same time)
// share a common edge worth copying as a group rather than one wallet at a
// time.
//
// Reuses smartMoneyDivergence.ts's quality-pool bar exactly (cheapPrefilter
// + zero veto flags + qualityScore>=50) rather than reinventing it -- same
// "quality pool," just also grouped by archetype after classification
// instead of run through market-agreement clustering. Every reported cohort
// result goes through the same computeStrategyResult eventKey-grouped
// statistics as everywhere else in this project -- no separate ad-hoc
// summarize().

import "dotenv/config";
import { getActivityFromStart, type Activity } from "../api/client";
import { buildTrials, defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../backtesting/statistics";
import { computeWalletScore } from "../scoring/walletScore";
import { classifyArchetype, type Archetype } from "../scoring/archetypeClassifier";
import { cheapPrefilter } from "./smartMoneyDivergence";
import { TRACKED_WALLETS, type TrackedWallet } from "../wallets";
import type { BacktestTrial, WalletScore } from "../domain/types";

// Matches smartMoneyDivergence.ts's own QUALITY_SCORE_MIN (not exported
// there, redefined here rather than pulled in -- this project tolerates
// this exact kind of small duplication across independent research scripts,
// see docs/IMPROVEMENT_PLAN.md item 26).
const QUALITY_SCORE_MIN = 50;
const MIN_COHORT_WALLETS = 2;

interface PoolEntry {
  wallet: TrackedWallet;
  score: WalletScore;
  archetype: Archetype;
  confidence: number;
  trials: BacktestTrial[];
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function buildQualityPoolWithArchetypes(): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const wallet of TRACKED_WALLETS) {
    let activity: Activity[];
    try {
      activity = await getActivityFromStart(wallet.address, wallet.historyPages ?? 10, wallet.historyStart);
    } catch (err) {
      console.log(`[${wallet.label}] activity pull failed: ${(err as Error).message}`);
      continue;
    }

    const pre = cheapPrefilter(activity);
    if (!pre.pass) {
      console.log(`[${wallet.label}] skip (cheap pre-filter): ${pre.reason}`);
      continue;
    }

    const datasetCutoff = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : Math.floor(Date.now() / 1000);
    const config = defaultBacktestConfig({
      walletAddresses: [wallet.address],
      datasetCutoff,
      strategyName: "archetype-cohorts-quality-pool",
    });
    const trials = await buildTrials(wallet.address, activity, config);
    const strategyResult = computeStrategyResult(trials, config);
    const score = computeWalletScore(wallet, activity, trials, strategyResult);

    if (score.flags.length > 0 || score.qualityScore < QUALITY_SCORE_MIN) {
      console.log(
        `[${wallet.label}] qualityScore=${score.qualityScore} flags=${score.flags.join(",") || "(none)"} -- excluded from quality pool`
      );
      continue;
    }

    const classification = classifyArchetype(score, trials, activity);
    console.log(
      `[${wallet.label}] qualityScore=${score.qualityScore} archetype=${classification.archetype} (confidence=${classification.confidence.toFixed(2)})`
    );
    pool.push({
      wallet,
      score,
      archetype: classification.archetype,
      confidence: classification.confidence,
      trials: trials.filter((t) => t.resolved),
    });
  }
  return pool;
}

export async function main() {
  console.log(`Building quality-scored, archetype-classified pool from ${TRACKED_WALLETS.length} tracked wallets...`);
  const pool = await buildQualityPoolWithArchetypes();

  console.log(`\n=== Quality pool: ${pool.length} wallets, zero veto flags, qualityScore>=${QUALITY_SCORE_MIN} ===`);

  const wholePoolTrials = pool.flatMap((e) => e.trials);
  const wholeResult = computeStrategyResult(wholePoolTrials, defaultBacktestConfig({ strategyName: "archetype-cohorts-whole-pool" }));
  console.log(`\n[whole quality pool, ${pool.length} wallets combined]`);
  console.log(
    `  trials=${wholeResult.trialCount} distinctEvents=${wholeResult.distinctEvents} winRate=${pct(wholeResult.winRate)} roi=${pct(wholeResult.roi)}`
  );
  console.log(
    `  95% ROI CI: ${wholeResult.roiBootstrapCI ? `[${pct(wholeResult.roiBootstrapCI[0])}, ${pct(wholeResult.roiBootstrapCI[1])}]` : "n/a (too few independent events)"}`
  );

  const byArchetype = new Map<Archetype, PoolEntry[]>();
  for (const entry of pool) {
    if (entry.archetype === "unclassified" || entry.confidence === 0) continue;
    const group = byArchetype.get(entry.archetype) ?? [];
    group.push(entry);
    byArchetype.set(entry.archetype, group);
  }

  console.log(`\n=== Per-archetype cohorts (only archetypes with >=${MIN_COHORT_WALLETS} quality-pool wallets) ===`);
  if (byArchetype.size === 0) {
    console.log("No quality-pool wallet got a confident algorithmic archetype match. Nothing to cohort-test.");
    return;
  }

  for (const [archetype, entries] of byArchetype) {
    if (entries.length < MIN_COHORT_WALLETS) {
      console.log(`\n[${archetype}] only ${entries.length} quality-pool wallet(s) -- too few to test as a cohort, skipped`);
      continue;
    }
    const cohortTrials = entries.flatMap((e) => e.trials);
    const result = computeStrategyResult(cohortTrials, defaultBacktestConfig({ strategyName: `archetype-cohort-${archetype}` }));
    console.log(`\n[${archetype}, ${entries.length} wallets: ${entries.map((e) => e.wallet.label).join(", ")}]`);
    console.log(
      `  trials=${result.trialCount} distinctEvents=${result.distinctEvents} effectiveIndependentSampleCount=${result.effectiveIndependentSampleCount.toFixed(1)}`
    );
    console.log(`  winRate=${pct(result.winRate)} netPnl=$${result.netPnl.toFixed(2)} roi=${pct(result.roi)}`);
    console.log(
      `  95% ROI CI: ${result.roiBootstrapCI ? `[${pct(result.roiBootstrapCI[0])}, ${pct(result.roiBootstrapCI[1])}]` : "n/a (too few independent events)"}`
    );
    if (result.distinctEvents < MIN_SAMPLE_SIZE) {
      console.log(`  [below MIN_SAMPLE_SIZE=${MIN_SAMPLE_SIZE} independent events -- provisional, do not act on this]`);
    }
    console.log(`  vs. whole pool: cohort roi=${pct(result.roi)} vs whole-pool roi=${pct(wholeResult.roi)} (point estimates only, not a significance test)`);
  }
}

if (require.main === module) {
  main();
}
