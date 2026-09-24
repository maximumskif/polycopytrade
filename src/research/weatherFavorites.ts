// Weather favorite-longshot test (2026-09-24). Prompted by HighTempTation
// (WEATHER leaderboard, 74/100 wallet score, 99.3% win rate / +9.3% ROI
// over 2,267 events), which buys near-certain outcomes in daily
// temperature-range markets for thin margins. Copying it with a delay may
// erase that edge, so this asks whether the underlying edge is directly
// tradeable: are heavily-favored outcomes in resolved Polymarket
// daily-temperature markets systematically underpriced?
//
// Unlike favoriteHarvesting.ts (items 32-34), this does NOT source fills
// from the local wallet_activity DB (reset 2026-09-22, nearly empty).
// Instead it pulls CLOSED weather events straight from gamma-api
// (tag_slug=weather), keeps the daily "highest/lowest temperature in
// <city> on <date>" events (the bulk of the tag, ~75 per day, and exactly
// HighTempTation's niche), and for each settled range-market reads the
// CLOB price history at a fixed lead time before an anchor:
//   - anchor=end (default): the event's endDate (12:00Z on the measured
//     day), capped at the market's real closedTime so an entry can never
//     land after the market stopped trading;
//   - anchor=close: the market's closedTime (UMA resolution), i.e. "how
//     much is left on the table late, once the day's reading is mostly in."
// At that instant the favorite side of each binary range-market (Yes if
// its price > 0.5, else No at 1 - Yes) is bought with $1 if its price
// falls in a band. Price history is the CLOB's own series (mid/last), so a
// slippage assumption stands in for crossing the spread -- default
// slippageBps=50 (~half a 1c tick at 95c), feeBps=0 (weather markets carry
// no taker fee as of this writing), both applied exactly the way
// engine.ts's applyCosts does (fee off the stake, slippage on the price).
//
// Independence: every range-market of one event is one correlated bet on a
// single temperature reading, so trials are keyed by event slug and every
// number goes through computeStrategyResult (event-clustered bootstrap CI,
// MIN_SAMPLE_SIZE). Two stricter groupings are reported too: city-date
// (merges that city's highest+lowest events for the day) and date (every
// sampled city on one day = one cluster, since weather regimes and the
// resolution source's publishing behavior are shared).
//
// Sampling: one gamma call per calendar day for --days days (starting
// --skipDays back so late-resolving events aren't selectively missing),
// then --eventsPerDay temperature events per day, picked by a fixed slug
// hash (deterministic, not "whatever the API lists first"). Spreading over
// many days instead of pulling every city of the last 3 days is what keeps
// the date-level cluster count meaningful.
//
// Usage: npm run weather-favorites -- [--days=40] [--eventsPerDay=5]
//   [--leadHours=24,6] [--anchor=end|close] [--slippageBps=50] [--feeBps=0]
//   [--cache=/path/to/pull.json] [--asOf=YYYY-MM-DD] [--sensitivityBps=150,300]
//   [--json=/path/to/result.json]
// --asOf pins "today" (the window is asOf-skipDays-days+1 .. asOf-skipDays),
// so a pre-registered window (npm run prereg) is reproducible on any day;
// --sensitivityBps adds slippage-sensitivity rows to --json's output (a
// machine-readable result, src/research/researchResult.ts).

import { z } from "zod";
import { fetchRaw, getPricesHistory } from "../api/client";
import { defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../backtesting/statistics";
import { simulateBankroll, wilsonLowerBound } from "../backtesting/bankrollSimulation";
import { validateSchema } from "../utils/validateSchema";
import type { BacktestConfig, BacktestTrial, StrategyResult } from "../domain/types";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  countComparisons,
  describeComparisons,
  multipleComparisonReport,
  type ComparisonCandidate,
  type ComparisonDimension,
} from "./comparisons";
import { isoDate, parseBpsList, resultRow, spanOf, writeResearchResult, type DateWindow, type ResultRow } from "./researchResult";
import type { RowKeySpace } from "./preregistration";

