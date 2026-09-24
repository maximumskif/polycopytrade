// Strategy-translation pass (docs/IMPROVEMENT_PLAN.md Track G.19): tests the
// blueprint's "volatility compression -> expansion" idea (#20) against
// Polymarket's BTC/WTI monthly ladder rungs.
//
// 2026-09-24 migration: the first version reused legacy/backtestLadder.ts's
// getClosedLadderEvents + summarize(), and its +10.4% ROI / n=116 headline
// came from only 8 real events (EVENTS_PER_ASSET=4 x 2 assets, hardcoded in
// that frozen file) -- every rung of one month's ladder is one correlated
// bet on where BTC/WTI went that month, so n=116 trials was sample
// inflation (docs/AUDIT.md §7). It also silently included the still-running
// September-2026 ladders (/public-search's "closed" status lists an event
// once SOME of its rungs have closed), i.e. only the rungs already hit and
// resolved Yes -- a look-ahead-flavored selection bias. This version:
//   - selects its own closed monthly ladders (event endDate in the past,
//     only closed + settled rungs), count configurable via --eventsPerAsset,
//     and accepts the 2024/2025 year-less slugs so >=20 events is reachable;
//   - converts every trial to a BacktestTrial keyed by event slug and runs
//     it through computeStrategyResult (event-clustered bootstrap CI,
//     distinctEvents, MIN_SAMPLE_SIZE) like every other research script;
//   - also reports a coarser calendar-month grouping (BTC and WTI in the
//     same month share macro/risk-on moves, so per-event independence is
//     itself an optimistic assumption).
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

import { getPricesHistory, searchEvents, type GammaEvent, type GammaMarket } from "../api/client";
import { defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE, stdev } from "../backtesting/statistics";
import type { BacktestTrial, StrategyResult } from "../domain/types";

export interface PricePoint {
  t: number;
  p: number;
}

