// Liquidity-rewards yield scan (item 77, 2026-09-29). Polymarket pays a
// daily USDC pool per market to makers resting orders near the midpoint
// (docs.polymarket.com/developers/market-makers/liquidity-rewards, read
// 2026-09-29):
//   S(v, s) = ((v - s) / v)^2            v = max spread (c), s = distance
//   Q_one  = sum S * size over bids on m + asks on the complement m'
//   Q_two  = sum S * size over asks on m + bids on m'
//   Qmin   = max(min(Q1, Q2), max(Q1/c, Q2/c))  mid in [0.10, 0.90], c = 3
//          = min(Q1, Q2)                       otherwise (two-sided only)
// sampled once a minute; a maker's daily payout = pool * its share of the
// summed Qmin. Orders below rewards_min_size or outside max spread don't
// score. This is the income side of item 76's maker idea, and it needs no
// view on who wins -- only enough reward per $ of capital to outweigh the
// losses when resting orders get filled by informed takers.
//
// For every market in the rewards program: read both tokens' books, score
// the existing liquidity, and price a hypothetical two-sided quote of
// --shares shares per side at --placement:
//   top    = join the current best qualifying bid/ask (max score, most fills)
//   behind = 1c behind the best qualifying level (fewer fills, less score)
// Our share = ourQ / (ourQ + existingQ); existing makers are aggregated
// into one book-level Qmin (per-maker Qmin sums to at least that, so this
// OVERstates our share somewhat -- read yields as upper bounds). Capital =
// bid cost on YES + bid cost on NO (an ask on YES is a bid on NO).
// Fill risk is NOT modelled here: a yield only matters if it clears the
// adverse-selection losses, which item 76's tape replay measures.
//
// Usage: npm run rewards-scan -- [--shares=0(=min size)] [--placement=top|behind]
//   [--top=25] [--out=data/rewards-scan/latest.json]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchRaw, getOrderBooks } from "../api/client";
import type { OrderBook } from "../api/schemas";

const CLOB = "https://clob.polymarket.com";
export const C = 3;

export interface Order {
  price: number;
  size: number;
}

// Midpoint from the YES book (best bid/ask); null if either side is empty.
export function midpoint(bids: Order[], asks: Order[]): number | null {
  if (bids.length === 0 || asks.length === 0) return null;
  const bb = Math.max(...bids.map((o) => o.price));
  const ba = Math.min(...asks.map((o) => o.price));
  return (bb + ba) / 2;
}

export function orderScore(distanceCents: number, maxSpreadCents: number): number {
  if (distanceCents > maxSpreadCents || distanceCents < 0) return 0;
  return ((maxSpreadCents - distanceCents) / maxSpreadCents) ** 2;
}

// Q for one side: YES-book orders on that side plus complement-book orders
// on the mirrored side, each at its distance from the YES midpoint.
export function sideQ(yesOrders: Order[], noOrders: Order[], mid: number, maxSpreadCents: number, minSize: number): number {
  let q = 0;
  for (const o of yesOrders) {
    if (o.size < minSize) continue;
    q += orderScore(Math.abs(o.price - mid) * 100, maxSpreadCents) * o.size;
  }
  for (const o of noOrders) {
    if (o.size < minSize) continue;
    // A NO order at p sits at 1-p in YES terms.
    q += orderScore(Math.abs(1 - o.price - mid) * 100, maxSpreadCents) * o.size;
  }
  return q;
}

export function qMin(q1: number, q2: number, mid: number): number {
  if (mid >= 0.1 && mid <= 0.9) return Math.max(Math.min(q1, q2), Math.max(q1 / C, q2 / C));
  return Math.min(q1, q2);
}

function orders(book: OrderBook | undefined, side: "bids" | "asks"): Order[] {
  return (book?.[side] ?? []).map((o) => ({ price: Number(o.price), size: Number(o.size) })).filter((o) => o.size > 0);
}

export interface Quote {
  bid: number; // YES bid price
  ask: number; // YES ask price (= NO bid at 1-ask)
}

// Where our two-sided quote goes, in YES terms, rounded to the 1c tick and
// kept inside max spread and off the other side of the book.
export function placeQuote(
  mid: number,
  bestBid: number,
  bestAsk: number,
  maxSpreadCents: number,
  placement: "top" | "behind"
): Quote | null {
  const lo = mid - maxSpreadCents / 100;
  const hi = mid + maxSpreadCents / 100;
  let bid = placement === "top" ? bestBid : bestBid - 0.01;
  let ask = placement === "top" ? bestAsk : bestAsk + 0.01;
  bid = Math.round(Math.max(bid, Math.ceil(lo * 100) / 100) * 100) / 100;
  ask = Math.round(Math.min(ask, Math.floor(hi * 100) / 100) * 100) / 100;
  if (!(bid > 0 && ask < 1 && bid < ask)) return null;
  return { bid, ask };
}

export interface MarketYield {
  conditionId: string;
  question: string;
  slug?: string;
  dailyRate: number;
  minSize: number;
  maxSpread: number;
  mid: number;
  existingQ: number;
  ourQ: number;
  share: number;
  dailyReward: number;
  capital: number;
  annualYield: number;
  quote: Quote;
}