const GAMMA_API = "https://gamma-api.polymarket.com";

// Local schema rather than the shared GammaEventSchema: this needs
// closedTime, which the shared schema (src/api/schemas.ts) strips, and
// editing the shared client/schemas is out of scope for this branch.
const WxMarketSchema = z.object({
  conditionId: z.string(),
  question: z.string(),
  outcomes: z.string().optional(),
  outcomePrices: z.string().optional(),
  clobTokenIds: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  closedTime: z.string().nullable().optional(),
  closed: z.boolean(),
});
const WxEventSchema = z.object({
  slug: z.string(),
  endDate: z.string().optional(),
  markets: z.array(WxMarketSchema).nullable().optional(),
});
const WxEventsSchema = z.array(WxEventSchema);
export type WxMarket = z.infer<typeof WxMarketSchema>;
export type WxEvent = z.infer<typeof WxEventSchema>;

export interface PricePoint {
  t: number;
  p: number;
}

// gamma serves closedTime as "2026-07-10 15:19:58+00" (not ISO) and
// endDate/startDate as ISO -- normalize both to unix seconds.
export function parseGammaTime(s: string | null | undefined): number | null {
  if (!s) return null;
  let iso = s.trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(iso)) iso += ":00";
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const TEMP_SLUG_RE = /^(highest|lowest)-temperature-in-(.+)-on-([a-z]+-\d{1,2}-\d{4})$/;

export function parseTemperatureSlug(slug: string): { kind: "highest" | "lowest"; city: string; date: string } | null {
  const m = TEMP_SLUG_RE.exec(slug);
  if (!m) return null;
  return { kind: m[1] as "highest" | "lowest", city: m[2], date: m[3] };
}

// Last observed price at or before `ts`, provided it's no older than
// `maxStaleSeconds` -- never a point from after the entry instant.
export function priceAt(series: PricePoint[], ts: number, maxStaleSeconds: number): number | null {
  let best: PricePoint | null = null;
  for (const pt of series) {
    if (pt.t <= ts && (best === null || pt.t > best.t)) best = pt;
  }
  if (!best || ts - best.t > maxStaleSeconds) return null;
  return best.p;
}

// Index of the outcome that won, only for a closed market with a clean
// final 0/1 settlement (not a stale live quote or a 50/50 void).
export function settledWinnerIndex(market: Pick<WxMarket, "closed" | "outcomePrices">): 0 | 1 | null {
  if (!market.closed) return null;
  const finalPrices: number[] = JSON.parse(market.outcomePrices ?? "[]").map(Number);
  if (finalPrices.length !== 2) return null;
  if (finalPrices[0] >= 0.99 && finalPrices[1] <= 0.01) return 0;
  if (finalPrices[1] >= 0.99 && finalPrices[0] <= 0.01) return 1;
  return null;
}

// Favorite side of a binary market given the first ("Yes") token's price.
// The second token's price is taken as 1 - p (the CLOB series is a
// mid/last-style price, symmetric across the complementary tokens).
export function favoriteSide(yesPrice: number): { index: 0 | 1; price: number } {
  return yesPrice > 0.5 ? { index: 0, price: yesPrice } : { index: 1, price: 1 - yesPrice };
}

export interface PriceBucket {
  label: string;
  min: number;
  max: number; // exclusive
}

// 85-99c are the bands under test; 70-85 is context only. >=99c is
// excluded (a pre-settlement 99.5c quote is a settled-in-all-but-name
// artifact whose 0.5c upside is below any realistic spread).
export const PRICE_BUCKETS: PriceBucket[] = [
  { label: "70-85", min: 0.7, max: 0.85 },
  { label: "85-90", min: 0.85, max: 0.9 },
  { label: "90-95", min: 0.9, max: 0.95 },
  { label: "95-99", min: 0.95, max: 0.99 },
];

