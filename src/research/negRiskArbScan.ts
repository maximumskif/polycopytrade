// Multi-outcome ("negRisk") basket-arbitrage scanner (item 73, 2026-09-29).
// In a negRisk event exactly one listed outcome resolves Yes, so:
//   - YES basket: buy 1 YES share of every outcome. Pays exactly $1 -- but
//     ONLY if the listed outcomes are exhaustive. Profitable when the sum
//     of the YES asks plus taker fees < $1.
//   - NO basket: buy 1 NO share of every outcome. Pays n-1 on n legs (n if
//     none of the listed outcomes wins, so exhaustiveness doesn't matter).
//     A NO ask mirrors the YES bid (1 - bid), so it's read off the YES
//     book: profitable when sum(YES bids) - fees > 1.
// Historical price series are mids, which can't show whether an arb was
// executable, so this is a LIVE scanner: it polls every open negRisk
// event's order books on an interval and logs each opportunity with the
// size that actually fits in the book, then summarizes how often
// opportunities appear, how big they are and how many sweeps they last
// (one-sweep blips are bot territory; persistent ones are catchable).
//
// Exhaustiveness (YES basket only): a plain negRisk event lists a fixed
// set, so it's complete when every still-open leg is tradeable. An
// "augmented" event can add outcomes later; it's covered only through its
// "Other" leg (negRiskOther), so it counts as complete only when that leg
// is present and tradeable. Anything else is reported as "incomplete" and
// never counted as a YES-basket opportunity.
//
// Costs: Polymarket taker fee = shares * rate * p * (1-p) per leg
// (docs.polymarket.com/trading/fees, 2026-09-29), rate by event tag;
// markets with feesEnabled=false pay 0. Depth is walked level by level.
//
// Usage: npm run negrisk-arb-scan -- [--durationMin=360] [--intervalSec=120]
//   [--maxEvents=2000] [--refreshMin=30] [--out=data/negrisk-arb/opps.jsonl]
//   npm run negrisk-arb-scan -- --summarize [--out=...]

import { z } from "zod";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchRaw, getOrderBooks } from "../api/client";
import { validateSchema } from "../utils/validateSchema";
import type { OrderBook } from "../api/schemas";

const GAMMA_API = "https://gamma-api.polymarket.com";

// gamma tag slug -> taker fee rate; first match wins, default 0.05.
export const TAG_FEE_RATES: [string, number][] = [
  ["geopolitics", 0],
  ["crypto", 0.07],
  ["politics", 0.04],
  ["tech", 0.04],
  ["finance", 0.04],
  ["mentions", 0.04],
  ["sports", 0.05],
  ["economy", 0.05],
];
export function feeRateFor(tagSlugs: string[]): number {
  for (const [slug, rate] of TAG_FEE_RATES) if (tagSlugs.includes(slug)) return rate;
  return 0.05;
}

// Basket sizes (shares per leg) each opportunity is priced at.
export const SIZES = [10, 50, 100, 500, 1000, 5000];

const MarketSchema = z.object({
  conditionId: z.string(),
  question: z.string().optional(),
  groupItemTitle: z.string().optional(),
  clobTokenIds: z.string().optional(),
  outcomePrices: z.string().optional(),
  closed: z.boolean().optional(),
  active: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  negRiskOther: z.boolean().optional(),
  feesEnabled: z.boolean().optional(),
});
const EventSchema = z.object({
  slug: z.string(),
  title: z.string().optional(),
  enableNegRisk: z.boolean().optional(),
  negRisk: z.boolean().optional(),
  negRiskAugmented: z.boolean().optional(),
  endDate: z.string().optional(),
  tags: z
    .array(z.object({ slug: z.string() }))
    .nullable()
    .optional(),
  markets: z.array(MarketSchema).nullable().optional(),
});
export type ArbMarket = z.infer<typeof MarketSchema>;
export type ArbEvent = z.infer<typeof EventSchema>;

export type Completeness = "closed-set" | "augmented-with-other" | "incomplete" | "decided";
export interface Leg {
  conditionId: string;
  label: string;
  yesToken: string;
  feeRate: number;
}
export interface Classified {
  completeness: Completeness;
  legs: Leg[];
}

