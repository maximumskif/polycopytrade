// Phase 1 backtest: did buying into the "harvest zone" (5-45c) on past,
// now-resolved BTC/WTI price-ladder rungs actually pay off, and where does
// the real edge concentrate? This is what turns 0x_exit's tweet into a
// number instead of a story.
//
// Method: for each closed monthly ladder event, for each rung (sub-market),
// pull the "Yes" token's historical price series (CLOB prices-history,
// bounded to the event's active window). Walk the series forward; the
// FIRST time price enters the harvest zone, record a hypothetical $1-stake
// buy at that price on whichever side (Yes or No) is actually cheap there
// (a binary market's two outcomes sum to ~1, so we derive the other side
// from `1 - p` instead of doubling API calls). Resolve it against the
// event's real final outcome (from `outcomePrices`, which for a closed
// market is the settled 0/1, not a live quote).
//
// v1 of this backtest (any rung that ever touches the zone) came back
// badly net-negative in every price bucket — worse than the price itself
// implies, i.e. NEGATIVE edge, not "no edge". Root cause: it can't tell
// "a rung that was genuinely contested and got dumped on by retail" (the
// actual claim) apart from "a deep out-of-the-money rung that was always a
// longshot and is just decaying to zero as the deadline approaches" (no
// edge by construction — ANY first-touch-into-a-price-band rule catches
// this too, for every market, always). REQUIRE_EARLY_CONTESTED filters for
// the former: only count a trial if the rung was priced like a real
// toss-up (>=20c on both sides) at some point in the first 20% of its
// window, before it drifted into the harvest zone.
//
// This is still a simple "first touch, hold to expiry" rule — it doesn't
// model order book depth/slippage or re-entry. Good enough to answer: is
// there edge here at all, and in which price band / which rung shape.

// Historically-cited original -- every Phase 1a/1g number in README.md is
// cited against this exact file's output. Deliberately NOT migrated onto
// src/backtesting/engine.ts (docs/AUDIT.md's Phase 2 section: migrating
// would risk subtly changing already-cited numbers, as already happened
// once, benignly, when the engine was cross-checked against
// walletBacktest.ts). Moved to src/legacy/ 2026-09-05
// (docs/IMPROVEMENT_PLAN.md Track B.6) to make that status explicit --
// bug-fix only here, don't refactor.

import { getPricesHistory, type GammaEvent, type GammaMarket, searchEvents } from "../api/client";

const HARVEST_ZONE = { min: 0.05, max: 0.45 };
const EVENTS_PER_ASSET = 4; // keep API-call volume sane given the ~1req/sec throttle
const EARLY_WINDOW_FRACTION = 0.2;
const EARLY_CONTESTED_THRESHOLD = 0.2;

export interface Trial {
  asset: "BTC" | "WTI";
  event: string;
  market: string;
  side: "Yes" | "No";
  entryPrice: number;
  won: boolean;
  payout: number; // $1 if won, $0 if lost
  pnlPerDollarStaked: number;
}

export async function getClosedLadderEvents(query: string, monthSlugFragment: string): Promise<GammaEvent[]> {
  const events = await searchEvents(query, 30, "closed");
  // Keep only the monthly-ladder shape ("what-price-will-<asset>-hit-in-<month>-<year>"),
  // not the daily/weekly variants which have far fewer, noisier rungs.
  return events
    .filter((e) => e.slug.includes(monthSlugFragment) && e.slug.match(/-in-[a-z]+-2026$/) && e.endDate)
    .sort((a, b) => (a.endDate! < b.endDate! ? 1 : -1))
    .slice(0, EVENTS_PER_ASSET);
}

// CLOB rejects any single startTs/endTs span much beyond ~1 week ("interval
// is too long", confirmed by testing: 7 days OK, 31 days 400s) — chunk
// monthly ladder windows into <=6-day slices and stitch the history back
// together instead of one call per market.
const MAX_CHUNK_SECONDS = 6 * 24 * 3600;

export async function backtestMarket(
  asset: "BTC" | "WTI",
  eventTitle: string,
  market: GammaMarket,
  zone: { min: number; max: number } = HARVEST_ZONE
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
  // Skip the first 5% of the window: opening prices are noisy/thin and not
  // representative of the "retail has already piled onto the longshot" setup.
  const warmupCutoff = startTs + (endTs - startTs) * 0.05;
  const earlyWindowEnd = startTs + (endTs - startTs) * EARLY_WINDOW_FRACTION;

  // Fetch chunk-by-chunk (CLOB caps any single startTs/endTs span at ~1
  // week — confirmed by testing: 7 days OK, 31 days 400s "interval is too
  // long"). Keep going until we've BOTH found a harvest-zone crossing AND
  // covered the early window (needed to check REQUIRE_EARLY_CONTESTED),
  // whichever is later.
  let crossingYesPrice: number | null = null;
  let earlyContestedPeak = 0;
  for (
    let chunkStart = startTs;
    chunkStart < endTs && (crossingYesPrice === null || chunkStart < earlyWindowEnd);
    chunkStart += MAX_CHUNK_SECONDS
  ) {
    const chunkEnd = Math.min(chunkStart + MAX_CHUNK_SECONDS, endTs);
    const res = await getPricesHistory(yesTokenId, chunkStart, chunkEnd, 180);
    for (const point of res.history ?? []) {
      const cheapness = Math.min(point.p, 1 - point.p);
      if (point.t < earlyWindowEnd) earlyContestedPeak = Math.max(earlyContestedPeak, cheapness);
      if (crossingYesPrice === null && point.t >= warmupCutoff && cheapness >= zone.min && cheapness <= zone.max) {
        crossingYesPrice = point.p;
      }
    }
  }
  if (crossingYesPrice === null) return null; // this rung never dipped into the harvest zone
  if (earlyContestedPeak < EARLY_CONTESTED_THRESHOLD) return null; // was a longshot from the start, not a dumped-on toss-up

  const yesWon = finalPrices[0] > 0.5;
  const cheapSide: "Yes" | "No" = crossingYesPrice <= 1 - crossingYesPrice ? "Yes" : "No";
  const entryPrice = cheapSide === "Yes" ? crossingYesPrice : 1 - crossingYesPrice;
  const won = cheapSide === "Yes" ? yesWon : !yesWon;
  const payout = won ? 1 : 0;

  return {
    asset,
    event: eventTitle,
    market: market.question,
    side: cheapSide,
    entryPrice,
    won,
    payout,
    pnlPerDollarStaked: payout / entryPrice - 1,
  };
}