export interface BreakoutSignal {
  breakoutIndex: number;
  direction: "up" | "down";
  entryPrice: number; // the "Yes" token's price at the breakout point
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

// Starting points, not validated by sensitivity analysis yet -- same
// "flagged, not hidden" honesty backtestLadder.ts already applies to its own
// REQUIRE_EARLY_CONTESTED heuristic (docs/AUDIT.md §3).
const DETECTION_OPTS = { lookback: 8, compressionPercentile: 0.25, breakoutWindow: 5, breakoutThreshold: 0.05 };

// 2026-09-24: a signal found on a PREFIX of the series is guaranteed to be
// the same one detectVolatilityBreakout would return on the full series
// once every compression point up to and including the one that fired had
// its full forward breakoutWindow inside the prefix (volatility/percentile
// state at index i only ever depends on indices < i, so appending points
// can't change anything earlier -- the only prefix artifact is a truncated
// forward search). compressionIndex < breakoutIndex, so requiring
// breakoutIndex + breakoutWindow <= last prefix index is sufficient. Lets
// the live pull stop fetching a rung's price history as soon as its signal
// is settled instead of always pulling all ~5 weekly chunks -- a large cut
// in API calls with bit-for-bit identical results.
export function isSignalFinal(signal: BreakoutSignal, prefixLength: number, breakoutWindow: number): boolean {
  return signal.breakoutIndex + breakoutWindow <= prefixLength - 1;
}

async function detectBreakoutIncrementally(
  market: GammaMarket,
  tokenId: string,
  startTs: number,
  endTs: number
): Promise<{ signal: BreakoutSignal; series: PricePoint[] } | null> {
  const series: PricePoint[] = [];
  for (let chunkStart = startTs; chunkStart < endTs; chunkStart += MAX_CHUNK_SECONDS) {
    const chunkEnd = Math.min(chunkStart + MAX_CHUNK_SECONDS, endTs);
    const res = await getPricesHistory(tokenId, chunkStart, chunkEnd, 180, { market });
    for (const point of res.history ?? []) series.push(point);
    const signal = detectVolatilityBreakout(series, DETECTION_OPTS);
    if (signal && isSignalFinal(signal, series.length, DETECTION_OPTS.breakoutWindow)) return { signal, series };
  }
  const signal = detectVolatilityBreakout(series, DETECTION_OPTS);
  return signal ? { signal, series } : null;
}

export type LadderAsset = "BTC" | "WTI";

const LADDER_QUERIES: Record<LadderAsset, { query: string; slugFragment: string }> = {
  BTC: { query: "what price will bitcoin hit", slugFragment: "what-price-will-bitcoin-hit" },
  WTI: { query: "what price will wti hit", slugFragment: "what-price-will-wti-hit" },
};

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
// Monthly-ladder shape only (not the daily/weekly variants, which have far
// fewer, noisier rungs). 2026-09-24: the "-<year>" suffix is optional --
// Polymarket's 2024/2025 monthly ladders used year-less slugs
// ("...-hit-in-august"), and legacy/backtestLadder.ts's -2026$ filter is
// what capped the old pull at 2026 events only.
const MONTHLY_SLUG_RE = new RegExp(`-in-(${MONTHS})(-\\d{4})?$`);

// Pure selection step (exported for tests): monthly ladders for this asset
// whose event window has actually ENDED as of `nowMs`, newest first,
// capped at `eventsPerAsset`.
export function selectClosedMonthlyLadders(
  events: GammaEvent[],
  slugFragment: string,
  eventsPerAsset: number,
  nowMs: number
): GammaEvent[] {
  return events
    .filter((e) => e.slug.includes(slugFragment) && MONTHLY_SLUG_RE.test(e.slug) && e.endDate && new Date(e.endDate).getTime() < nowMs)
    .sort((a, b) => (a.endDate! < b.endDate! ? 1 : -1))
    .slice(0, eventsPerAsset);
}

// "Settled" = closed AND outcomePrices is the final 0/1, not a stale live
// quote -- a trial is only resolvable against a real outcome.
function settledYesWon(market: GammaMarket): boolean | null {
  if (!market.closed) return null;
  const finalPrices: number[] = JSON.parse(market.outcomePrices ?? "[]").map(Number);
  if (finalPrices.length !== 2) return null;
  if (finalPrices[0] >= 0.99) return true;
  if (finalPrices[0] <= 0.01) return false;
  return null;
}

// Pure signal -> trial conversion (exported for tests). $1 fixed stake per
// trial buying 1/entryPrice shares of the breakout side -- the same payout
// math legacy summarize() was fixed to use (docs/AUDIT.md §4), now expressed
// as BacktestTrial.netReturn so computeStrategyResult owns the aggregation.
export function breakoutTrial(args: {
  asset: LadderAsset;
  eventKey: string;
  conditionId: string;
  signal: BreakoutSignal;
  entryTimestamp: number;
  yesWon: boolean;
}): BacktestTrial | null {
  const { asset, eventKey, conditionId, signal, entryTimestamp, yesWon } = args;
  const side = signal.direction === "up" ? "Yes" : "No";
  const entryPrice = side === "Yes" ? signal.entryPrice : 1 - signal.entryPrice;
  if (!(entryPrice > 0 && entryPrice < 1)) return null; // degenerate/already-settled price, not a real tradeable entry
  const won = side === "Yes" ? yesWon : !yesWon;
  const shares = 1 / entryPrice;
  return {
    walletAddress: "volatility-breakout",
    conditionId,
    outcome: side,
    eventKey,
    category: asset,
    entryTimestamp,
    entryPrice,
    usdcStaked: 1,
    shares,
    resolved: true,
    won,
    netReturn: won ? shares - 1 : -1,
  };
}

export async function backtestVolatilityBreakoutMarket(
  asset: LadderAsset,
  eventKey: string,
  market: GammaMarket
): Promise<BacktestTrial | null> {
  const tokenIds: string[] = JSON.parse(market.clobTokenIds ?? "[]");
  const outcomes: string[] = JSON.parse(market.outcomes ?? "[]");
  if (tokenIds.length !== 2 || outcomes.length !== 2) return null;
  if (!market.endDate) return null;
  const yesWon = settledYesWon(market);
  if (yesWon === null) return null;

  const startTs = Math.floor(new Date(market.startDate ?? market.endDate).getTime() / 1000);
  const endTs = Math.floor(new Date(market.endDate).getTime() / 1000);
  if (!(endTs > startTs)) return null;

  const found = await detectBreakoutIncrementally(market, tokenIds[0], startTs, endTs);
  if (!found) return null;
  return breakoutTrial({
    asset,
    eventKey,
    conditionId: market.conditionId,
    signal: found.signal,
    entryTimestamp: found.series[found.signal.breakoutIndex].t,
    yesWon,
  });
}

// Entry-price buckets. A breakout entry can land anywhere in (0,1) (unlike
// the harvest-zone backtest's 5-45c), so this spans the full range; the
// 5-15c bucket is kept identical to legacy summarize()'s so the old
// "5-15c bucket" finding is directly comparable.
export const PRICE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "0-5c", min: 0, max: 0.05 },
  { label: "5-15c", min: 0.05, max: 0.15 },
  { label: "15-25c", min: 0.15, max: 0.25 },
  { label: "25-35c", min: 0.25, max: 0.35 },
  { label: "35-45c", min: 0.35, max: 0.45 },
  { label: "45-65c", min: 0.45, max: 0.65 },
  { label: "65-85c", min: 0.65, max: 0.85 },
  { label: "85-95c", min: 0.85, max: 0.95 },
  { label: "95-100c", min: 0.95, max: 1.0001 },
];