export function classifyEvent(event: ArbEvent): Classified {
  const rate = feeRateFor((event.tags ?? []).map((t) => t.slug));
  const markets = event.markets ?? [];
  const legs: Leg[] = [];
  let untradeableOpen = 0;
  let hasOther = false;
  for (const m of markets) {
    if (m.closed) {
      const p: number[] = JSON.parse(m.outcomePrices ?? "[]").map(Number);
      if (p[0] >= 0.99) return { completeness: "decided", legs: [] };
      continue; // resolved No: out of the basket
    }
    const tokens: string[] = JSON.parse(m.clobTokenIds ?? "[]");
    if (!m.acceptingOrders || tokens.length !== 2) {
      untradeableOpen++;
      continue;
    }
    if (m.negRiskOther) hasOther = true;
    legs.push({
      conditionId: m.conditionId,
      label: m.groupItemTitle || m.question || m.conditionId,
      yesToken: tokens[0],
      feeRate: m.feesEnabled === false ? 0 : rate,
    });
  }
  let completeness: Completeness;
  if (event.negRiskAugmented) completeness = hasOther ? "augmented-with-other" : "incomplete";
  else completeness = untradeableOpen === 0 ? "closed-set" : "incomplete";
  return { completeness, legs };
}

export interface Level {
  price: number;
  size: number;
}
export function levels(book: OrderBook | undefined, side: "asks" | "bids"): Level[] {
  const raw = (book?.[side] ?? []).map((l) => ({ price: Number(l.price), size: Number(l.size) }));
  return raw.filter((l) => l.size > 0).sort((a, b) => (side === "asks" ? a.price - b.price : b.price - a.price));
}

// Cost of taking `shares` from one side of a book, taker fee included, at
// price q per share of the token actually bought. null = not enough depth.
// For the NO basket, pass the YES bids with toNo=true: buying NO at 1-bid.
export function takeCost(book: Level[], shares: number, feeRate: number, toNo = false): number | null {
  let left = shares;
  let cost = 0;
  for (const l of book) {
    const q = toNo ? 1 - l.price : l.price;
    const take = Math.min(left, l.size);
    cost += take * q + take * feeRate * q * (1 - q);
    left -= take;
    if (left <= 1e-9) return cost;
  }
  return null;
}

export interface Opportunity {
  kind: "yes" | "no";
  shares: number;
  cost: number;
  payout: number;
  profit: number;
  roi: number;
}

// Best (largest-profit) basket size for each kind that's profitable at all.
export function priceBaskets(legs: Leg[], books: Map<string, OrderBook>, sizes = SIZES): Opportunity[] {
  if (legs.length < 2) return [];
  const out: Opportunity[] = [];
  for (const kind of ["yes", "no"] as const) {
    let best: Opportunity | null = null;
    for (const shares of sizes) {
      let cost = 0;
      let ok = true;
      for (const leg of legs) {
        const book = books.get(leg.yesToken);
        const c =
          kind === "yes" ? takeCost(levels(book, "asks"), shares, leg.feeRate) : takeCost(levels(book, "bids"), shares, leg.feeRate, true);
        if (c === null) {
          ok = false;
          break;
        }
        cost += c;
      }
      if (!ok) break; // bigger sizes can't fit either
      const payout = kind === "yes" ? shares : shares * (legs.length - 1);
      const profit = payout - cost;
      if (profit > 0 && (best === null || profit > best.profit)) best = { kind, shares, cost, payout, profit, roi: profit / cost };
    }
    if (best) out.push(best);
  }
  return out;
}

export interface Args {
  durationMin: number;
  intervalSec: number;
  maxEvents: number;
  refreshMin: number;
  out: string;
  summarize: boolean;
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
    durationMin: num("durationMin", 360, 0),
    intervalSec: num("intervalSec", 120, 10),
    maxEvents: num("maxEvents", 2000, 100),
    refreshMin: num("refreshMin", 30, 1),
    out: get("out") ?? "data/negrisk-arb/opps.jsonl",
    summarize: argv.includes("--summarize"),
  };
}

