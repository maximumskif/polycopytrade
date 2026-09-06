// Strategy-fork idea #2 (2026-08-17): is there a signal in MULTIPLE
// tracked wallets independently buying the same side of the same market,
// separate from any single wallet's own known quality? A genuinely
// different kind of edge than copy-trading one wallet -- "wisdom of the
// tracked crowd" instead of "this one wallet is good."
//
// Method: for every market in local wallet_activity (all 68 tracked
// wallets, not filtered to known-good ones -- this IS the test, whether
// agreement itself carries signal), find markets where a strict majority
// of distinct wallets bought the same outcome. Resolve each against the
// market's real settled outcome (resolveMarket/outcomeWon, reused from
// src/backtesting/engine.ts, not reimplemented) and run the result
// through computeStrategyResult -- same statistics engine, same
// eventKey-grouped sample-inflation guard as every other analysis in this
// project (multiple O/U lines on one game are one real event, not many).

import { getDb } from "./storage/db";
import { resolveMarket, outcomeWon } from "./backtesting/engine";
import { computeStrategyResult } from "./backtesting/statistics";
import type { BacktestTrial, BacktestConfig } from "./domain/types";

const MIN_MAJORITY_WALLETS = 3;

interface ConsensusCandidate {
  conditionId: string;
  outcome: string;
  walletCount: number;
  avgPrice: number;
  eventSlug: string;
}

function findConsensusCandidates(): ConsensusCandidate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT condition_id, outcome, COUNT(DISTINCT wallet_address) as walletCount, AVG(price) as avgPrice
       FROM wallet_activity
       WHERE type = 'TRADE' AND side = 'BUY'
       GROUP BY condition_id, outcome`
    )
    .all() as { condition_id: string; outcome: string; walletCount: number; avgPrice: number }[];

  const byMarket = new Map<string, typeof rows>();
  for (const r of rows) {
    const group = byMarket.get(r.condition_id);
    if (group) group.push(r);
    else byMarket.set(r.condition_id, [r]);
  }

  const candidates: ConsensusCandidate[] = [];
  for (const [conditionId, outcomes] of byMarket) {
    outcomes.sort((a, b) => b.walletCount - a.walletCount);
    const top = outcomes[0];
    const second = outcomes[1];
    const isClearMajority = !second || top.walletCount > second.walletCount;
    if (!isClearMajority || top.walletCount < MIN_MAJORITY_WALLETS) continue;

    const eventRow = db
      .prepare(`SELECT raw_payload FROM wallet_activity WHERE condition_id = ? LIMIT 1`)
      .get(conditionId) as { raw_payload: string } | undefined;
    let eventSlug = conditionId;
    if (eventRow) {
      try {
        const parsed = JSON.parse(eventRow.raw_payload);
        if (parsed.eventSlug) eventSlug = parsed.eventSlug;
      } catch {
        // fall back to conditionId as its own event key
      }
    }

    candidates.push({ conditionId, outcome: top.outcome, walletCount: top.walletCount, avgPrice: top.avgPrice, eventSlug });
  }
  return candidates;
}

interface ResolvedConsensusTrial {
  trial: BacktestTrial;
  walletCount: number;
}

async function buildTrials(candidates: ConsensusCandidate[]): Promise<ResolvedConsensusTrial[]> {
  const resolved: ResolvedConsensusTrial[] = [];
  let checked = 0;
  for (const c of candidates) {
    checked++;
    if (checked % 50 === 0) console.log(`  resolved ${checked}/${candidates.length}...`);
    const market = await resolveMarket(c.conditionId);
    if (!market || !market.closed) continue;
    const won = outcomeWon(market, c.outcome);
    if (won === null) continue;

    const shares = c.avgPrice > 0 ? 1 / c.avgPrice : 0;
    resolved.push({
      walletCount: c.walletCount,
      trial: {
        walletAddress: "crowd-consensus",
        conditionId: c.conditionId,
        outcome: c.outcome,
        eventKey: c.eventSlug,
        category: "unclassified",
        entryTimestamp: 0,
        entryPrice: c.avgPrice,
        usdcStaked: 1,
        shares,
        resolved: true,
        won,
        netReturn: won ? shares - 1 : -1,
      },
    });
  }
  return resolved;
}

function baseConfig(): BacktestConfig {
  return {
    strategyName: "crowd-consensus",
    strategyVersion: "1",
    datasetCutoff: Math.floor(Date.now() / 1000),
    walletAddresses: [],
    entryRule: `buy whichever outcome a strict majority of >=${MIN_MAJORITY_WALLETS} distinct tracked wallets bought`,
    exitRule: "hold-to-resolution",
    observationDelaySeconds: 0,
    executionDelaySeconds: 0,
    feeBps: 0,
    slippageBps: 0,
    resolutionTreatment: "hold-to-resolution",
  };
}

async function main() {
  const candidates = findConsensusCandidates();
  console.log(`${candidates.length} markets have a clear majority of >=${MIN_MAJORITY_WALLETS} distinct wallets on one side.`);
  console.log("Resolving each against its real settled outcome (rate-limited, ~1/sec)...");

  const resolved = await buildTrials(candidates);
  const allTrials = resolved.map((r) => r.trial);
  const r = computeStrategyResult(allTrials, baseConfig());
  console.log(`\n[crowd consensus, >=${MIN_MAJORITY_WALLETS}-wallet majority]`);
  console.log(`  trials=${r.trialCount}  distinctEvents=${r.distinctEvents}  effectiveIndependentSampleCount=${r.effectiveIndependentSampleCount.toFixed(1)}`);
  console.log(`  winRate=${(r.winRate * 100).toFixed(1)}%  netPnl=$${r.netPnl.toFixed(2)}  roi=${(r.roi * 100).toFixed(1)}%`);
  if (r.roiBootstrapCI) {
    console.log(`  95% ROI CI: [${(r.roiBootstrapCI[0] * 100).toFixed(1)}%, ${(r.roiBootstrapCI[1] * 100).toFixed(1)}%]`);
  } else {
    console.log(`  95% ROI CI: n/a (too few independent events)`);
  }

  // Breakdown by wallet-agreement strength -- does MORE agreement mean a stronger signal?
  for (const minCount of [3, 4, 6, 8]) {
    const subset = resolved.filter((r) => r.walletCount >= minCount).map((r) => r.trial);
    if (subset.length < 5) continue;
    const rr = computeStrategyResult(subset, baseConfig());
    console.log(
      `  >=${minCount} wallets agreeing: trials=${rr.trialCount} distinctEvents=${rr.distinctEvents} winRate=${(rr.winRate * 100).toFixed(1)}% roi=${(rr.roi * 100).toFixed(1)}%`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
