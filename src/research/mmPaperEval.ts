// Paper market-making evaluator (item 76, 2026-09-29). Replays the real
// Polymarket trade tape against hypothetical resting bids placed from
// `npm run odds-snapshot`'s Pinnacle fair values, then holds every filled
// share to resolution. The question: do bids below Pinnacle fair value get
// filled by uninformed takers often enough to beat the adverse selection
// (fills that happen because the line moved against us)?
//
// Per snapshot of a game, each side gets one quoting session from the
// snapshot until the next snapshot of that game or kickoff (quotes are
// pulled at kickoff -- no in-play). The bid is min(fair - margin, the
// snapshot's ask - 1c), floored to a 1c tick, for --shares shares.
//   - fill=through (primary, conservative): only trades on our token
//     printed strictly BELOW our bid count -- someone sold through our
//     price, so a bid resting there was certainly hit first;
//   - fill=touch (optimistic bound): trades AT or below the bid count
//     (ignores queue position at our level).
// Filled shares settle at $1/$0; maker fee is 0 and the maker rebate is
// ignored (conservative). Trials cluster by game (event slug).
//
// Only sessions whose market has resolved are scored; the rest wait.
// Usage: npm run mm-paper-eval -- [--in=data/mm-paper/snapshots.jsonl]
//   [--shares=100] [--json=...]

import { readFileSync, existsSync } from "node:fs";
import { fetchRaw, getMarketTrades } from "../api/client";
import type { MarketTrade } from "../api/schemas";
import { defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../backtesting/statistics";
import type { BacktestTrial } from "../domain/types";
import type { SnapshotRow, Side } from "./oddsSnapshot";
import { resultRow, spanOf, writeResearchResult, type ResultRow } from "./researchResult";
import type { RowKeySpace } from "./preregistration";

export const MARGINS = [1, 2, 3, 4]; // cents below fair
export const FILLS = ["through", "touch"] as const;
export type FillRule = (typeof FILLS)[number];

export function bidPrice(side: Pick<Side, "fair" | "pmAsk">, marginCents: number): number | null {
  let bid = side.fair - marginCents / 100;
  if (side.pmAsk !== null) bid = Math.min(bid, side.pmAsk - 0.01);
  bid = Math.floor(bid * 100 + 1e-9) / 100;
  return bid >= 0.01 && bid <= 0.99 ? bid : null;
}

// The tape in OUR token's price terms. A trade on the other token of the
// same market at q is equivalent to one on ours at 1-q: a taker buying
// the complement at q > 1-bid would have matched our bid (the CLOB mints a
// pair) before paying up, so it counts as trading through our price.
export function asOurPrices(trades: Pick<MarketTrade, "asset" | "price" | "size">[], tokenId: string): { price: number; size: number }[] {
  return trades.map((t) => ({ price: t.asset === tokenId ? t.price : 1 - t.price, size: t.size }));
}

// Shares filled for a resting bid of `shares` at `bid`, given the tape
// (trades on OUR token only, inside the session window).
export function filledShares(trades: Pick<MarketTrade, "price" | "size">[], bid: number, shares: number, rule: FillRule): number {
  let filled = 0;
  for (const t of trades) {
    const hit = rule === "through" ? t.price < bid - 1e-9 : t.price <= bid + 1e-9;
    if (!hit) continue;
    filled += t.size;
    if (filled >= shares) return shares;
  }
  return filled;
}

export interface Session {
  eventSlug: string;
  side: Side;
  start: number;
  end: number;
}

// Sessions per game: snapshot i quotes until snapshot i+1 or kickoff.
export function sessions(rows: SnapshotRow[]): Session[] {
  const byGame = new Map<string, SnapshotRow[]>();
  for (const r of rows) byGame.set(r.eventSlug, [...(byGame.get(r.eventSlug) ?? []), r]);
  const out: Session[] = [];
  for (const [slug, snaps] of byGame) {
    snaps.sort((a, b) => a.ts - b.ts);
    const kickoff = Math.floor(Date.parse(snaps[snaps.length - 1].commenceTime) / 1000);
    snaps.forEach((s, i) => {
      const end = Math.min(i + 1 < snaps.length ? snaps[i + 1].ts : Infinity, kickoff);
      if (end <= s.ts) return;
      for (const side of s.sides) out.push({ eventSlug: slug, side, start: s.ts, end });
    });
  }
  return out;
}

// Winning token per resolved market (null = unresolved or voided).
async function winners(conditionIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < conditionIds.length; i += 50) {
    const qs = conditionIds
      .slice(i, i + 50)
      .map((c) => `condition_ids=${c}`)
      .join("&");
    const markets = (await fetchRaw(`https://gamma-api.polymarket.com/markets?${qs}&closed=true&limit=100`)) as {
      conditionId: string;
      closed?: boolean;
      outcomePrices?: string;
      clobTokenIds?: string;
    }[];
    for (const m of markets) {
      const p: number[] = JSON.parse(m.outcomePrices ?? "[]").map(Number);
      const toks: string[] = JSON.parse(m.clobTokenIds ?? "[]");
      const idx = p.findIndex((x) => x >= 0.99);
      out.set(m.conditionId, m.closed && idx >= 0 && p.every((x, j) => j === idx || x <= 0.01) ? toks[idx] : null);
    }
  }
  return out;
}