// gamma rejects offsets past ~2000 with a 422; stop there.
async function openNegRiskEvents(maxEvents: number): Promise<ArbEvent[]> {
  const out: ArbEvent[] = [];
  for (let offset = 0; offset < maxEvents; offset += 100) {
    const qs = new URLSearchParams({
      closed: "false",
      active: "true",
      limit: "100",
      offset: String(offset),
      order: "volume",
      ascending: "false",
    });
    let page: ArbEvent[];
    try {
      page = validateSchema(z.array(EventSchema), await fetchRaw(`${GAMMA_API}/events?${qs.toString()}`), "GET /events (negRisk)");
    } catch (err) {
      console.error(`  event listing stopped at offset ${offset}: ${(err as Error).message}`);
      break;
    }
    out.push(...page.filter((e) => e.enableNegRisk || e.negRisk));
    if (page.length < 100) break;
  }
  return out;
}

interface Row {
  ts: number;
  sweep: number;
  event: string;
  title?: string;
  completeness: Completeness;
  legs: number;
  // Days until the event's endDate: capital is locked until resolution,
  // so a 1% basket resolving in a year is worth far less than one in a day.
  daysToEnd: number | null;
  opp: Opportunity;
}

export function daysToEnd(endDate: string | undefined, nowMs: number): number | null {
  const t = endDate ? Date.parse(endDate) : NaN;
  return Number.isFinite(t) ? Math.max(0, (t - nowMs) / 86_400_000) : null;
}

// Simple annualized return for a hold of `days` (floored at one day).
export function annualized(roi: number, days: number | null): number | null {
  return days === null ? null : roi * (365 / Math.max(1, days));
}
interface SweepRow {
  ts: number;
  sweep: number;
  sweepSummary: { events: Record<Completeness, number>; books: number; opps: number; seconds: number };
}

async function scan(args: Args) {
  mkdirSync(dirname(args.out), { recursive: true });
  const endAt = Date.now() + args.durationMin * 60_000;
  let events: { event: ArbEvent; c: Classified }[] = [];
  let refreshedAt = 0;
  for (let sweep = 1; ; sweep++) {
    const t0 = Date.now();
    if (t0 - refreshedAt > args.refreshMin * 60_000) {
      events = (await openNegRiskEvents(args.maxEvents)).map((event) => ({ event, c: classifyEvent(event) }));
      refreshedAt = Date.now();
    }
    const tokens = [...new Set(events.flatMap((e) => e.c.legs.map((l) => l.yesToken)))];
    const books = new Map((await getOrderBooks(tokens)).map((b) => [b.asset_id, b]));
    const counts: Record<Completeness, number> = { "closed-set": 0, "augmented-with-other": 0, incomplete: 0, decided: 0 };
    let opps = 0;
    const ts = Math.floor(Date.now() / 1000);
    for (const { event, c } of events) {
      counts[c.completeness]++;
      if (c.completeness === "decided") continue;
      for (const opp of priceBaskets(c.legs, books)) {
        // A YES basket on a non-exhaustive set isn't an arbitrage.
        if (opp.kind === "yes" && c.completeness === "incomplete") continue;
        const row: Row = {
          ts,
          sweep,
          event: event.slug,
          title: event.title,
          completeness: c.completeness,
          legs: c.legs.length,
          daysToEnd: daysToEnd(event.endDate, ts * 1000),
          opp,
        };
        appendFileSync(args.out, JSON.stringify(row) + "\n");
        opps++;
      }
    }
    const seconds = (Date.now() - t0) / 1000;
    const summary: SweepRow = { ts, sweep, sweepSummary: { events: counts, books: books.size, opps, seconds } };
    appendFileSync(args.out, JSON.stringify(summary) + "\n");
    console.log(
      `  sweep ${sweep}: ${events.length} negRisk events ${JSON.stringify(counts)}, ${books.size} books, ${opps} opportunities (${seconds.toFixed(1)}s)`
    );
    if (Date.now() + args.intervalSec * 1000 > endAt) break;
    await new Promise((r) => setTimeout(r, Math.max(0, args.intervalSec * 1000 - (Date.now() - t0))));
  }
}