export function priceMarket(args: {
  conditionId: string;
  question: string;
  slug?: string;
  dailyRate: number;
  minSize: number;
  maxSpread: number;
  yesBook?: OrderBook;
  noBook?: OrderBook;
  shares: number;
  placement: "top" | "behind";
}): MarketYield | null {
  const yb = orders(args.yesBook, "bids");
  const ya = orders(args.yesBook, "asks");
  const nb = orders(args.noBook, "bids");
  const na = orders(args.noBook, "asks");
  const mid = midpoint(yb, ya);
  if (mid === null) return null;
  const q1 = sideQ(yb, na, mid, args.maxSpread, args.minSize);
  const q2 = sideQ(ya, nb, mid, args.maxSpread, args.minSize);
  const existingQ = qMin(q1, q2, mid);
  const quote = placeQuote(mid, Math.max(...yb.map((o) => o.price)), Math.min(...ya.map((o) => o.price)), args.maxSpread, args.placement);
  if (!quote) return null;
  const shares = Math.max(args.shares, args.minSize);
  const ourQ1 = orderScore((mid - quote.bid) * 100, args.maxSpread) * shares;
  const ourQ2 = orderScore((quote.ask - mid) * 100, args.maxSpread) * shares;
  const ourQ = qMin(ourQ1, ourQ2, mid);
  if (ourQ <= 0) return null;
  const share = ourQ / (ourQ + existingQ);
  const dailyReward = args.dailyRate * share;
  const capital = shares * quote.bid + shares * (1 - quote.ask);
  return {
    conditionId: args.conditionId,
    question: args.question,
    slug: args.slug,
    dailyRate: args.dailyRate,
    minSize: args.minSize,
    maxSpread: args.maxSpread,
    mid,
    existingQ,
    ourQ,
    share,
    dailyReward,
    capital,
    annualYield: (dailyReward * 365) / capital,
    quote,
  };
}

export interface SamplingMarket {
  condition_id: string;
  end_date_iso?: string | null;
  question?: string;
  market_slug?: string;
  closed?: boolean;
  active?: boolean;
  accepting_orders?: boolean;
  rewards?: { rates?: { rewards_daily_rate?: number }[] | null; min_size?: number; max_spread?: number } | null;
  tokens?: { token_id: string; outcome: string }[];
}

export async function samplingMarkets(): Promise<SamplingMarket[]> {
  const out: SamplingMarket[] = [];
  let cursor = "";
  for (let i = 0; i < 50; i++) {
    const res = (await fetchRaw(`${CLOB}/sampling-markets${cursor ? `?next_cursor=${cursor}` : ""}`)) as {
      data: SamplingMarket[];
      next_cursor?: string;
    };
    out.push(...res.data);
    if (!res.next_cursor || res.next_cursor === "LTE=" || res.data.length === 0) break;
    cursor = res.next_cursor;
  }
  return out;
}

export async function main() {
  const argv = process.argv.slice(2);
  const get = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
  const shares = Number(get("shares") ?? 0);
  const placement = (get("placement") ?? "top") as "top" | "behind";
  const top = Number(get("top") ?? 25);
  const out = get("out") ?? "data/rewards-scan/latest.json";
  const markets = (await samplingMarkets()).filter(
    (m) => m.active !== false && m.closed !== true && m.accepting_orders !== false && (m.tokens?.length ?? 0) === 2
  );
  const rated = markets
    .map((m) => ({ m, rate: (m.rewards?.rates ?? []).reduce((s, r) => s + (r.rewards_daily_rate ?? 0), 0) }))
    .filter((x) => x.rate > 0 && x.m.rewards?.max_spread);
  console.log(
    `${markets.length} open reward-program markets, ${rated.length} with a daily rate > 0; total pool $${rated.reduce((s, x) => s + x.rate, 0).toFixed(0)}/day`
  );
  const tokens = rated.flatMap((x) => x.m.tokens!.map((t) => t.token_id));
  const books = new Map((await getOrderBooks(tokens)).map((b) => [b.asset_id, b]));
  const priced: MarketYield[] = [];
  for (const { m, rate } of rated) {
    const [yes, no] = m.tokens!;
    const y = priceMarket({
      conditionId: m.condition_id,
      question: m.question ?? m.condition_id,
      slug: m.market_slug,
      dailyRate: rate,
      minSize: m.rewards?.min_size ?? 0,
      maxSpread: m.rewards!.max_spread!,
      yesBook: books.get(yes.token_id),
      noBook: books.get(no.token_id),
      shares,
      placement,
    });
    if (y) priced.push(y);
  }
  priced.sort((a, b) => b.annualYield - a.annualYield);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ts: Date.now(), shares, placement, priced }, null, 1));
  console.log(
    `\nplacement=${placement}, ${shares || "min-size"} shares/side. Top ${top} by annualized reward yield (upper bound; fills not modelled):`
  );
  for (const y of priced.slice(0, top)) {
    console.log(
      `  ${(y.annualYield * 100).toFixed(0).padStart(6)}%/yr  $${y.dailyReward.toFixed(2).padStart(6)}/day on $${y.capital.toFixed(0).padStart(5)}  ` +
        `share ${(y.share * 100).toFixed(1).padStart(5)}% of $${y.dailyRate}/day  mid ${y.mid.toFixed(3)} quote ${y.quote.bid}/${y.quote.ask}  ${y.question.slice(0, 55)}`
    );
  }
  // Portfolio view: best N markets at this sizing.
  for (const n of [5, 10, 25, 50]) {
    const sel = priced.slice(0, n);
    const cap = sel.reduce((s, y) => s + y.capital, 0);
    const day = sel.reduce((s, y) => s + y.dailyReward, 0);
    console.log(
      `  top ${String(n).padStart(2)}: $${day.toFixed(2)}/day on $${cap.toFixed(0)} capital = ${(((day * 365) / cap) * 100).toFixed(0)}%/yr (before fill losses)`
    );
  }
  console.log(`Summary: ${priced.length} markets priced; saved to ${out}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
