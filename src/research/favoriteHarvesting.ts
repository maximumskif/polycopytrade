// "Favorite-longshot bias" strategy test (2026-09-15): in betting markets
// generally, heavy favorites are often slightly UNDERPRICED relative to
// their true win probability (the public overpays for longshot excitement),
// while longshots are overpriced. If that holds here, buying heavily-
// favored outcomes (high price, high win probability, small per-trade
// edge) should show a small but real positive expected value -- individually
// unglamorous, but exactly the "many small wins that compound" shape.
//
// Distinct from the one narrow version of this idea already tested in this
// project: 0x_exit's ladder-harvester ("buy the boring/likely rung" on
// BTC/WTI price-ladder markets specifically) -- that one backtested
// NEGATIVE. This tests the hypothesis broadly, across every category this
// project's 96 tracked wallets have actually traded, not one niche market
// structure.
//
// Phase 1 (this script's main pass): reuses REAL fills already sitting in
// the local wallet_activity DB (same source consensusSignal.ts already
// uses) -- zero new historical-pull cost. Buckets every real BUY fill by
// entry price, resolves each against the market's real settled outcome,
// and runs every bucket through the same eventKey-grouped
// computeStrategyResult() every other result in this project goes through
// (no separate ad-hoc summarize(), no sample-inflation).
//
// Phase 2: simulates a GROWING bankroll (src/backtesting/
// bankrollSimulation.ts) across each bucket's resolved trials in
// chronological order -- the actual "small edge, high win rate, compounds"
// mechanism, which no aggregate stat alone can show. Sized conservatively:
// Wilson-lower-bound win-rate estimate, quarter Kelly, hard-capped stake
// fraction -- see bankrollSimulation.ts's own header for why.
//
// Usage: npm run favorite-harvesting

