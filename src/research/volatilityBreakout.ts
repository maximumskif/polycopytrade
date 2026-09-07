// Strategy-translation pass (docs/IMPROVEMENT_PLAN.md Track G.19): tests the
// blueprint's "volatility compression -> expansion" idea (#20) against
// Polymarket's BTC/WTI monthly ladder rungs. Reuses
// legacy/backtestLadder.ts's event-fetching (getClosedLadderEvents) and its
// Trial/summarize (the share-payout math this project already fixed once --
// docs/AUDIT.md §4 -- no reason to duplicate or risk regressing it).
//
// Translated concept: a ladder rung's price is a resolving PROBABILITY, not
// a freely-tradeable asset with independent volatility of its own --
// "compression" here means a rung that's been sitting flat (no new
// information moving it) for a while relative to its own recent history,
// and "expansion" is a real price move breaking out of that flatness --
// the moment new information (the underlying asset actually
// approaching/missing the strike) plausibly hits the market, as opposed to
// a rung that's been steadily grinding toward 0 or 1 the whole time with no
// distinct "breakout" moment to trade.

import { getPricesHistory, type GammaMarket } from "../api/client";
import { getClosedLadderEvents, summarize, type Trial } from "../legacy/backtestLadder";

export interface PricePoint {
  t: number;
  p: number;
}