// Consecutive-sweep runs per (event, kind): how long an opportunity lasts.
export function persistence(rows: { sweep: number; event: string; opp: { kind: string } }[]): Map<string, number[]> {
  const sweepsBy = new Map<string, number[]>();
  for (const r of rows) {
    const k = `${r.event}|${r.opp.kind}`;
    sweepsBy.set(k, [...(sweepsBy.get(k) ?? []), r.sweep]);
  }
  const runs = new Map<string, number[]>();
  for (const [k, sweeps] of sweepsBy) {
    const s = [...new Set(sweeps)].sort((a, b) => a - b);
    const lens: number[] = [];
    let len = 1;
    for (let i = 1; i <= s.length; i++) {
      if (i < s.length && s[i] === s[i - 1] + 1) len++;
      else {
        lens.push(len);
        len = 1;
      }
    }
    runs.set(k, lens);
  }
  return runs;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)];
}

export function summarize(file: string) {
  if (!existsSync(file)) throw new Error(`no scan log at ${file}`);
  const lines = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row | SweepRow);
  const sweeps = lines.filter((l): l is SweepRow => "sweepSummary" in l);
  const rows = lines.filter((l): l is Row => "opp" in l);
  if (sweeps.length === 0) throw new Error("no completed sweeps in the log");
  const span = (sweeps[sweeps.length - 1].ts - sweeps[0].ts) / 3600;
  const last = sweeps[sweeps.length - 1].sweepSummary;
  console.log(`${sweeps.length} sweeps over ${span.toFixed(1)}h; last sweep: ${JSON.stringify(last.events)}, ${last.books} books`);
  for (const kind of ["yes", "no"] as const) {
    for (const comp of ["closed-set", "augmented-with-other", "incomplete"] as const) {
      const sel = rows.filter((r) => r.opp.kind === kind && r.completeness === comp);
      if (sel.length === 0) continue;
      const runs = persistence(sel);
      const allRuns = [...runs.values()].flat();
      const perSweepProfit = new Map<number, number>();
      for (const r of sel) perSweepProfit.set(r.sweep, (perSweepProfit.get(r.sweep) ?? 0) + r.opp.profit);
      console.log(
        `\n${kind.toUpperCase()} basket / ${comp}: ${sel.length} sightings, ${runs.size} distinct events, ` +
          `in ${perSweepProfit.size}/${sweeps.length} sweeps`
      );
      console.log(
        `  profit per sighting: median $${median(sel.map((r) => r.opp.profit)).toFixed(2)}, max $${Math.max(...sel.map((r) => r.opp.profit)).toFixed(2)}; ` +
          `roi median ${(median(sel.map((r) => r.opp.roi)) * 100).toFixed(2)}%; size median ${median(sel.map((r) => r.opp.shares))} shares`
      );
      console.log(
        `  persistence (consecutive sweeps): median ${median(allRuns)}, max ${Math.max(...allRuns)}; ` +
          `runs lasting >= 3 sweeps: ${allRuns.filter((n) => n >= 3).length}/${allRuns.length}`
      );
      const ann = sel.map((r) => annualized(r.opp.roi, r.daysToEnd)).filter((x): x is number => x !== null);
      const soon = sel.filter((r) => r.daysToEnd !== null && r.daysToEnd <= 30);
      console.log(
        `  days to resolution: median ${median(sel.map((r) => r.daysToEnd ?? Infinity)).toFixed(0)}; annualized roi median ${(median(ann) * 100).toFixed(1)}%; ` +
          `resolving <= 30 days: ${soon.length} sightings, ${new Set(soon.map((r) => r.event)).size} events`
      );
      const top = [...sel].sort((a, b) => b.opp.profit - a.opp.profit).slice(0, 5);
      for (const r of top)
        console.log(
          `    $${r.opp.profit.toFixed(2)} (${(r.opp.roi * 100).toFixed(2)}%) @${r.opp.shares} sh, ${r.legs} legs, ${r.daysToEnd === null ? "?" : r.daysToEnd.toFixed(0)}d -- ${r.title ?? r.event} [sweep ${r.sweep}]`
        );
    }
  }
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.summarize) return summarize(args.out);
  console.log(`negrisk-arb-scan: ${JSON.stringify(args)}`);
  await scan(args);
  console.log("");
  summarize(args.out);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
