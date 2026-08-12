// Phase 1b: would COPYING each tracked wallet's actual historical trades
// have been profitable? Unlike walletStats.ts (behavior/category shape)
// this resolves every BUY against the market's real settled outcome and
// computes real win rate / P&L — the same rigor as backtestLadder.ts,
// applied to real traders instead of a hypothesized rule.
//
// Model: mirror every BUY fill, hold to resolution (ignore whether the
// wallet itself sold early — that's the simplest, most conservative copy
// strategy, and matches backtestLadder's "hold to expiry" convention so
// results are comparable). SELL fills are not modeled as a distinct
// strategy leg here; they mostly show up as the wallet's own exits/hedges
// and would need order-level position tracking to interpret correctly.

import { getActivityDeep, getMarketByConditionId, type Activity, type GammaMarket } from "./polymarketClient";
import { TRACKED_WALLETS } from "./wallets";

interface ResolvedTrial {
  conditionId: string;
  question: string;
  outcome: string;
  entryPrice: number;
  usdcStaked: number;
  shares: number;
  won: boolean;
}

const marketCache = new Map<string, GammaMarket | null>();

async function resolveMarket(conditionId: string): Promise<GammaMarket | null> {
  if (marketCache.has(conditionId)) return marketCache.get(conditionId)!;
  // Most historical trades resolve to closed markets; try closed=true first
  // to save a call in the common case, fall back to still-open.
  let market = await getMarketByConditionId(conditionId, true);
  if (!market) market = await getMarketByConditionId(conditionId, false);
  marketCache.set(conditionId, market);
  return market;
}

async function backtestWallet(wallet: (typeof TRACKED_WALLETS)[number]) {
  // 4 pages (~2000 fills) reaches back far enough to catch resolved trades
  // even for wallets like swisstony whose most recent 500 fills alone can
  // span just a couple of hours.
  const activity = await getActivityDeep(wallet.address, 4);
  const buys = activity.filter((a) => a.type === "TRADE" && a.side === "BUY");

  const trials: ResolvedTrial[] = [];
  let skippedStillOpen = 0;
  let skippedUnresolvable = 0;

  const uniqueConditionIds = [...new Set(buys.map((b) => b.conditionId))];
  for (const conditionId of uniqueConditionIds) {
    const market = await resolveMarket(conditionId);
    if (!market) {
      skippedUnresolvable += buys.filter((b) => b.conditionId === conditionId).length;
      continue;
    }
    if (!market.closed) {
      skippedStillOpen += buys.filter((b) => b.conditionId === conditionId).length;
      continue;
    }

    const outcomes: string[] = JSON.parse(market.outcomes ?? "[]");
    const finalPrices: number[] = JSON.parse(market.outcomePrices ?? "[]").map(Number);

    for (const b of buys.filter((x) => x.conditionId === conditionId)) {
      const idx = outcomes.indexOf(b.outcome);
      if (idx === -1 || finalPrices[idx] === undefined) {
        skippedUnresolvable += 1;
        continue;
      }
      trials.push({
        conditionId,
        question: b.title,
        outcome: b.outcome,
        entryPrice: b.price,
        usdcStaked: b.usdcSize,
        shares: b.size,
        won: finalPrices[idx] > 0.5,
      });
    }
  }

  const totalStaked = trials.reduce((s, t) => s + t.usdcStaked, 0);
  const totalReturned = trials.reduce((s, t) => s + (t.won ? t.shares : 0), 0);
  const wins = trials.filter((t) => t.won).length;
  // Fills, not independent decisions — one order against a thin book can be
  // many fills at the same price on the same market/outcome. This is the
  // real sample size for statistical confidence.
  const realOrders = new Set(trials.map((t) => `${t.conditionId}:${t.outcome}`)).size;

  console.log(`\n[${wallet.label}] (${wallet.archetype})`);
  console.log(
    `  ${trials.length} resolved buy fills across ${realOrders} distinct markets ` +
      `(${skippedStillOpen} still open, ${skippedUnresolvable} unresolvable, skipped)`
  );
  if (trials.length > 0) {
    console.log(
      `  win rate ${((wins / trials.length) * 100).toFixed(1)}%  staked $${totalStaked.toFixed(0)}  ` +
        `returned $${totalReturned.toFixed(0)}  net ${(((totalReturned - totalStaked) / totalStaked) * 100).toFixed(1)}%`
    );
  }
  return trials;
}

export async function main() {
  for (const wallet of TRACKED_WALLETS) {
    if (!wallet.address) continue;
    try {
      await backtestWallet(wallet);
    } catch (err) {
      console.error(`[${wallet.label}] failed:`, (err as Error).message);
    }
  }
}

if (require.main === module) {
  main();
}
