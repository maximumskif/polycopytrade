// Cross-category calibration scan (item 71, 2026-09-29). The project's
// pivot away from copy-trading: instead of asking "which trader beats the
// market?", ask "where is the market's own price wrong?". For a stratified
// sample of settled, liquid Polymarket markets across every major category,
// read each market's CLOB price at fixed, ex-ante-known instants and ask
// whether outcomes priced at p actually win more (or less) often than p,
// after real costs. Two strategy ideas fall out of one pull:
//   - #4 pooled favorite-longshot bias: the price buckets at the pre-end
//     snapshots (-24h/-6h/-1h), all categories -- item 44 only ever did
//     weather, items 32-34 only fills from our own tracked wallets;
//   - #2 endgame harvesting: the 95-99c bucket at the post-end snapshots
//     (+1h/+3h after the market's scheduled endDate, while it is still
//     trading, i.e. result mostly known but not yet resolved).
//
// The bar (user, 2026-09-29): "beat the price" -- win rate above the
// entry price's implied probability, which at even money is 55%; must hold
// out of sample. Each cell prints edge = winRate - avg cost-adjusted price
// (percentage points) next to ROI and its event-clustered CI.
//
// Snapshots are relative to the market's endDate (known when the market
// is listed), never to closedTime (only known afterwards); an entry is only
// taken if the market was still open (startDate <= ts < closedTime) and a
// price was observed at most --maxStaleMinutes before it.
//
// Costs: Polymarket's taker fee is C * rate * p * (1-p) (docs.polymarket.com
// /trading/fees, checked 2026-09-29), i.e. rate * (1 - p) per $1 staked at
// price p -- 2.5% at 50c but 0.25% at 95c for sports. Per-tag rates below.
// Slippage stands in for crossing the spread (price history is mid/last).
//
// Sampling: per day and per tag, one gamma call for that day's closed
// events ordered by volume (top 100 = the tradeable ones), then
// --eventsPerTag events per tag picked by slug hash, then up to
// --marketsPerEvent settled binary markets with volume >= --minVolume
// picked by conditionId hash. Trials cluster by event slug.
//
// Usage: npm run calibration-scan -- [--days=30] [--skipDays=5]
//   [--eventsPerTag=8] [--marketsPerEvent=2] [--minVolume=5000]
//   [--slippageBps=100] [--sensitivityBps=300] [--maxStaleMinutes=60]
//   [--asOf=YYYY-MM-DD] [--cache=data/calibration-scan/pull.json] [--json=...]