import "dotenv/config";
import { getDb } from "../storage/db";
import { resolveMarket, outcomeWon, defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../backtesting/statistics";
import { simulateBankroll, wilsonLowerBound } from "../backtesting/bankrollSimulation";
import { categorize } from "./categorize";
import type { BacktestTrial } from "../domain/types";

interface PriceBucket {
  label: string;
  min: number;
  max: number; // exclusive
}

// 0.70 floor: below that, "favorite" stops being a meaningful description.
// 0.99 ceiling: prices essentially at $1 pre-resolution are a near-certain
// artifact (the fill likely landed right before settlement), not a real
// trading decision -- excluded to avoid a spurious "100% win" bucket.
const PRICE_BUCKETS: PriceBucket[] = [
  { label: "70-80", min: 0.7, max: 0.8 },
  { label: "80-85", min: 0.8, max: 0.85 },
  { label: "85-90", min: 0.85, max: 0.9 },
  { label: "90-95", min: 0.9, max: 0.95 },
  { label: "95-99", min: 0.95, max: 0.99 },
];

// Bounds live resolveMarket() calls (rate-limited ~1/sec) to a manageable
// runtime -- a deterministic sample (ORDER BY condition_id), not
// exhaustive, same "sampled and clearly noted, not a full census"
// convention as sourceWallets.ts's LIMIT_PER_SWEEP.
const MAX_MARKETS_PER_BUCKET = 150;

interface RawFill {
  condition_id: string;
  outcome: string;
  price: number;
  usdc_size: number;
  timestamp: number;
  title: string;
  raw_payload: string;
}

function eventKeyFor(fill: RawFill): string {
  try {
    const parsed = JSON.parse(fill.raw_payload);
    if (parsed.eventSlug && typeof parsed.eventSlug === "string" && parsed.eventSlug.length > 0) return parsed.eventSlug;
  } catch {
    // fall through to conditionId as its own event key
  }
  return fill.condition_id;
}

function fetchBucketFills(bucket: PriceBucket): RawFill[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT condition_id, outcome, price, usdc_size, timestamp, title, raw_payload
       FROM wallet_activity
       WHERE type = 'TRADE' AND side = 'BUY' AND price >= ? AND price < ?
         AND condition_id IN (
           SELECT condition_id FROM wallet_activity
           WHERE type = 'TRADE' AND side = 'BUY' AND price >= ? AND price < ?
           GROUP BY condition_id
           ORDER BY condition_id
           LIMIT ?
         )`
    )
    .all(bucket.min, bucket.max, bucket.min, bucket.max, MAX_MARKETS_PER_BUCKET) as unknown as RawFill[];
}

// $1 fixed stake per trial (matches consensusSignal.ts's own convention) --
// the question here is whether the PRICE-based edge is real, not whether
// any particular wallet's actual stake size was profitable.
async function resolveFillsToTrials(fills: RawFill[]): Promise<BacktestTrial[]> {
  const trials: BacktestTrial[] = [];
  const byCondition = new Map<string, RawFill[]>();
  for (const f of fills) {
    const list = byCondition.get(f.condition_id) ?? [];
    list.push(f);
    byCondition.set(f.condition_id, list);
  }

  let resolved = 0;
  for (const [conditionId, group] of byCondition) {
    resolved++;
    if (resolved % 25 === 0) console.log(`    resolved ${resolved}/${byCondition.size} distinct markets...`);
    const market = await resolveMarket(conditionId);
    if (!market || !market.closed) continue;
    for (const f of group) {
      const won = outcomeWon(market, f.outcome);
      if (won === null) continue;
      const shares = f.price > 0 ? 1 / f.price : 0;
      trials.push({
        walletAddress: "favorite-harvesting",
        conditionId,
        outcome: f.outcome,
        eventKey: eventKeyFor(f),
        category: categorize(f.title),
        entryTimestamp: f.timestamp,
        entryPrice: f.price,
        usdcStaked: 1,
        shares,
        resolved: true,
        won,
        netReturn: won ? shares - 1 : -1,
      });
    }
  }
  return trials;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function baseConfig(strategyName: string) {
  return defaultBacktestConfig({ strategyName, entryRule: "buy whenever a real tracked-wallet fill's entry price falls in this bucket" });
}

async function main() {
  const allTrials: BacktestTrial[] = [];

  console.log(`Scanning ${PRICE_BUCKETS.length} price buckets, up to ${MAX_MARKETS_PER_BUCKET} distinct markets each...\n`);

  for (const bucket of PRICE_BUCKETS) {
    const fills = fetchBucketFills(bucket);
    const distinctMarketsFound = new Set(fills.map((f) => f.condition_id)).size;
    console.log(`[${bucket.label}c] ${fills.length} raw fills across ${distinctMarketsFound} distinct markets. Resolving...`);

    const trials = await resolveFillsToTrials(fills);
    allTrials.push(...trials);

    const result = computeStrategyResult(trials, baseConfig(`favorite-harvesting-${bucket.label}`));
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

    // Phase 2: sequential bankroll simulation, chronological order, sized
    // off this bucket's own Wilson-lower-bound win rate (conservative, not
    // the raw observed rate).
    if (result.trialCount >= 10) {
      const resolvedTrials = trials.filter((t) => t.resolved).sort((a, b) => a.entryTimestamp - b.entryTimestamp);
      const wins = resolvedTrials.filter((t) => t.won).length;
      const pWinEstimate = wilsonLowerBound(wins, resolvedTrials.length);
      const sim = simulateBankroll(
        resolvedTrials.map((t) => ({ won: t.won === true, price: t.entryPrice })),
        { pWinEstimate, startingBankroll: 1000 }
      );
      console.log(
        `  bankroll sim (pWinEstimate=${pct(pWinEstimate)} Wilson lower bound, quarter-Kelly, 10% max stake): ` +
          `$1000 -> $${sim.finalBankroll.toFixed(2)} (${sim.multiple.toFixed(2)}x) over ${sim.betsPlaced} bets, maxDrawdown=${pct(sim.maxDrawdownPct)}${sim.busted ? " [BUSTED]" : ""}`
      );
    } else {
      console.log(`  [fewer than 10 resolved trials -- skipping bankroll simulation, too thin to size bets off]`);
    }
    console.log("");
  }

  console.log(`=== Combined across all favorite buckets (70-99c) ===`);
  const combined = computeStrategyResult(allTrials, baseConfig("favorite-harvesting-combined"));
  console.log(
    `trials=${combined.trialCount} distinctEvents=${combined.distinctEvents} effectiveIndependentSampleCount=${combined.effectiveIndependentSampleCount.toFixed(1)}`
  );
  console.log(`winRate=${pct(combined.winRate)} netPnl=$${combined.netPnl.toFixed(2)} roi=${pct(combined.roi)}`);
  console.log(
    `95% ROI CI: ${combined.roiBootstrapCI ? `[${pct(combined.roiBootstrapCI[0])}, ${pct(combined.roiBootstrapCI[1])}]` : "n/a (too few independent events)"}`
  );
  console.log(`category breakdown:`, combined.categoryBreakdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