export interface BreakoutSignal {
  breakoutIndex: number;
  direction: "up" | "down";
  entryPrice: number; // the "Yes" token's price at the breakout point
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

// Fraction of `population` at or below `value` -- used to judge "is this
// window's volatility low relative to what this SAME series has shown so
// far," not against some fixed global constant (a rung idling at 2c has
// naturally tiny absolute volatility throughout; what matters is a relative
// drop from its own recent norm).
function percentileRank(value: number, population: number[]): number {
  if (population.length === 0) return 0.5;
  const below = population.filter((x) => x <= value).length;
  return below / population.length;
}

// Causal by construction -- no look-ahead: at each index i, "compressed" is
// judged only against volatility values already computed from EARLIER
// windows, and a breakout is only searched for FORWARD from a compression
// point. Returns the FIRST compression-then-breakout pair found (matching
// backtestLadder.ts's "first touch" convention), or null if none exists.
export function detectVolatilityBreakout(
  series: PricePoint[],
  opts: { lookback: number; compressionPercentile: number; breakoutWindow: number; breakoutThreshold: number }
): BreakoutSignal | null {
  const { lookback, compressionPercentile, breakoutWindow, breakoutThreshold } = opts;
  if (series.length < lookback * 2 + breakoutWindow + 1) return null;

  const vols: number[] = [];
  for (let i = lookback; i < series.length; i++) {
    const window = series.slice(i - lookback, i).map((pt) => pt.p);
    vols.push(stdev(window));

    const volIndex = vols.length - 1;
    const seenSoFar = vols.slice(0, volIndex); // strictly past windows, excludes this one
    if (seenSoFar.length < lookback) continue; // not enough of this series' own history to judge "compressed relative to what" yet

    const isCompressed = percentileRank(vols[volIndex], seenSoFar) <= compressionPercentile;
    if (!isCompressed) continue;

    const basePrice = series[i].p;
    const windowEnd = Math.min(i + breakoutWindow, series.length - 1);
    for (let j = i + 1; j <= windowEnd; j++) {
      const move = series[j].p - basePrice;
      if (Math.abs(move) >= breakoutThreshold) {
        return { breakoutIndex: j, direction: move > 0 ? "up" : "down", entryPrice: series[j].p };
      }
    }
  }
  return null;
}

// CLOB rejects a single startTs/endTs span past ~1 week -- see
// legacy/backtestLadder.ts's MAX_CHUNK_SECONDS (same value, kept local here
// since that file is frozen/bug-fix-only, docs/IMPROVEMENT_PLAN.md Track B.6).
const MAX_CHUNK_SECONDS = 6 * 24 * 3600;

async function fetchFullPriceSeries(tokenId: string, startTs: number, endTs: number): Promise<PricePoint[]> {
  const points: PricePoint[] = [];
  for (let chunkStart = startTs; chunkStart < endTs; chunkStart += MAX_CHUNK_SECONDS) {
    const chunkEnd = Math.min(chunkStart + MAX_CHUNK_SECONDS, endTs);
    const res = await getPricesHistory(tokenId, chunkStart, chunkEnd, 180);
    for (const point of res.history ?? []) points.push(point);
  }
  return points;
}

// Starting points, not validated by sensitivity analysis yet -- same
// "flagged, not hidden" honesty backtestLadder.ts already applies to its own
// REQUIRE_EARLY_CONTESTED heuristic (docs/AUDIT.md §3).
const DETECTION_OPTS = { lookback: 8, compressionPercentile: 0.25, breakoutWindow: 5, breakoutThreshold: 0.05 };

export async function backtestVolatilityBreakoutMarket(
  asset: "BTC" | "WTI",
  eventTitle: string,
  market: GammaMarket
): Promise<Trial | null> {
  const tokenIds: string[] = JSON.parse(market.clobTokenIds ?? "[]");
  const outcomes: string[] = JSON.parse(market.outcomes ?? "[]");
  const finalPrices: number[] = JSON.parse(market.outcomePrices ?? "[]").map(Number);
  if (tokenIds.length !== 2 || outcomes.length !== 2) return null;
  if (!market.endDate) return null;

  const startTs = Math.floor(new Date(market.startDate ?? market.endDate).getTime() / 1000);
  const endTs = Math.floor(new Date(market.endDate).getTime() / 1000);
  if (!(endTs > startTs)) return null;

  const yesTokenId = tokenIds[0];
  const series = await fetchFullPriceSeries(yesTokenId, startTs, endTs);
  const signal = detectVolatilityBreakout(series, DETECTION_OPTS);
  if (!signal) return null;

  const yesWon = finalPrices[0] > 0.5;
  const side: "Yes" | "No" = signal.direction === "up" ? "Yes" : "No";
  const entryPrice = side === "Yes" ? signal.entryPrice : 1 - signal.entryPrice;
  if (!(entryPrice > 0 && entryPrice < 1)) return null; // degenerate/already-settled price, not a real tradeable entry
  const won = side === "Yes" ? yesWon : !yesWon;
  const payout = won ? 1 : 0;

  return {
    asset,
    event: eventTitle,
    market: market.question,
    side,
    entryPrice,
    won,
    payout,
    pnlPerDollarStaked: payout / entryPrice - 1,
  };
}

export async function main() {
  const trials: Trial[] = [];
  const btcEvents = await getClosedLadderEvents("what price will bitcoin hit", "what-price-will-bitcoin-hit");
  const wtiEvents = await getClosedLadderEvents("what price will wti hit", "what-price-will-wti-hit");

  console.log(
    `Testing volatility-compression breakout on ${btcEvents.length} closed BTC + ${wtiEvents.length} closed WTI monthly ladders...`
  );

  for (const [asset, events] of [
    ["BTC", btcEvents],
    ["WTI", wtiEvents],
  ] as const) {
    for (const event of events) {
      for (const market of event.markets ?? []) {
        try {
          const trial = await backtestVolatilityBreakoutMarket(asset, event.title, market);
          if (trial) trials.push(trial);
        } catch (err) {
          console.error(`  skip ${market.question}: ${(err as Error).message}`);
        }
      }
    }
  }

  console.log(`\n=== Volatility-breakout, all assets (n=${trials.length}) ===`);
  summarize(trials);
  console.log(`\n=== BTC only ===`);
  summarize(trials.filter((t) => t.asset === "BTC"));
  console.log(`\n=== WTI only ===`);
  summarize(trials.filter((t) => t.asset === "WTI"));
}

if (require.main === module) {
  main();
}