// Coarser clustering (exported for tests): re-keys each trial by the
// calendar month its ladder resolved in, merging same-month BTC and WTI
// events into one cluster. eventKey slugs look like
// "what-price-will-bitcoin-hit-in-august-2026" / "...-in-august" (2025 and
// earlier); the endDate-derived month is passed in rather than parsed back
// out of the slug to avoid the year-less ambiguity.
export function regroupByMonth(trials: BacktestTrial[], monthByEventKey: Map<string, string>): BacktestTrial[] {
  return trials.map((t) => ({ ...t, eventKey: monthByEventKey.get(t.eventKey) ?? t.eventKey }));
}

export const DEFAULT_EVENTS_PER_ASSET = 15;

// Usage: npm run volatility-breakout [-- --eventsPerAsset=15]
// Same --flag=value argv style as favoriteHarvesting.ts.
export function parseArgs(argv: string[]): { eventsPerAsset: number } {
  const arg = argv.find((a) => a.startsWith("--eventsPerAsset="));
  const parsed = arg ? parseInt(arg.split("=")[1], 10) : DEFAULT_EVENTS_PER_ASSET;
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`--eventsPerAsset must be a positive integer, got "${arg}"`);
  return { eventsPerAsset: parsed };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function report(label: string, r: StrategyResult): void {
  const ci = r.roiBootstrapCI ? `[${pct(r.roiBootstrapCI[0])}, ${pct(r.roiBootstrapCI[1])}]` : "n/a (too few trials/clusters)";
  const flag = r.distinctEvents < MIN_SAMPLE_SIZE ? `  [below MIN_SAMPLE_SIZE=${MIN_SAMPLE_SIZE} independent events -- provisional]` : "";
  console.log(
    `  ${label.padEnd(10)} trials=${r.trialCount} distinctEvents=${r.distinctEvents} winRate=${pct(r.winRate)} ` +
      `roi=${pct(r.roi)} 95% CI ${ci}${flag}`
  );
}

export async function main() {
  const { eventsPerAsset } = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();
  const config = defaultBacktestConfig({
    strategyName: "volatility-breakout",
    strategyVersion: "2.0.0",
    entryRule: `first compression->breakout on a monthly ladder rung's Yes price (${JSON.stringify(DETECTION_OPTS)}), $1 on the breakout side`,
  });

  const trials: BacktestTrial[] = [];
  const monthByEventKey = new Map<string, string>();
  for (const asset of Object.keys(LADDER_QUERIES) as LadderAsset[]) {
    const { query, slugFragment } = LADDER_QUERIES[asset];
    const events = selectClosedMonthlyLadders(await searchEvents(query, 100, "closed"), slugFragment, eventsPerAsset, nowMs);
    // Month the ladder is ABOUT: endDates are the first instant of the
    // next month (e.g. 2026-09-01T04:00Z for August), so step back a day.
    for (const event of events) {
      monthByEventKey.set(event.slug, new Date(new Date(event.endDate!).getTime() - 24 * 3600 * 1000).toISOString().slice(0, 7));
    }
    console.log(`${asset}: ${events.length} closed monthly ladders (${events.map((e) => monthByEventKey.get(e.slug)).join(", ")})`);
    for (const event of events) {
      let found = 0;
      for (const market of event.markets ?? []) {
        try {
          const trial = await backtestVolatilityBreakoutMarket(asset, event.slug, market);
          if (trial) {
            trials.push(trial);
            found++;
          }
        } catch (err) {
          console.error(`  skip ${market.question}: ${(err as Error).message}`);
        }
      }
      console.log(`  ${event.slug}: ${found} breakout trials from ${(event.markets ?? []).length} rungs`);
    }
  }

  console.log(`\n=== Volatility-breakout, grouped by event (one monthly ladder = one independent sample) ===`);
  report("all", computeStrategyResult(trials, config));
  for (const asset of Object.keys(LADDER_QUERIES) as LadderAsset[]) {
    report(
      asset,
      computeStrategyResult(
        trials.filter((t) => t.category === asset),
        config
      )
    );
  }

  console.log(`\n=== By entry-price bucket (event-grouped) ===`);
  for (const b of PRICE_BUCKETS) {
    const inBucket = trials.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max);
    if (inBucket.length > 0) report(b.label, computeStrategyResult(inBucket, config));
  }

  console.log(`\n=== Stricter: grouped by calendar month (same-month BTC+WTI ladders = one cluster) ===`);
  report("all", computeStrategyResult(regroupByMonth(trials, monthByEventKey), config));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
