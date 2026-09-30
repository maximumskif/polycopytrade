// Paper liquidity-rewards maker (item 77, 2026-09-29). rewards-scan says
// many rewarded markets are thinly quoted, so a min-size two-sided quote
// would take a large share of their daily pool. The catch is adverse
// selection: whoever rests near the mid gets filled by traders who know
// more (a temperature reading, a leaderboard update). This measures both
// sides of that trade-off forward in time, without placing orders:
//   collect: every --intervalMin, for a basket of competitive rewarded
//     markets resolving within --horizonDays, re-quote from the live book
//     (placement top and behind, min size) and credit the formula share of
//     the pool for the interval (rewardsScan.ts's scoring, documented
//     formula). Basket refreshed hourly.
//   eval: once markets resolve, replay the trade tape between samples:
//     a YES trade below our bid fills our bid (we bought YES at the bid); a
//     YES trade above our ask fills our ask (we sold YES = bought NO at
//     1-ask); fills capped at our size per interval and held to
//     resolution. Net = rewards credited - fill losses (+ fill gains).
// Caveats (all read in the write-up): existing makers are aggregated, so
// our share is an upper bound; a real bot re-quotes faster than 5 min
// (fewer stale fills) but also waits in the queue (fewer fills at all);
// actual payouts can't be checked without an account.
//
// Usage: npm run rewards-paper -- collect [--durationMin=0(=forever)] [--intervalMin=5]
//          [--horizonDays=3] [--minRate=20] [--maxMarkets=40] [--out=data/rewards-paper/samples.jsonl]
//        npm run rewards-paper -- eval [--out=...] [--json=...]

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchRaw, getMarketTrades, getOrderBooks } from "../api/client";
import type { MarketTrade } from "../api/schemas";
import { priceMarket, samplingMarkets, type SamplingMarket } from "./rewardsScan";

export const PLACEMENTS = ["top", "behind"] as const;
type Placement = (typeof PLACEMENTS)[number];

export interface Sample {
  ts: number;
  intervalSec: number;
  conditionId: string;
  question: string;
  endDate: string | null;
  yesToken: string;
  noToken: string;
  dailyRate: number;
  mid: number;
  shares: number;
  quotes: Record<Placement, { bid: number; ask: number; share: number; reward: number } | null>;
}

interface Pick {
  m: SamplingMarket;
  rate: number;
}

async function pickBasket(horizonDays: number, minRate: number, maxMarkets: number): Promise<Pick[]> {
  const now = Date.now();
  const markets = (await samplingMarkets()).filter((m) => {
    if (m.closed || m.accepting_orders === false || (m.tokens?.length ?? 0) !== 2) return false;
    const end = m.end_date_iso ? Date.parse(m.end_date_iso) : NaN;
    return Number.isFinite(end) && end > now && end - now <= horizonDays * 86400_000;
  });
  const rated = markets
    .map((m) => ({ m, rate: (m.rewards?.rates ?? []).reduce((s, r) => s + (r.rewards_daily_rate ?? 0), 0) }))
    .filter((x) => x.rate >= minRate && x.m.rewards?.max_spread);
  // Price once and keep only markets that already have competition and a
  // sane mid: empty books are the "whoever quotes first gets picked off"
  // trap rewards-scan surfaced.
  const books = new Map((await getOrderBooks(rated.flatMap((x) => x.m.tokens!.map((t) => t.token_id)))).map((b) => [b.asset_id, b]));
  const scored = rated
    .map((x) => {
      const y = priceMarket({
        conditionId: x.m.condition_id,
        question: x.m.question ?? "",
        dailyRate: x.rate,
        minSize: x.m.rewards?.min_size ?? 0,
        maxSpread: x.m.rewards!.max_spread!,
        yesBook: books.get(x.m.tokens![0].token_id),
        noBook: books.get(x.m.tokens![1].token_id),
        shares: 0,
        placement: "top",
      });
      return { ...x, y };
    })
    .filter((x) => x.y && x.y.existingQ > 0 && x.y.share < 0.5 && x.y.mid >= 0.1 && x.y.mid <= 0.9);
  scored.sort((a, b) => b.y!.dailyReward - a.y!.dailyReward);
  return scored.slice(0, maxMarkets).map(({ m, rate }) => ({ m, rate }));
}