import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchRaw, getPricesHistory } from "../api/client";
import { defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../backtesting/statistics";
import { validateSchema } from "../utils/validateSchema";
import type { BacktestTrial, StrategyResult } from "../domain/types";
import { parseGammaTime, priceAt, settledWinnerIndex, type PricePoint } from "./weatherFavorites";
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

// gamma tag -> taker fee rate (docs.polymarket.com/trading/fees). esports
// is listed under sports on the site; weather is excluded (item 44 closed it).
export const TAG_FEE_RATES: Record<string, number> = {
  sports: 0.05,
  esports: 0.05,
  crypto: 0.07,
  politics: 0.04,
  economy: 0.05,
  "pop-culture": 0.05,
  tech: 0.04,
  business: 0.05,
};
export const TAGS = Object.keys(TAG_FEE_RATES);

// Hours relative to the market's endDate. Negative = before (favorite-
// longshot, #4), positive = after scheduled end but still trading (#2).
export const SNAPSHOTS = [-24, -6, -1, 1, 3];

export interface PriceBucket {
  label: string;
  min: number;
  max: number; // exclusive
}
// Both sides of every market are scored, so the curve spans 1-99c.
export const PRICE_BUCKETS: PriceBucket[] = [
  { label: "01-10", min: 0.01, max: 0.1 },
  { label: "10-20", min: 0.1, max: 0.2 },
  { label: "20-30", min: 0.2, max: 0.3 },
  { label: "30-40", min: 0.3, max: 0.4 },
  { label: "40-50", min: 0.4, max: 0.5 },
  { label: "50-60", min: 0.5, max: 0.6 },
  { label: "60-70", min: 0.6, max: 0.7 },
  { label: "70-80", min: 0.7, max: 0.8 },
  { label: "80-90", min: 0.8, max: 0.9 },
  { label: "90-95", min: 0.9, max: 0.95 },
  { label: "95-99", min: 0.95, max: 0.99 },
];

const MarketSchema = z.object({
  conditionId: z.string(),
  question: z.string(),
  outcomes: z.string().optional(),
  outcomePrices: z.string().optional(),
  clobTokenIds: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  closedTime: z.string().nullable().optional(),
  closed: z.boolean(),
  volumeNum: z.number().optional(),
});
const EventSchema = z.object({
  slug: z.string(),
  title: z.string().optional(),
  endDate: z.string().optional(),
  markets: z.array(MarketSchema).nullable().optional(),
});
const EventsSchema = z.array(EventSchema);
export type ScanMarket = z.infer<typeof MarketSchema>;
export type ScanEvent = z.infer<typeof EventSchema> & { tag: string };

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
export function hashPick<T>(items: T[], k: number, key: (t: T) => string): T[] {
  return [...items].sort((a, b) => fnv1a(key(a)) - fnv1a(key(b)) || (key(a) < key(b) ? -1 : 1)).slice(0, k);
}

// Settled binary markets of an event worth scoring.
export function scorableMarkets(event: Pick<ScanEvent, "markets">, minVolume: number): ScanMarket[] {
  return (event.markets ?? []).filter((m) => {
    if (settledWinnerIndex(m) === null) return false;
    if ((m.volumeNum ?? 0) < minVolume) return false;
    return JSON.parse(m.clobTokenIds ?? "[]").length === 2 && JSON.parse(m.outcomes ?? "[]").length === 2;
  });
}

// Entry instant for a snapshot, or null if the market wasn't trading then.
export function snapshotTs(
  market: Pick<ScanMarket, "startDate" | "endDate" | "closedTime">,
  eventEndDate: string | undefined,
  offsetHours: number
): number | null {
  const endTs = parseGammaTime(market.endDate ?? eventEndDate);
  if (endTs === null) return null;
  const ts = endTs + Math.round(offsetHours * 3600);
  const startTs = parseGammaTime(market.startDate);
  const closedTs = parseGammaTime(market.closedTime);
  if (startTs !== null && ts < startTs) return null;
  if (closedTs !== null && ts >= closedTs) return null;
  return ts;
}

// $1 on one side at quoted price p: fee rate*(1-p_eff) off the stake,
// slippage worsens the price. entryPrice keeps the quote (bucket key).
export function sideTrial(args: {
  eventKey: string;
  tag: string;
  conditionId: string;
  outcome: string;
  ts: number;
  quotedPrice: number;
  won: boolean;
  feeRate: number;
  slippageBps: number;
}): BacktestTrial | null {
  const { quotedPrice, won } = args;
  if (!(quotedPrice > 0 && quotedPrice < 1)) return null;
  const p = Math.min(0.999, quotedPrice * (1 + args.slippageBps / 10_000));
  const shares = (1 - args.feeRate * (1 - p)) / p;
  return {
    walletAddress: "calibration-scan",
    conditionId: args.conditionId,
    outcome: args.outcome,
    eventKey: args.eventKey,
    category: args.tag,
    entryTimestamp: args.ts,
    entryPrice: quotedPrice,
    usdcStaked: 1,
    shares,
    resolved: true,
    won,
    netReturn: won ? shares - 1 : -1,
  };
}

// Both sides of every scorable market of an event at one snapshot.
export function eventTrials(
  event: ScanEvent,
  histories: Map<string, PricePoint[]>,
  offsetHours: number,
  opts: { minVolume: number; maxStaleSeconds: number; slippageBps: number; marketIds?: Set<string> }
): BacktestTrial[] {
  const out: BacktestTrial[] = [];
  for (const m of scorableMarkets(event, opts.minVolume)) {
    if (opts.marketIds && !opts.marketIds.has(m.conditionId)) continue;
    const tokenIds: string[] = JSON.parse(m.clobTokenIds!);
    const series = histories.get(tokenIds[0]);
    if (!series) continue;
    const ts = snapshotTs(m, event.endDate, offsetHours);
    if (ts === null) continue;
    const yes = priceAt(series, ts, opts.maxStaleSeconds);
    if (yes === null) continue;
    const winner = settledWinnerIndex(m)!;
    const outcomes: string[] = JSON.parse(m.outcomes!);
    for (const idx of [0, 1] as const) {
      const quoted = idx === 0 ? yes : 1 - yes;
      if (quoted < PRICE_BUCKETS[0].min || quoted >= PRICE_BUCKETS[PRICE_BUCKETS.length - 1].max) continue;
      const t = sideTrial({
        eventKey: event.slug,
        tag: event.tag,
        conditionId: m.conditionId,
        outcome: outcomes[idx],
        ts,
        quotedPrice: quoted,
        won: idx === winner,
        feeRate: TAG_FEE_RATES[event.tag] ?? 0.05,
        slippageBps: opts.slippageBps,
      });
      if (t) out.push(t);
    }
  }
  return out;
}

export interface Args {
  days: number;
  skipDays: number;
  eventsPerTag: number;
  marketsPerEvent: number;
  minVolume: number;
  slippageBps: number;
  sensitivityBps: number[];
  maxStaleMinutes: number;
  asOf: string | null;
  cache: string;
  json: string | null;
}

export function parseArgs(argv: string[]): Args {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const num = (name: string, dflt: number, min: number) => {
    const raw = get(name);
    const v = raw === undefined ? dflt : Number(raw);
    if (!Number.isFinite(v) || v < min) throw new Error(`--${name} must be a number >= ${min}, got "${raw}"`);
    return v;
  };
  return {
    days: num("days", 30, 1),
    skipDays: num("skipDays", 5, 0),
    eventsPerTag: num("eventsPerTag", 8, 1),
    marketsPerEvent: num("marketsPerEvent", 2, 1),
    minVolume: num("minVolume", 5000, 0),
    slippageBps: num("slippageBps", 100, 0),
    sensitivityBps: parseBpsList(get("sensitivityBps") ?? "300", "sensitivityBps"),
    maxStaleMinutes: num("maxStaleMinutes", 60, 1),
    asOf: get("asOf") === undefined ? null : isoDate(get("asOf")!),
    cache: get("cache") ?? "data/calibration-scan/pull.json",
    json: get("json") ?? null,
  };
}

export function windowDates(args: Pick<Args, "days" | "skipDays" | "asOf">, now = new Date()): string[] {
  const today = args.asOf ? Date.parse(`${args.asOf}T00:00:00Z`) : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: string[] = [];
  for (let d = args.skipDays; d < args.skipDays + args.days; d++) out.push(new Date(today - d * 86400_000).toISOString().slice(0, 10));
  return out;
}

export function requestedWindow(args: Pick<Args, "days" | "skipDays" | "asOf">, now = new Date()): DateWindow {
  return spanOf(windowDates(args, now))!;
}

export function resultKeySpace(args: Args): RowKeySpace {
  return {
    bucket: PRICE_BUCKETS.map((b) => b.label),
    snapshot: SNAPSHOTS,
    tag: ["all", ...TAGS],
    slippageBps: [...new Set([args.slippageBps, ...args.sensitivityBps])],
  };
}

interface PullCache {
  events: ScanEvent[];
  // Markets actually picked per event (conditionIds) -- analysis only
  // scores these, so a cache stays reproducible.
  picked: Record<string, string[]>;
  histories: Record<string, PricePoint[]>;
  days: string[]; // YYYY-MM-DD|tag pairs already pulled
}

async function closedEvents(dateIso: string, tag: string): Promise<ScanEvent[]> {
  const qs = new URLSearchParams({
    tag_slug: tag,
    closed: "true",
    limit: "100",
    order: "volume",
    ascending: "false",
    end_date_min: `${dateIso}T00:00:00Z`,
    end_date_max: `${dateIso}T23:59:59Z`,
  });
  const page = validateSchema(EventsSchema, await fetchRaw(`${GAMMA_API}/events?${qs.toString()}`), `GET /events (${tag})`);
  return page.map((e) => ({ ...e, tag }));
}

const MIN_OFFSET = Math.min(...SNAPSHOTS);
const MAX_OFFSET = Math.max(...SNAPSHOTS);

async function pull(args: Args): Promise<PullCache> {
  const cache: PullCache = existsSync(args.cache)
    ? (JSON.parse(readFileSync(args.cache, "utf8")) as PullCache)
    : { events: [], picked: {}, histories: {}, days: [] };
  const done = new Set(cache.days);
  const have = new Set(cache.events.map((e) => e.slug));
  const stale = args.maxStaleMinutes * 60;
  mkdirSync(dirname(args.cache), { recursive: true });
  let requests = 0;
  for (const dateIso of windowDates(args)) {
    let fetched = 0;
    let pickedCount = 0;
    for (const tag of TAGS) {
      const key = `${dateIso}|${tag}`;
      if (done.has(key)) continue;
      let events: ScanEvent[];
      try {
        events = await closedEvents(dateIso, tag);
        requests++;
      } catch (err) {
        console.error(`  ${key}: listing failed: ${(err as Error).message}`);
        continue;
      }
      const eligible = events.filter((e) => !have.has(e.slug) && scorableMarkets(e, args.minVolume).length > 0);
      for (const event of hashPick(eligible, args.eventsPerTag, (e) => e.slug)) {
        const markets = hashPick(scorableMarkets(event, args.minVolume), args.marketsPerEvent, (m) => m.conditionId);
        for (const m of markets) {
          const yesToken: string = JSON.parse(m.clobTokenIds!)[0];
          if (cache.histories[yesToken]) continue;
          const endTs = parseGammaTime(m.endDate ?? event.endDate);
          if (endTs === null) continue;
          const closedTs = parseGammaTime(m.closedTime) ?? endTs + MAX_OFFSET * 3600;
          const startTs = endTs + MIN_OFFSET * 3600 - stale;
          const endReq = Math.min(closedTs, endTs + MAX_OFFSET * 3600) + 60;
          if (endReq <= startTs) continue;
          try {
            const res = await getPricesHistory(yesToken, startTs, endReq, 10, { market: m });
            cache.histories[yesToken] = res.history ?? [];
            fetched++;
            requests++;
          } catch (err) {
            console.error(`  skip ${m.question}: ${(err as Error).message}`);
          }
        }
        // Keep only the picked markets on the cached event (smaller cache).
        cache.events.push({ ...event, markets: markets });
        cache.picked[event.slug] = markets.map((m) => m.conditionId);
        have.add(event.slug);
        pickedCount++;
      }
      cache.days.push(key);
      done.add(key);
    }
    writeFileSync(args.cache, JSON.stringify(cache));
    console.log(`  ${dateIso}: picked ${pickedCount} events, ${fetched} price histories (${requests} requests so far)`);
  }
  return cache;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// A $1 stake pays `shares` on a win, so the cost-adjusted breakeven win
// rate is 1/shares; edge = winRate - its mean, in points.
export function breakevenPrice(t: BacktestTrial): number {
  return 1 / t.shares;
}

function line(label: string, trials: BacktestTrial[], r: StrategyResult): string {
  const avgQuote = trials.reduce((s, t) => s + t.entryPrice, 0) / trials.length;
  const avgBe = trials.reduce((s, t) => s + breakevenPrice(t), 0) / trials.length;
  const edge = r.winRate - avgBe;
  const ci = r.roiBootstrapCI ? `[${pct(r.roiBootstrapCI[0])}, ${pct(r.roiBootstrapCI[1])}]` : "n/a";
  const flag = r.distinctEvents < MIN_SAMPLE_SIZE ? " [provisional]" : "";
  return (
    `  ${label.padEnd(8)} n=${String(r.trialCount).padStart(4)} ev=${String(r.distinctEvents).padStart(4)} ` +
    `quote=${(avgQuote * 100).toFixed(1)}c win=${pct(r.winRate)} edge=${(edge * 100 >= 0 ? "+" : "") + (edge * 100).toFixed(1)}pp ` +
    `roi=${pct(r.roi)} CI ${ci}${flag}`
  );
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`calibration-scan: ${JSON.stringify(args)}`);
  const data = await pull(args);
  const histories = new Map(Object.entries(data.histories));
  const dates = windowDates(args);
  // A cache may hold other windows too; score only this run's dates.
  const inWindow = data.events.filter((e) => dates.includes((e.endDate ?? "").slice(0, 10)));
  const config = defaultBacktestConfig({
    strategyName: "calibration-scan",
    strategyVersion: "1.0.0",
    entryRule: "buy one side of each sampled settled binary market at a fixed snapshot relative to endDate, $1/trial",
    slippageBps: args.slippageBps,
  });
  const byTag = new Map<string, number>();
  for (const e of inWindow) byTag.set(e.tag, (byTag.get(e.tag) ?? 0) + 1);
  console.log(
    `\nSample: ${inWindow.length} events, ${histories.size} price histories; by tag ${JSON.stringify(Object.fromEntries(byTag))}`
  );

  const build = (offset: number, slippageBps: number) =>
    inWindow.flatMap((e) =>
      eventTrials(e, histories, offset, {
        minVolume: args.minVolume,
        maxStaleSeconds: args.maxStaleMinutes * 60,
        slippageBps,
        marketIds: new Set(data.picked[e.slug] ?? []),
      })
    );

  const candidates: ComparisonCandidate[] = [];
  const rows: ResultRow[] = [];
  for (const offset of SNAPSHOTS) {
    const trials = build(offset, args.slippageBps);
    console.log(`\n=== snapshot ${offset > 0 ? "+" : ""}${offset}h vs endDate (slippage ${args.slippageBps}bps, per-tag taker fee) ===`);
    for (const b of PRICE_BUCKETS) {
      const inB = trials.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max);
      if (inB.length === 0) continue;
      const r = computeStrategyResult(inB, config);
      candidates.push({ label: `${b.label} @${offset}h all`, result: r, trials: inB });
      console.log(line(b.label, inB, r));
      for (const tag of TAGS) {
        const inT = inB.filter((t) => t.category === tag);
        if (inT.length === 0) continue;
        const rt = computeStrategyResult(inT, config);
        candidates.push({ label: `${b.label} @${offset}h ${tag}`, result: rt, trials: inT });
        if (rt.distinctEvents >= MIN_SAMPLE_SIZE && rt.roiBootstrapCI && rt.roiBootstrapCI[0] > 0) console.log(line(`  ${tag}`, inT, rt));
      }
    }
    if (args.json) {
      for (const slippageBps of new Set([args.slippageBps, ...args.sensitivityBps])) {
        const costed = slippageBps === args.slippageBps ? trials : build(offset, slippageBps);
        for (const b of PRICE_BUCKETS) {
          const inB = costed.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max);
          for (const tag of ["all", ...TAGS]) {
            const sel = tag === "all" ? inB : inB.filter((t) => t.category === tag);
            if (sel.length === 0) continue;
            rows.push(resultRow({ bucket: b.label, snapshot: offset, tag, slippageBps }, computeStrategyResult(sel, config)));
          }
        }
      }
    }
  }

  const dims: ComparisonDimension[] = [
    { name: "buckets", count: PRICE_BUCKETS.length },
    { name: "snapshots", count: SNAPSHOTS.length },
    { name: "tag slices", count: TAGS.length + 1 },
  ];
  console.log("\n(tag rows print only when >= MIN_SAMPLE_SIZE events and CI lower > 0)\n");
  for (const l of multipleComparisonReport(dims, candidates)) console.log(l);

  if (args.json) {
    writeResearchResult(args.json, {
      script: "calibration-scan",
      argv: process.argv.slice(2),
      args: { ...args },
      requestedWindow: requestedWindow(args),
      observedWindow: spanOf(inWindow.map((e) => e.endDate?.slice(0, 10)).filter((d): d is string => !!d)),
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