export function bucketFor(price: number, buckets: PriceBucket[] = PRICE_BUCKETS): PriceBucket | null {
  return buckets.find((b) => price >= b.min && price < b.max) ?? null;
}

// $1 stake on the favorite at `quotedPrice`, costs applied the same way as
// engine.ts's applyCosts (fee off the stake, slippage worsens the price).
// entryPrice keeps the QUOTED price (what the bucket is defined on).
export function favoriteTrial(args: {
  eventKey: string;
  category: string;
  conditionId: string;
  outcome: string;
  entryTimestamp: number;
  quotedPrice: number;
  won: boolean;
  config: Pick<BacktestConfig, "feeBps" | "slippageBps">;
}): BacktestTrial | null {
  const { quotedPrice, won, config } = args;
  if (!(quotedPrice > 0 && quotedPrice < 1)) return null;
  const effectivePrice = Math.min(1, quotedPrice * (1 + config.slippageBps / 10_000));
  const shares = (1 - config.feeBps / 10_000) / effectivePrice;
  return {
    walletAddress: "weather-favorites",
    conditionId: args.conditionId,
    outcome: args.outcome,
    eventKey: args.eventKey,
    category: args.category,
    entryTimestamp: args.entryTimestamp,
    entryPrice: quotedPrice,
    usdcStaked: 1,
    shares,
    resolved: true,
    won,
    netReturn: won ? shares - 1 : -1,
  };
}

// Entry instant for one market at one lead time, or null if the market
// wasn't open then. anchor=end caps at closedTime so an entry never lands
// after trading stopped.
export function entryTimestamp(
  market: Pick<WxMarket, "startDate" | "endDate" | "closedTime">,
  eventEndDate: string | undefined,
  anchor: "end" | "close",
  leadHours: number
): number | null {
  const closedTs = parseGammaTime(market.closedTime);
  const endTs = parseGammaTime(eventEndDate ?? market.endDate);
  let anchorTs: number | null;
  if (anchor === "close") anchorTs = closedTs;
  else anchorTs = endTs === null ? null : closedTs === null ? endTs : Math.min(endTs, closedTs);
  if (anchorTs === null) return null;
  const ts = anchorTs - Math.round(leadHours * 3600);
  const startTs = parseGammaTime(market.startDate);
  if (startTs !== null && ts < startTs) return null;
  return ts;
}

// Pure trial construction for one event at one lead time, given each
// market's Yes-token price history. Every settled market contributes at
// most one trial (its favorite side), only if that price is in a bucket.
export function eventTrials(args: {
  event: WxEvent;
  histories: Map<string, PricePoint[]>; // keyed by Yes clobTokenId
  anchor: "end" | "close";
  leadHours: number;
  maxStaleSeconds: number;
  config: Pick<BacktestConfig, "feeBps" | "slippageBps">;
  buckets?: PriceBucket[];
}): BacktestTrial[] {
  const { event, histories, anchor, leadHours, maxStaleSeconds, config } = args;
  const buckets = args.buckets ?? PRICE_BUCKETS;
  const parsed = parseTemperatureSlug(event.slug);
  const category = parsed ? `${parsed.kind}-temp` : "weather";
  const out: BacktestTrial[] = [];
  for (const market of event.markets ?? []) {
    const winner = settledWinnerIndex(market);
    if (winner === null) continue;
    const tokenIds: string[] = JSON.parse(market.clobTokenIds ?? "[]");
    const outcomes: string[] = JSON.parse(market.outcomes ?? "[]");
    if (tokenIds.length !== 2 || outcomes.length !== 2) continue;
    const series = histories.get(tokenIds[0]);
    if (!series) continue;
    const ts = entryTimestamp(market, event.endDate, anchor, leadHours);
    if (ts === null) continue;
    const yesPrice = priceAt(series, ts, maxStaleSeconds);
    if (yesPrice === null) continue;
    const fav = favoriteSide(yesPrice);
    if (!bucketFor(fav.price, buckets)) continue;
    const trial = favoriteTrial({
      eventKey: event.slug,
      category,
      conditionId: market.conditionId,
      outcome: outcomes[fav.index],
      entryTimestamp: ts,
      quotedPrice: fav.price,
      won: fav.index === winner,
      config,
    });
    if (trial) out.push(trial);
  }
  return out;
}