async function collect(opts: {
  durationMin: number;
  intervalMin: number;
  horizonDays: number;
  minRate: number;
  maxMarkets: number;
  out: string;
}) {
  mkdirSync(dirname(opts.out), { recursive: true });
  const endAt = opts.durationMin > 0 ? Date.now() + opts.durationMin * 60_000 : Infinity;
  let basket: Pick[] = [];
  let pickedAt = 0;
  for (;;) {
    const t0 = Date.now();
    try {
      if (t0 - pickedAt > 3600_000) {
        basket = await pickBasket(opts.horizonDays, opts.minRate, opts.maxMarkets);
        pickedAt = Date.now();
        console.log(`  basket: ${basket.length} markets (pools $${basket.reduce((s, b) => s + b.rate, 0)}/day)`);
      }
      const books = new Map((await getOrderBooks(basket.flatMap((b) => b.m.tokens!.map((t) => t.token_id)))).map((b) => [b.asset_id, b]));
      const ts = Math.floor(Date.now() / 1000);
      let credited = 0;
      for (const { m, rate } of basket) {
        const [yes, no] = m.tokens!;
        const quotes = {} as Sample["quotes"];
        let mid = NaN;
        let shares = 0;
        for (const placement of PLACEMENTS) {
          const y = priceMarket({
            conditionId: m.condition_id,
            question: m.question ?? "",
            dailyRate: rate,
            minSize: m.rewards?.min_size ?? 0,
            maxSpread: m.rewards!.max_spread!,
            yesBook: books.get(yes.token_id),
            noBook: books.get(no.token_id),
            shares: 0,
            placement,
          });
          if (!y) {
            quotes[placement] = null;
            continue;
          }
          mid = y.mid;
          shares = Math.max(y.minSize, 1);
          const reward = y.dailyReward * ((opts.intervalMin * 60) / 86400);
          quotes[placement] = { bid: y.quote.bid, ask: y.quote.ask, share: y.share, reward };
          if (placement === "top") credited += reward;
        }
        const sample: Sample = {
          ts,
          intervalSec: opts.intervalMin * 60,
          conditionId: m.condition_id,
          question: m.question ?? "",
          endDate: m.end_date_iso ?? null,
          yesToken: yes.token_id,
          noToken: no.token_id,
          dailyRate: rate,
          mid,
          shares,
          quotes,
        };
        appendFileSync(opts.out, JSON.stringify(sample) + "\n");
      }
      console.log(`  ${new Date().toISOString()}: ${basket.length} markets sampled, $${credited.toFixed(2)} credited (top)`);
    } catch (err) {
      console.error(`  sample failed: ${(err as Error).message}`);
    }
    if (Date.now() + opts.intervalMin * 60_000 > endAt) break;
    await new Promise((r) => setTimeout(r, Math.max(0, opts.intervalMin * 60_000 - (Date.now() - t0))));
  }
}

// Shares filled in one interval for one quote, from YES-terms trades.
export function intervalFills(
  trades: { price: number; size: number }[],
  quote: { bid: number; ask: number },
  shares: number
): { boughtYes: number; boughtNo: number } {
  let boughtYes = 0;
  let boughtNo = 0;
  for (const t of trades) {
    if (t.price < quote.bid - 1e-9) boughtYes += t.size;
    else if (t.price > quote.ask + 1e-9) boughtNo += t.size;
  }
  return { boughtYes: Math.min(shares, boughtYes), boughtNo: Math.min(shares, boughtNo) };
}

// P&L at resolution of fills: YES bought at bid, NO bought at 1-ask.
export function fillPnl(f: { boughtYes: number; boughtNo: number }, quote: { bid: number; ask: number }, yesWon: boolean): number {
  const yes = f.boughtYes * ((yesWon ? 1 : 0) - quote.bid);
  const no = f.boughtNo * ((yesWon ? 0 : 1) - (1 - quote.ask));
  return yes + no;
}

async function resolvedYes(conditionIds: string[]): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  for (let i = 0; i < conditionIds.length; i += 50) {
    const qs = conditionIds
      .slice(i, i + 50)
      .map((c) => `condition_ids=${c}`)
      .join("&");
    const ms = (await fetchRaw(`https://gamma-api.polymarket.com/markets?${qs}&closed=true&limit=100`)) as {
      conditionId: string;
      closed?: boolean;
      outcomePrices?: string;
    }[];
    for (const m of ms) {
      const p: number[] = JSON.parse(m.outcomePrices ?? "[]").map(Number);
      out.set(m.conditionId, m.closed && p.length === 2 && (p[0] >= 0.99 || p[1] >= 0.99) ? p[0] >= 0.99 : null);
    }
  }
  return out;
}

