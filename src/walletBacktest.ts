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
//
// Phase 1d: pulls each wallet's OLDEST activity (getActivityFromStart, ASC
// from offset 0) instead of its most recent. Phase 1c found the previous
// "most recent N fills" pull made results non-reproducible for
// high-frequency wallets — re-running the identical script a day apart
// flipped Djdjdjekekek and RN1's net P&L sign, because "most recent 2000
// fills" is a different, mostly-unresolved slice every time it's fetched.
// Pulling from genesis instead fixes the trial set: a wallet's oldest fills
// don't change as new ones come in, so reruns either match exactly or grow
// (as previously-open markets in the sample resolve) — never jump around.

import { getActivityFromStart, getMarketByConditionId, type Activity, type GammaMarket } from "./polymarketClient";
import { TRACKED_WALLETS } from "./wallets";
import { categorize } from "./categorize";

interface ResolvedTrial {
  conditionId: string;
  question: string;
  category: string;
  outcome: string;
  entryPrice: number;
  usdcStaked: number;
  shares: number;
  won: boolean;
}

function summarize(trials: ResolvedTrial[]) {
  const totalStaked = trials.reduce((s, t) => s + t.usdcStaked, 0);
  const totalReturned = trials.reduce((s, t) => s + (t.won ? t.shares : 0), 0);
  const wins = trials.filter((t) => t.won).length;
  const distinctMarkets = new Set(trials.map((t) => `${t.conditionId}:${t.outcome}`)).size;
  return { totalStaked, totalReturned, wins, distinctMarkets };
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

// Fixed for every wallet — unlike the old historyPages-per-wallet scheme,
// this isn't about reaching far enough back from "now" (frequency-dependent
// and the source of the Phase 1c instability); it's a flat sample size of
// each wallet's earliest activity, so every wallet gets a comparable-sized
// trial set and the fetch is trivially reproducible.
const BACKTEST_PAGES = 10;

async function backtestWallet(wallet: (typeof TRACKED_WALLETS)[number]) {
  const activity = await getActivityFromStart(wallet.address, BACKTEST_PAGES);
  const oldestTs = activity.length ? Math.min(...activity.map((a) => a.timestamp)) : 0;
  const newestTs = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : 0;
  const spanDays = oldestTs && newestTs ? (newestTs - oldestTs) / 86400 : 0;
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
        category: categorize(b.title),
        outcome: b.outcome,
        entryPrice: b.price,
        usdcStaked: b.usdcSize,
        shares: b.size,
        won: finalPrices[idx] > 0.5,
      });
    }
  }

  const { totalStaked, totalReturned, wins, distinctMarkets: realOrders } = summarize(trials);

  console.log(`\n[${wallet.label}] (${wallet.archetype})`);
  console.log(
    `  earliest ${activity.length} fills, spanning ${spanDays.toFixed(0)} days from ` +
      `${oldestTs ? new Date(oldestTs * 1000).toISOString().slice(0, 10) : "n/a"}` +
      (activity.length >= BACKTEST_PAGES * 500 ? ` (hit ${BACKTEST_PAGES}-page cap — wallet has more history not sampled)` : ` (this is the wallet's full history)`)
  );
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

  // Politics is a category discovered in Phase 1b (Theo4/Fredi9999/RepTrump
  // trade it almost exclusively) that the whole-wallet number above doesn't
  // isolate. Break it out whenever it's a meaningful share of this wallet's
  // resolved trials, not just for those three, in case others show up.
  const politicsTrials = trials.filter((t) => t.category === "politics");
  if (politicsTrials.length >= 10 && politicsTrials.length / trials.length > 0.2) {
    const p = summarize(politicsTrials);
    const pWins = politicsTrials.filter((t) => t.won).length;
    console.log(
      `  politics-only: ${politicsTrials.length} fills across ${p.distinctMarkets} markets  ` +
        `win rate ${((pWins / politicsTrials.length) * 100).toFixed(1)}%  ` +
        `net ${(((p.totalReturned - p.totalStaked) / p.totalStaked) * 100).toFixed(1)}%`
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