// Stricter clusterings for the correlation check.
export function cityDateKey(eventSlug: string): string {
  const p = parseTemperatureSlug(eventSlug);
  return p ? `${p.city}:${p.date}` : eventSlug;
}
export function dateKey(eventSlug: string): string {
  const p = parseTemperatureSlug(eventSlug);
  return p ? p.date : eventSlug;
}
export function regroup(trials: BacktestTrial[], keyFn: (eventKey: string) => string): BacktestTrial[] {
  return trials.map((t) => ({ ...t, eventKey: keyFn(t.eventKey) }));
}

// Deterministic "random" pick of k events: FNV-1a hash of the slug, lowest
// k hashes win. Stable across runs and independent of API list order.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
export function pickEvents(events: WxEvent[], k: number): WxEvent[] {
  return events
    .filter((e) => parseTemperatureSlug(e.slug) !== null)
    .sort((a, b) => fnv1a(a.slug) - fnv1a(b.slug) || (a.slug < b.slug ? -1 : 1))
    .slice(0, k);
}

export interface Args {
  days: number;
  skipDays: number;
  eventsPerDay: number;
  leadHours: number[];
  anchor: "end" | "close";
  slippageBps: number;
  feeBps: number;
  maxStaleHours: number;
  cache: string | null;
  asOf: string | null;
  sensitivityBps: number[];
  json: string | null;
}

export function parseArgs(argv: string[]): Args {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const int = (name: string, dflt: number, min: number) => {
    const raw = get(name);
    const v = raw === undefined ? dflt : Number(raw);
    if (!Number.isFinite(v) || v < min) throw new Error(`--${name} must be a number >= ${min}, got "${raw}"`);
    return v;
  };
  const leadRaw = get("leadHours") ?? "24,6";
  const leadHours = leadRaw.split(",").map(Number);
  if (leadHours.length === 0 || leadHours.some((h) => !Number.isFinite(h) || h < 0)) {
    throw new Error(`--leadHours must be a comma list of non-negative hours, got "${leadRaw}"`);
  }
  const anchor = get("anchor") ?? "end";
  if (anchor !== "end" && anchor !== "close") throw new Error(`--anchor must be "end" or "close", got "${anchor}"`);
  return {
    days: int("days", 40, 1),
    skipDays: int("skipDays", 3, 0),
    eventsPerDay: int("eventsPerDay", 5, 1),
    leadHours,
    anchor,
    slippageBps: int("slippageBps", 50, 0),
    feeBps: int("feeBps", 0, 0),
    maxStaleHours: int("maxStaleHours", 3, 0),
    cache: get("cache") ?? null,
    asOf: get("asOf") === undefined ? null : isoDate(get("asOf")!),
    sensitivityBps: parseBpsList(get("sensitivityBps"), "sensitivityBps"),
    json: get("json") ?? null,
  };
}

// Calendar days the pull walks: skipDays..skipDays+days-1 days before
// asOf (default: today, UTC). Newest date first.
export function windowDates(args: Pick<Args, "days" | "skipDays" | "asOf">, now = new Date()): string[] {
  const today = args.asOf ? Date.parse(`${args.asOf}T00:00:00Z`) : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: string[] = [];
  for (let d = args.skipDays; d < args.skipDays + args.days; d++) out.push(new Date(today - d * 86400_000).toISOString().slice(0, 10));
  return out;
}

export function requestedWindow(args: Pick<Args, "days" | "skipDays" | "asOf">, now = new Date()): DateWindow {
  return spanOf(windowDates(args, now))!;
}