async function tape(conditionId: string, start: number, end: number): Promise<MarketTrade[]> {
  const out: MarketTrade[] = [];
  for (let offset = 0; offset < 10_000; offset += 500) {
    let page: MarketTrade[];
    try {
      page = await getMarketTrades(conditionId, { start, end, limit: 500, offset });
    } catch (err) {
      console.error(`  trades ${conditionId.slice(0, 10)}: stopped at offset ${offset}: ${(err as Error).message}`);
      break;
    }
    out.push(...page);
    if (page.length < 500) break;
  }
  return out.filter((t) => t.timestamp >= start && t.timestamp < end);
}

export interface Args {
  in: string;
  shares: number;
  json: string | null;
}
export function parseArgs(argv: string[]): Args {
  const get = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
  const shares = Number(get("shares") ?? 100);
  if (!(shares > 0)) throw new Error("--shares must be > 0");
  return { in: get("in") ?? "data/mm-paper/snapshots.jsonl", shares, json: get("json") ?? null };
}

export function resultKeySpace(): RowKeySpace {
  return { margin: MARGINS, fill: [...FILLS] };
}

export async function main() {
  const argv = process.argv.slice(2);
  const { in: file, shares, json } = parseArgs(argv);
  if (!existsSync(file)) throw new Error(`no snapshots at ${file} -- run npm run odds-snapshot first`);
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SnapshotRow);
  const now = Math.floor(Date.now() / 1000);
  const all = sessions(rows).filter((s) => s.end < now);
  const win = await winners([...new Set(all.map((s) => s.side.conditionId))]);
  const scored = all.filter((s) => win.get(s.side.conditionId));
  console.log(
    `${rows.length} snapshot rows, ${sessions(rows).length} quoting sessions; ${all.length} past kickoff, ${scored.length} on resolved markets`
  );
  const tapes = new Map<string, MarketTrade[]>();
  const trialsBy = new Map<string, BacktestTrial[]>();
  const quoted = new Map<string, number>();
  for (const s of scored) {
    const k = `${s.side.conditionId}|${s.start}|${s.end}`;
    if (!tapes.has(k)) tapes.set(k, await tape(s.side.conditionId, s.start, s.end));
    const ours = asOurPrices(tapes.get(k)!, s.side.tokenId);
    const won = win.get(s.side.conditionId) === s.side.tokenId;
    for (const margin of MARGINS) {
      const bid = bidPrice(s.side, margin);
      if (bid === null) continue;
      for (const fill of FILLS) {
        const key = `${margin}|${fill}`;
        quoted.set(key, (quoted.get(key) ?? 0) + 1);
        const f = filledShares(ours, bid, shares, fill);
        if (f <= 0) continue;
        const cost = f * bid;
        trialsBy.set(key, [
          ...(trialsBy.get(key) ?? []),
          {
            walletAddress: "mm-paper",
            conditionId: s.side.conditionId,
            outcome: s.side.label,
            eventKey: s.eventSlug,
            category: s.eventSlug.split("-")[0],
            entryTimestamp: s.start,
            entryPrice: bid,
            usdcStaked: cost,
            shares: f,
            resolved: true,
            won,
            netReturn: won ? f - cost : -cost,
          },
        ]);
      }
    }
  }
  const config = defaultBacktestConfig({
    strategyName: "mm-paper",
    strategyVersion: "1.0.0",
    entryRule: "resting bid at Pinnacle fair - margin (<= ask - 1c), pulled at kickoff; hold fills to resolution",
  });
  const out: ResultRow[] = [];
  console.log(`\nfill=through: trades strictly below our bid; fill=touch: at or below (optimistic). ${shares} shares per quote.`);
  for (const fill of FILLS) {
    for (const margin of MARGINS) {
      const key = `${margin}|${fill}`;
      const t = trialsBy.get(key) ?? [];
      const q = quoted.get(key) ?? 0;
      if (t.length === 0) {
        console.log(`  margin ${margin}c ${fill.padEnd(7)} quotes=${q} fills=0`);
        continue;
      }
      const r = computeStrategyResult(t, config);
      const ci = r.roiBootstrapCI ? `[${(r.roiBootstrapCI[0] * 100).toFixed(1)}%, ${(r.roiBootstrapCI[1] * 100).toFixed(1)}%]` : "n/a";
      const avgEdge = t.reduce((s, x) => s + x.entryPrice, 0) / t.length;
      console.log(
        `  margin ${margin}c ${fill.padEnd(7)} quotes=${q} filled=${t.length} (${((t.length / q) * 100).toFixed(0)}%) games=${r.distinctEvents} ` +
          `avgBid=${(avgEdge * 100).toFixed(1)}c win=${(r.winRate * 100).toFixed(1)}% pnl=$${r.netPnl.toFixed(2)} roi=${(r.roi * 100).toFixed(1)}% CI ${ci}` +
          (r.distinctEvents < MIN_SAMPLE_SIZE ? " [provisional]" : "")
      );
      out.push(resultRow({ margin, fill }, r));
    }
  }
  if (json) {
    writeResearchResult(json, {
      script: "mm-paper-eval",
      argv,
      args: { in: file, shares },
      requestedWindow: null,
      observedWindow: spanOf(scored.map((s) => new Date(s.start * 1000).toISOString().slice(0, 10))),
      comparisons: { k: MARGINS.length * FILLS.length, description: `${MARGINS.length} margins x ${FILLS.length} fill rules` },
      rows: out,
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