async function tapeYesTerms(
  conditionId: string,
  yesToken: string,
  start: number,
  end: number
): Promise<(MarketTrade & { yesPrice: number })[]> {
  const out: (MarketTrade & { yesPrice: number })[] = [];
  for (let offset = 0; offset < 10_000; offset += 500) {
    const page = await getMarketTrades(conditionId, { start, end, limit: 500, offset });
    for (const t of page) out.push({ ...t, yesPrice: t.asset === yesToken ? t.price : 1 - t.price });
    if (page.length < 500) break;
  }
  return out;
}

async function evaluate(out: string) {
  if (!existsSync(out)) throw new Error(`no samples at ${out}`);
  const samples = readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Sample);
  const byMarket = new Map<string, Sample[]>();
  for (const s of samples) byMarket.set(s.conditionId, [...(byMarket.get(s.conditionId) ?? []), s]);
  const res = await resolvedYes([...byMarket.keys()]);
  const totals = Object.fromEntries(PLACEMENTS.map((p) => [p, { rewards: 0, fillPnl: 0, fills: 0, markets: 0, capitalDays: 0 }]));
  const perMarket: { q: string; rewards: number; pnl: number }[] = [];
  for (const [cid, ss] of byMarket) {
    const yesWon = res.get(cid);
    if (yesWon === undefined || yesWon === null) continue;
    ss.sort((a, b) => a.ts - b.ts);
    const tape = await tapeYesTerms(cid, ss[0].yesToken, ss[0].ts, ss[ss.length - 1].ts + ss[ss.length - 1].intervalSec);
    for (const p of PLACEMENTS) {
      let rewards = 0;
      let pnl = 0;
      let fills = 0;
      for (const s of ss) {
        const q = s.quotes[p];
        if (!q) continue;
        rewards += q.reward;
        const inInterval = tape
          .filter((t) => t.timestamp >= s.ts && t.timestamp < s.ts + s.intervalSec)
          .map((t) => ({ price: t.yesPrice, size: t.size }));
        const f = intervalFills(inInterval, q, s.shares);
        if (f.boughtYes + f.boughtNo > 0) fills++;
        pnl += fillPnl(f, q, yesWon);
        totals[p].capitalDays += (s.shares * q.bid + s.shares * (1 - q.ask)) * (s.intervalSec / 86400);
      }
      totals[p].rewards += rewards;
      totals[p].fillPnl += pnl;
      totals[p].fills += fills;
      totals[p].markets++;
      if (p === "top") perMarket.push({ q: ss[0].question, rewards, pnl });
    }
  }
  console.log(`${samples.length} samples over ${byMarket.size} markets; ${totals.top.markets} resolved and scored.`);
  for (const p of PLACEMENTS) {
    const t = totals[p];
    const net = t.rewards + t.fillPnl;
    console.log(
      `  ${p.padEnd(6)} rewards $${t.rewards.toFixed(2)}  fill P&L $${t.fillPnl.toFixed(2)}  NET $${net.toFixed(2)}  ` +
        `(fills in ${t.fills} intervals; avg capital ${t.capitalDays > 0 ? "$" + (t.capitalDays / Math.max(1, t.markets)).toFixed(0) + "-days/market" : "n/a"})`
    );
  }
  perMarket.sort((a, b) => a.rewards + a.pnl - (b.rewards + b.pnl));
  console.log("  worst / best markets (top placement):");
  for (const m of [...perMarket.slice(0, 3), ...perMarket.slice(-3)])
    console.log(
      `    net $${(m.rewards + m.pnl).toFixed(2)} (rewards $${m.rewards.toFixed(2)}, fills $${m.pnl.toFixed(2)}) ${m.q.slice(0, 60)}`
    );
  console.log(
    `Summary: ${totals.top.markets} resolved markets; top NET $${(totals.top.rewards + totals.top.fillPnl).toFixed(2)}, behind NET $${(totals.behind.rewards + totals.behind.fillPnl).toFixed(2)}`
  );
}

export async function main() {
  const argv = process.argv.slice(2);
  const get = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
  const out = get("out") ?? "data/rewards-paper/samples.jsonl";
  if (argv[0] === "eval") return evaluate(out);
  if (argv[0] !== "collect") throw new Error("usage: rewards-paper collect|eval [...]");
  await collect({
    durationMin: Number(get("durationMin") ?? 0),
    intervalMin: Number(get("intervalMin") ?? 5),
    horizonDays: Number(get("horizonDays") ?? 3),
    minRate: Number(get("minRate") ?? 20),
    maxMarkets: Number(get("maxMarkets") ?? 40),
    out,
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