export interface LadderSummary {
  n: number;
  wins: number;
  winRate: number;
  totalStaked: number;
  sharesAcquired: number;
  grossReturned: number;
  netProfit: number;
  roi: number;
  avgEntryPrice: number;
}

// Each trial stakes exactly $1 (see backtestMarket), which at price p buys
// 1/p shares of the cheap side; a share redeems for exactly $1 if it won,
// $0 if it lost. FIXED BUG (found auditing this file): the previous version
// summed the per-trial binary `payout` (0 or 1) as if a $1 stake could only
// ever return $1, which made the reported "net" mathematically collapse to
// win_rate - 100% for every group regardless of entry price — confirmed by
// re-deriving the original Phase 1a README table, where every bucket's
// published "net" was exactly winRate-100% to one decimal place. Reworked
// to sum 1/entryPrice for winning trials, the actual payout of a $1 stake.
export function summarize(trials: Trial[]): LadderSummary {
  const n = trials.length;
  const wins = trials.filter((t) => t.won).length;
  const totalStaked = n; // $1 per trial
  const sharesAcquired = trials.reduce((s, t) => s + 1 / t.entryPrice, 0);
  const grossReturned = trials.reduce((s, t) => s + (t.won ? 1 / t.entryPrice : 0), 0);
  const netProfit = grossReturned - totalStaked;
  const roi = n > 0 ? netProfit / totalStaked : 0;
  const winRate = n > 0 ? wins / n : 0;
  const avgEntryPrice = n > 0 ? trials.reduce((s, t) => s + t.entryPrice, 0) / n : 0;

  if (n > 0) {
    console.log(
      `\nn=${n}  win rate=${(winRate * 100).toFixed(1)}%  avg entry=${(avgEntryPrice * 100).toFixed(1)}c ` +
        `(breakeven win rate, approx ~=avg entry price)\n` +
        `  staked $${totalStaked}  shares ${sharesAcquired.toFixed(2)}  gross returned $${grossReturned.toFixed(2)}  ` +
        `net profit $${netProfit.toFixed(2)}  ROI ${(roi * 100).toFixed(1)}%`
    );
  }

  const buckets = [
    [0.05, 0.15],
    [0.15, 0.25],
    [0.25, 0.35],
    [0.35, 0.45],
  ] as const;
  for (const [lo, hi] of buckets) {
    const bucket = trials.filter((t) => t.entryPrice >= lo && t.entryPrice < hi);
    if (bucket.length === 0) continue;
    const bw = bucket.filter((t) => t.won).length;
    const bShares = bucket.reduce((s, t) => s + 1 / t.entryPrice, 0);
    const bReturned = bucket.reduce((s, t) => s + (t.won ? 1 / t.entryPrice : 0), 0);
    const bAvgEntry = bucket.reduce((s, t) => s + t.entryPrice, 0) / bucket.length;
    console.log(
      `  ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}c: n=${bucket.length} ` +
        `win rate=${((bw / bucket.length) * 100).toFixed(1)}% avg entry=${(bAvgEntry * 100).toFixed(1)}c ` +
        `shares=${bShares.toFixed(2)} gross=$${bReturned.toFixed(2)} ` +
        `net=${(((bReturned - bucket.length) / bucket.length) * 100).toFixed(1)}%`
    );
  }

  return { n, wins, winRate, totalStaked, sharesAcquired, grossReturned, netProfit, roi, avgEntryPrice };
}

export async function main() {
  const trials: Trial[] = [];

  const btcEvents = await getClosedLadderEvents("what price will bitcoin hit", "what-price-will-bitcoin-hit");
  const wtiEvents = await getClosedLadderEvents("what price will wti hit", "what-price-will-wti-hit");

  console.log(`Backtesting ${btcEvents.length} closed BTC monthly ladders + ${wtiEvents.length} closed WTI monthly ladders...`);

  for (const [asset, events] of [
    ["BTC", btcEvents],
    ["WTI", wtiEvents],
  ] as const) {
    for (const event of events) {
      for (const market of event.markets ?? []) {
        try {
          const trial = await backtestMarket(asset, event.title, market);
          if (trial) trials.push(trial);
        } catch (err) {
          console.error(`  skip ${market.question}: ${(err as Error).message}`);
        }
      }
    }
  }

  console.log(`\n=== Overall (all assets, ${HARVEST_ZONE.min * 100}-${HARVEST_ZONE.max * 100}c zone) ===`);
  summarize(trials);
  console.log(`\n=== BTC only ===`);
  summarize(trials.filter((t) => t.asset === "BTC"));
  console.log(`\n=== WTI only ===`);
  summarize(trials.filter((t) => t.asset === "WTI"));
}

if (require.main === module) {
  main();
}
