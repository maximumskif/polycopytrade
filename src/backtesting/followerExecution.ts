// Estimates how much realized ROI a copy trader gives up to execution
// delay, using each fill's REAL observed CLOB price path around the
// leader's fill time -- not a guessed slippage-bps constant. Every prior
// backtest in this project (docs/AUDIT.md §3) assumed the follower gets
// the leader's exact fill price; this is the first thing that actually
// measures how wrong that assumption is.
//
// Deliberately scoped to a demo on ONE wallet, over a small sample of its
// fills -- not all 24 tracked wallets, and not a wallet's full trial set.
// Each fill needs a market lookup (clobTokenId) + a prices-history call, and
// this project throttles all API hosts to ~1 req/sec, so a full-scale
// version of this would be a slow, rate-limit-heavy job better suited to a
// deliberate follow-up than routine tooling.
//
// Known granularity limit, worth understanding before trusting a delay
// breakdown here: `getPricesHistory`'s finest fidelity is ~1-minute
// candles. Delays under 60s (5/15/30s) will frequently land in the SAME
// candle as each other -- the follower-price estimates at those delays can
// come out identical, which reflects the API's resolution, not an absence
// of real intra-minute price movement.

import { getMarketByConditionId, getPricesHistory, type GammaMarket } from "../api/client";

export const FOLLOWER_DELAYS_SECONDS = [5, 15, 30, 60] as const;
export type FollowerDelaySeconds = (typeof FOLLOWER_DELAYS_SECONDS)[number];

// Reuses a BacktestTrial-shaped fill rather than re-deriving win/loss from
// raw activity+market data -- that logic already lives in engine.ts, and
// this project has already learned the hard way (docs/AUDIT.md's Phase 0
// bug) not to keep two independent implementations of the same math.
export interface LeaderFill {
  conditionId: string;
  outcome: string;
  timestamp: number;
  price: number;
  won: boolean;
}

export interface FollowerFillEstimate {
  conditionId: string;
  outcome: string;
  leaderTimestamp: number;
  leaderPrice: number;
  won: boolean;
  // Follower's estimated entry price at each delay -- null if the CLOB
  // returned no price point at or after that instant within the lookup
  // window (thin/illiquid market, or a fill too close to market close for
  // a later tick to exist).
  followerPriceByDelay: Partial<Record<FollowerDelaySeconds, number | null>>;
}

// Picks the clobTokenId for a fill's outcome side out of a market's
// [Yes, No]-ordered clobTokenIds/outcomes arrays -- same JSON-array
// decoding backtestLadder.ts already relies on.
// Exported for reuse by src/paperTrading/engine.ts, which needs the exact
// same "which CLOB token does this outcome trade as" lookup.
export function tokenIdForOutcome(market: GammaMarket, outcome: string): string | null {
  const tokenIds: string[] = JSON.parse(market.clobTokenIds ?? "[]");
  const outcomes: string[] = JSON.parse(market.outcomes ?? "[]");
  const idx = outcomes.findIndex((o) => o.toLowerCase() === outcome.toLowerCase());
  return idx >= 0 && idx < tokenIds.length ? tokenIds[idx] : null;
}

// Nearest price point AT OR AFTER `ts` -- a follower can only react to
// information that has already happened, so an earlier tick is never a
// valid stand-in for "the observed price `delay` seconds later."
// Exported for the same reason as tokenIdForOutcome above.
export function priceAtOrAfter(history: { t: number; p: number }[], ts: number): number | null {
  let best: { t: number; p: number } | null = null;
  for (const pt of history) {
    if (pt.t >= ts && (best === null || pt.t < best.t)) best = pt;
  }
  return best ? best.p : null;
}

export async function estimateFollowerFill(fill: LeaderFill): Promise<FollowerFillEstimate | null> {
  let market = await getMarketByConditionId(fill.conditionId, true);
  if (!market) market = await getMarketByConditionId(fill.conditionId, false);
  if (!market) return null;

  const tokenId = tokenIdForOutcome(market, fill.outcome);
  if (!tokenId) return null;

  const maxDelay = Math.max(...FOLLOWER_DELAYS_SECONDS);
  // Small padding on both sides -- CLOB candle boundaries don't line up
  // exactly with the requested startTs/endTs.
  const res = await getPricesHistory(tokenId, fill.timestamp - 30, fill.timestamp + maxDelay + 60, 1);
  const history = res.history ?? [];

  const followerPriceByDelay: FollowerFillEstimate["followerPriceByDelay"] = {};
  for (const delay of FOLLOWER_DELAYS_SECONDS) {
    followerPriceByDelay[delay] = priceAtOrAfter(history, fill.timestamp + delay);
  }

  return {
    conditionId: fill.conditionId,
    outcome: fill.outcome,
    leaderTimestamp: fill.timestamp,
    leaderPrice: fill.price,
    won: fill.won,
    followerPriceByDelay,
  };
}

export interface DelayDegradationSummary {
  delaySeconds: FollowerDelaySeconds;
  sampleSize: number; // fills where a follower price was actually observed at this delay
  avgLeaderEntryPrice: number;
  avgFollowerEntryPrice: number;
  avgPriceSlippage: number; // avgFollowerEntryPrice - avgLeaderEntryPrice
  leaderRoi: number; // $1-per-fill hold-to-resolution ROI at the leader's real entry price
  followerRoi: number; // same trials, same $1 stakes, at the follower's estimated entry price
}

// $1 staked per fill at each side's own entry price -- the same
// hold-to-resolution trial shape the rest of Phase 2 uses (statistics.ts),
// scaled down to a synthetic even stake since we're comparing two
// hypothetical execution prices on the SAME set of fills, not real stake
// sizes.
export function summarizeDelayDegradation(estimates: FollowerFillEstimate[]): DelayDegradationSummary[] {
  return FOLLOWER_DELAYS_SECONDS.map((delay) => {
    const usable = estimates.filter((e) => e.followerPriceByDelay[delay] != null);
    const n = usable.length;
    if (n === 0) {
      return {
        delaySeconds: delay,
        sampleSize: 0,
        avgLeaderEntryPrice: 0,
        avgFollowerEntryPrice: 0,
        avgPriceSlippage: 0,
        leaderRoi: 0,
        followerRoi: 0,
      };
    }

    let leaderReturn = 0;
    let followerReturn = 0;
    let leaderPriceSum = 0;
    let followerPriceSum = 0;
    for (const e of usable) {
      const followerPrice = e.followerPriceByDelay[delay] as number;
      leaderPriceSum += e.leaderPrice;
      followerPriceSum += followerPrice;
      leaderReturn += (e.won ? 1 / e.leaderPrice : 0) - 1;
      followerReturn += (e.won ? 1 / followerPrice : 0) - 1;
    }

    return {
      delaySeconds: delay,
      sampleSize: n,
      avgLeaderEntryPrice: leaderPriceSum / n,
      avgFollowerEntryPrice: followerPriceSum / n,
      avgPriceSlippage: followerPriceSum / n - leaderPriceSum / n,
      leaderRoi: leaderReturn / n,
      followerRoi: followerReturn / n,
    };
  });
}