// The 85-99c roll-up is reported (and emitted) alongside the four bands.
export const ROLLUP_BUCKET = { label: "85-99", min: 0.85, max: 0.99 };
export const GROUPINGS = ["event", "city-date", "date"] as const;

// Every result-row key --json can produce for these args (npm run prereg
// checks a rule against it at create time).
export function resultKeySpace(args: Args): RowKeySpace {
  return {
    bucket: [...PRICE_BUCKETS.map((b) => b.label), ROLLUP_BUCKET.label],
    leadHours: args.leadHours,
    slippageBps: [...new Set([args.slippageBps, ...args.sensitivityBps])],
    grouping: [...GROUPINGS],
  };
}

async function closedWeatherEventsOn(dateIso: string): Promise<WxEvent[]> {
  const out: WxEvent[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const qs = new URLSearchParams({
      tag_slug: "weather",
      closed: "true",
      limit: "100",
      offset: String(offset),
      end_date_min: `${dateIso}T00:00:00Z`,
      end_date_max: `${dateIso}T23:59:59Z`,
    });
    const page = validateSchema(WxEventsSchema, await fetchRaw(`${GAMMA_API}/events?${qs.toString()}`), "GET /events (weather)");
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

// Histories are cached per token for ONE price window, so a cache is only
// reusable when that window covers the requested one (same anchor, lead
// range and staleness inside it) -- otherwise priceAt would silently find
// nothing and trials would just vanish.
interface CacheWindow {
  anchor: "end" | "close";
  minLead: number;
  maxLead: number;
  maxStaleHours: number;
}
interface PullCache {
  window?: CacheWindow;
  events: WxEvent[];
  histories: Record<string, PricePoint[]>;
}

export function cacheWindowCovers(cached: CacheWindow, wanted: CacheWindow): boolean {
  return (
    cached.anchor === wanted.anchor &&
    cached.minLead <= wanted.minLead &&
    cached.maxLead + cached.maxStaleHours >= wanted.maxLead + wanted.maxStaleHours
  );
}

async function pull(args: Args): Promise<PullCache> {
  const maxLead = Math.max(...args.leadHours);
  const minLead = Math.min(...args.leadHours);
  const window: CacheWindow = { anchor: args.anchor, minLead, maxLead, maxStaleHours: args.maxStaleHours };
  const cache: PullCache = { window, events: [], histories: {} };
  if (args.cache && existsSync(args.cache)) {
    const loaded = JSON.parse(readFileSync(args.cache, "utf8")) as PullCache;
    if (loaded.window && !cacheWindowCovers(loaded.window, window)) {
      throw new Error(
        `cache ${args.cache} was pulled for ${JSON.stringify(loaded.window)}, which doesn't cover ${JSON.stringify(window)} -- use another --cache file`
      );
    }
    Object.assign(cache, loaded, { window: loaded.window ?? window });
    console.log(`Loaded cache ${args.cache}: ${cache.events.length} events, ${Object.keys(cache.histories).length} histories`);
    if (loaded.window && (loaded.window.minLead !== minLead || loaded.window.maxLead !== maxLead)) {
      console.log(
        `  (cached window ${JSON.stringify(loaded.window)}; analysis-only reuse is fine, but newly pulled events keep that window)`
      );
    }
  }
  const have = new Set(cache.events.map((e) => e.slug));
  const fetchWindow = cache.window ?? window;
  const stale = fetchWindow.maxStaleHours * 3600;
  const save = () => {
    if (args.cache) writeFileSync(args.cache, JSON.stringify(cache));
  };

  for (const dateIso of windowDates(args)) {
    const already = cache.events.filter((e) => e.endDate?.startsWith(dateIso)).length;
    if (already >= args.eventsPerDay) continue;
    let dayEvents: WxEvent[];
    try {
      dayEvents = await closedWeatherEventsOn(dateIso);
    } catch (err) {
      console.error(`  ${dateIso}: event listing failed: ${(err as Error).message}`);
      continue;
    }
    const picked = pickEvents(dayEvents, args.eventsPerDay).filter((e) => !have.has(e.slug));
    let fetched = 0;
    for (const event of picked) {
      for (const market of event.markets ?? []) {
        if (settledWinnerIndex(market) === null) continue;
        const tokenIds: string[] = JSON.parse(market.clobTokenIds ?? "[]");
        if (tokenIds.length !== 2 || cache.histories[tokenIds[0]]) continue;
        const earliest = entryTimestamp(market, event.endDate, args.anchor, fetchWindow.maxLead);
        const latest = entryTimestamp(market, event.endDate, args.anchor, fetchWindow.minLead);
        if (latest === null) continue;
        const startTs = (earliest ?? latest) - stale;
        try {
          const res = await getPricesHistory(tokenIds[0], startTs, latest + 60, 10, { market });
          cache.histories[tokenIds[0]] = res.history ?? [];
          fetched++;
        } catch (err) {
          console.error(`  skip ${market.question}: ${(err as Error).message}`);
        }
      }
      cache.events.push(event);
      have.add(event.slug);
    }
    save();
    console.log(
      `  ${dateIso}: ${dayEvents.length} closed weather events, picked ${picked.length} temperature events, ${fetched} price histories`
    );
  }
  return cache;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function row(label: string, r: StrategyResult, grossRoi?: number): string {
  const ci = r.roiBootstrapCI ? `[${pct(r.roiBootstrapCI[0])}, ${pct(r.roiBootstrapCI[1])}]` : "n/a";
  const flag = r.distinctEvents < MIN_SAMPLE_SIZE ? ` [<${MIN_SAMPLE_SIZE} events, provisional]` : "";
  const gross = grossRoi === undefined ? "" : ` (gross ${pct(grossRoi)})`;
  return (
    `  ${label.padEnd(12)} trials=${String(r.trialCount).padStart(4)} events=${String(r.distinctEvents).padStart(4)} ` +
    `winRate=${pct(r.winRate)} roi=${pct(r.roi)}${gross} 95% CI ${ci}${flag}`
  );
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`weather-favorites: ${JSON.stringify(args)}`);
  const data = await pull(args);
  const histories = new Map(Object.entries(data.histories));
  const costs = { feeBps: args.feeBps, slippageBps: args.slippageBps };
  const days = new Set(data.events.map((e) => dateKey(e.slug))).size;
  console.log(`\nPulled ${data.events.length} temperature events across ${days} dates, ${histories.size} price histories.`);
  const candidates: ComparisonCandidate[] = [];
  const rows: ResultRow[] = [];

  for (const leadHours of args.leadHours) {
    const config = defaultBacktestConfig({
      strategyName: "weather-favorites",
      strategyVersion: "1.0.0",
      entryRule: `buy the favorite of each settled daily-temperature range-market ${leadHours}h before ${args.anchor === "end" ? "event endDate (capped at closedTime)" : "closedTime"}, $1/trial`,
      feeBps: args.feeBps,
      slippageBps: args.slippageBps,
    });
    const build = (c: typeof costs) =>
      data.events.flatMap((event) =>
        eventTrials({ event, histories, anchor: args.anchor, leadHours, maxStaleSeconds: args.maxStaleHours * 3600, config: c })
      );
    const trials = build(costs);
    const grossTrials = build({ feeBps: 0, slippageBps: 0 });
    if (args.json) {
      for (const slippageBps of new Set([args.slippageBps, ...args.sensitivityBps])) {
        const costed = slippageBps === args.slippageBps ? trials : build({ feeBps: args.feeBps, slippageBps });
        for (const b of [...PRICE_BUCKETS, ROLLUP_BUCKET]) {
          const inB = costed.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max);
          const groupings: Record<(typeof GROUPINGS)[number], BacktestTrial[]> = {
            event: inB,
            "city-date": regroup(inB, cityDateKey),
            date: regroup(inB, dateKey),
          };
          for (const g of GROUPINGS) {
            rows.push(resultRow({ bucket: b.label, leadHours, slippageBps, grouping: g }, computeStrategyResult(groupings[g], config)));
          }
        }
      }
    }

    console.log(`\n=== lead ${leadHours}h before ${args.anchor} (fee ${args.feeBps}bps, slippage ${args.slippageBps}bps) ===`);
    for (const b of PRICE_BUCKETS) {
      const inB = trials.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max);
      const grossInB = grossTrials.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max);
      if (inB.length === 0) {
        console.log(`  ${b.label.padEnd(12)} no trials`);
        continue;
      }
      const gross = computeStrategyResult(grossInB, config).roi;
      const bucketResult = computeStrategyResult(inB, config);
      candidates.push({ label: `${b.label} @${leadHours}h`, result: bucketResult, trials: inB });
      console.log(row(b.label, bucketResult, gross));
      console.log(row("  city-date", computeStrategyResult(regroup(inB, cityDateKey), config)));
      console.log(row("  date", computeStrategyResult(regroup(inB, dateKey), config)));
      const avgPrice = inB.reduce((s, t) => s + t.entryPrice, 0) / inB.length;
      const yesFav = inB.filter((t) => t.outcome === "Yes").length;
      console.log(
        `    avg quoted price ${(avgPrice * 100).toFixed(1)}c (breakeven winRate after costs ${pct((avgPrice * (1 + args.slippageBps / 10_000)) / (1 - args.feeBps / 10_000))}); favorite side Yes=${yesFav} No=${inB.length - yesFav}`
      );

      if (inB.length >= 10) {
        const ordered = [...inB].sort((a, c) => a.entryTimestamp - c.entryTimestamp);
        const wins = ordered.filter((t) => t.won).length;
        const pWin = wilsonLowerBound(wins, ordered.length);
        const sim = simulateBankroll(
          ordered.map((t) => ({ won: t.won === true, price: t.entryPrice * (1 + args.slippageBps / 10_000) })),
          { pWinEstimate: pWin, startingBankroll: 1000 }
        );
        console.log(
          `    bankroll sim (Wilson LB pWin=${pct(pWin)}, quarter-Kelly, 10% cap): $1000 -> $${sim.finalBankroll.toFixed(2)} over ${sim.betsPlaced} bets, maxDD=${pct(sim.maxDrawdownPct)}${sim.busted ? " [BUSTED]" : ""}`
        );
      }
    }
    const fav85 = trials.filter((t) => t.entryPrice >= 0.85);
    console.log(
      row(
        "all 85-99",
        computeStrategyResult(fav85, config),
        computeStrategyResult(
          grossTrials.filter((t) => t.entryPrice >= 0.85),
          config
        ).roi
      )
    );
    console.log(row("  city-date", computeStrategyResult(regroup(fav85, cityDateKey), config)));
    console.log(row("  date", computeStrategyResult(regroup(fav85, dateKey), config)));
  }

  // The 85-99 roll-up and the city-date/date regroupings are robustness
  // views of the same cells, not extra shots -- k counts bucket x lead.
  const dims: ComparisonDimension[] = [
    { name: "buckets", count: PRICE_BUCKETS.length },
    { name: args.leadHours.length === 1 ? "lead" : "leads", count: args.leadHours.length },
  ];
  console.log("");
  for (const line of multipleComparisonReport(dims, candidates)) console.log(line);

  if (args.json) {
    writeResearchResult(args.json, {
      script: "weather-favorites",
      argv: process.argv.slice(2),
      args: { ...args },
      requestedWindow: requestedWindow(args),
      observedWindow: spanOf(data.events.map((e) => e.endDate?.slice(0, 10)).filter((d): d is string => !!d)),
      comparisons: { k: countComparisons(dims), description: describeComparisons(dims) },
      rows,
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
