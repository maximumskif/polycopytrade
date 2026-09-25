// Wallet sourcing by TIMING, not size (item 62, 2026-09-25). Every earlier
// channel -- leaderboards (items 40-41) and current top holders (42, 46, 60)
// -- ranks wallets by how much they hold or made; across five categories it
// produced zero durable quality wallets. This asks a different question:
// who repeatedly bought a market's eventual winner while it was still cheap,
// well BEFORE the price moved?
//
//   1. Settled markets, biggest first, that closed in the last --days days.
//   2. Keep only markets with a real move: the winning outcome traded at
//      <= EARLY_MAX_PRICE at some point and first crossed MOVE_CROSS_PRICE at
//      least MIN_LEAD_HOURS before the market closed (so the move was price
//      discovery, not just the resolution print). CLOB price history of the
//      winning token, last HISTORY_DAYS before close -- cached by K1 once the
//      market is finalized.
//   3. The early window's taker BUY fills of the winner at <= EARLY_MAX_PRICE
//      and >= MIN_EARLY_USDC (data-api /trades, windowed by start/end).
//   4. Nominate wallets with early winning buys in >= MIN_EVENTS distinct
//      events (correlated markets of one event count once).
//
// Nomination only looks at winners, so it's biased by construction: anyone
// who buys lots of longshots will hit a few. That's why every nominee goes
// through the same screen + anchored confirmation as the other channels
// (walletConfirmation.ts), which scores ALL of the wallet's trades, losers
// included, and applies isQualityWallet (ROI > 0 since item 59).
//
// Usage: npm run source-early-movers [-- --days=45] [-- --markets=150] [-- --candidates=15]
//   [-- --rescore]   (skip the 14-day recently-confirmed dedupe)

import "dotenv/config";
import {
  getActivity,
  getClosedMarketsByVolume,
  getMarketTrades,
  getPricesHistory,
  type GammaMarket,
  type MarketTrade,
} from "../api/client";
import { isFinalizedMarket } from "../api/cachePolicy";
import { runMigrations } from "../storage/migrate";
import { isCertainlyDormant, scoreWalletShallow } from "../scoring/walletScore";
import { TRACKED_WALLETS, type TrackedWallet } from "../wallets";
import { recentlyConfirmedAddresses, RESCORE_AFTER_DAYS } from "./recentlyScored";
import { printVerdicts, screenAndConfirm, type PipelineOutcome, type ScoringAttempt } from "./walletConfirmation";

export const EARLY_MAX_PRICE = 0.35;
export const MOVE_CROSS_PRICE = 0.6;
export const MIN_LEAD_HOURS = 6;
export const MIN_EARLY_USDC = 50;
export const MIN_EVENTS = 3;
const HISTORY_DAYS = 30;
const MAX_CHUNK_SECONDS = 6 * 24 * 3600; // CLOB rejects spans past ~1 week (see volatilityBreakout.ts)
const PRICE_FIDELITY_MINUTES = 60;
const MAX_TRADE_PAGES = 8; // 500 fills each, per market
const DEFAULT_MAX_CANDIDATES = 15;
const SHALLOW_HISTORY_PAGES = 4;
const SOURCE = "source-early-movers";

// gamma closedTime is "2026-09-25 04:43:35+00", not ISO.
export function parseGammaTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// Index of the outcome that paid 1, for a finalized market only.
export function winnerIndex(market: Pick<GammaMarket, "closed" | "outcomePrices" | "umaResolutionStatus">): number | null {
  if (!isFinalizedMarket(market)) return null;
  const prices = (JSON.parse(market.outcomePrices ?? "[]") as (string | number)[]).map(Number);
  const idx = prices.indexOf(1);
  return idx >= 0 ? idx : null;
}

export interface Move {
  cheapSeen: boolean; // winner traded <= EARLY_MAX_PRICE before the cross
  crossTs: number; // first point >= MOVE_CROSS_PRICE
}

// The winner's first crossing of MOVE_CROSS_PRICE AFTER it traded at
// <= EARLY_MAX_PRICE (an early high that later collapsed and recovered is
// judged on the recovery), provided that crossing came >= MIN_LEAD_HOURS
// before close.
export function findMove(series: { t: number; p: number }[], closeTs: number): Move | null {
  let cheapSeen = false;
  for (const pt of [...series].sort((a, b) => a.t - b.t)) {
    if (pt.p <= EARLY_MAX_PRICE) cheapSeen = true;
    else if (cheapSeen && pt.p >= MOVE_CROSS_PRICE) {
      return closeTs - pt.t >= MIN_LEAD_HOURS * 3600 ? { cheapSeen, crossTs: pt.t } : null;
    }
  }
  return null;
}

export function earlyWinningBuys(trades: MarketTrade[], winner: number, crossTs: number): MarketTrade[] {
  return trades.filter(
    (t) =>
      t.side === "BUY" &&
      t.outcomeIndex === winner &&
      t.timestamp < crossTs &&
      t.price <= EARLY_MAX_PRICE &&
      t.size * t.price >= MIN_EARLY_USDC
  );
}

// Control group for item 67: the same cheap early BUYs, but of an outcome
// that LOST -- early longshot buyers the market proved wrong.
export function earlyLosingBuys(trades: MarketTrade[], winner: number, crossTs: number): MarketTrade[] {
  return trades.filter(
    (t) =>
      t.side === "BUY" &&
      t.outcomeIndex !== undefined &&
      t.outcomeIndex !== winner &&
      t.timestamp < crossTs &&
      t.price <= EARLY_MAX_PRICE &&
      t.size * t.price >= MIN_EARLY_USDC
  );
}

export interface Nominee {
  address: string;
  name: string | null;
  events: Set<string>;
  usdc: number;
  examples: string[];
}

export function aggregate(buys: { trade: MarketTrade; eventKey: string; question: string }[]): Map<string, Nominee> {
  const byWallet = new Map<string, Nominee>();
  for (const { trade, eventKey, question } of buys) {
    const addr = trade.proxyWallet.toLowerCase();
    let n = byWallet.get(addr);
    if (!n) {
      n = { address: trade.proxyWallet, name: trade.name || trade.pseudonym || null, events: new Set(), usdc: 0, examples: [] };
      byWallet.set(addr, n);
    }
    if (!n.events.has(eventKey) && n.examples.length < 3) n.examples.push(`${question} @${trade.price.toFixed(2)}`);
    n.events.add(eventKey);
    n.usdc += trade.size * trade.price;
  }
  return byWallet;
}

export function rankNominees(all: Map<string, Nominee>, skip: Set<string>): Nominee[] {
  return [...all.values()]
    .filter((n) => n.events.size >= MIN_EVENTS && !skip.has(n.address.toLowerCase()))
    .sort((a, b) => b.events.size - a.events.size || b.usdc - a.usdc);
}

function flag(name: string, dflt: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const v = raw === undefined ? dflt : Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number, got "${raw}"`);
  return v;
}

async function winnerSeries(market: GammaMarket, tokenId: string, closeTs: number): Promise<{ t: number; p: number }[]> {
  const series: { t: number; p: number }[] = [];
  for (let start = closeTs - HISTORY_DAYS * 86400; start < closeTs; start += MAX_CHUNK_SECONDS) {
    const res = await getPricesHistory(tokenId, start, Math.min(start + MAX_CHUNK_SECONDS, closeTs), PRICE_FIDELITY_MINUTES, { market });
    for (const pt of res.history ?? []) series.push(pt);
  }
  return series;
}

async function earlyTrades(conditionId: string, startTs: number, crossTs: number): Promise<MarketTrade[]> {
  const out: MarketTrade[] = [];
  for (let page = 0; page < MAX_TRADE_PAGES; page++) {
    const batch = await getMarketTrades(conditionId, { start: startTs, end: crossTs, offset: page * 500 });
    out.push(...batch);
    if (batch.length < 500) break;
  }
  return out;
}

// Steps 1-3 of the header, reusable with a closed-before cutoff so a
// nomination can be restricted to an earlier window (item 67's
// out-of-sample test of this channel). Only markets that actually closed
// (closedTime, else endDate) before `closedBeforeTs` are used.
export async function scanEarlyBuys(opts: {
  endDateMin: string;
  endDateMax?: string;
  marketCount: number;
  closedBeforeTs: number;
}): Promise<{
  marketsScanned: number;
  withMove: number;
  buys: { trade: MarketTrade; eventKey: string; question: string }[];
  losingBuys: { trade: MarketTrade; eventKey: string; question: string }[];
}> {
  const { endDateMin, endDateMax, marketCount, closedBeforeTs } = opts;
  const markets: GammaMarket[] = [];
  for (let offset = 0; markets.length < marketCount; offset += 100) {
    const page = await getClosedMarketsByVolume({ endDateMin, endDateMax, limit: 100, offset });
    markets.push(...page);
    if (page.length < 100) break;
  }
  const marketsScanned = Math.min(markets.length, marketCount);
  console.log(
    `${markets.length} settled markets (end date ${endDateMin}..${endDateMax ?? "now"}), biggest first; scanning ${marketsScanned}.`
  );

  const buys: { trade: MarketTrade; eventKey: string; question: string }[] = [];
  const losingBuys: { trade: MarketTrade; eventKey: string; question: string }[] = [];
  let withMove = 0;
  for (const market of markets.slice(0, marketCount)) {
    const winner = winnerIndex(market);
    const closeTs = parseGammaTime(market.closedTime) ?? parseGammaTime(market.endDate);
    const tokenId = (JSON.parse(market.clobTokenIds ?? "[]") as string[])[winner ?? -1];
    if (winner === null || closeTs === null || closeTs > closedBeforeTs || !tokenId) continue;
    try {
      const move = findMove(await winnerSeries(market, tokenId, closeTs), closeTs);
      if (!move) continue;
      withMove++;
      const trades = await earlyTrades(market.conditionId, closeTs - HISTORY_DAYS * 86400, move.crossTs);
      const early = earlyWinningBuys(trades, winner, move.crossTs);
      for (const trade of early) buys.push({ trade, eventKey: trade.eventSlug || trade.slug || market.slug, question: market.question });
      for (const trade of earlyLosingBuys(trades, winner, move.crossTs)) {
        losingBuys.push({ trade, eventKey: trade.eventSlug || trade.slug || market.slug, question: market.question });
      }
      console.log(
        `  [move] ${market.question.slice(0, 70)} -- crossed ${MOVE_CROSS_PRICE} ${((closeTs - move.crossTs) / 3600).toFixed(0)}h before close; ` +
          `${early.length} early winning buys (${trades.length} fills scanned)`
      );
    } catch (err) {
      console.log(`  [skip] ${market.question.slice(0, 70)}: ${(err as Error).message}`);
    }
  }
  return { marketsScanned, withMove, buys, losingBuys };
}

async function main() {
  runMigrations();
  const days = flag("days", 45);
  const marketCount = flag("markets", 150);
  const maxCandidates = flag("candidates", DEFAULT_MAX_CANDIDATES);
  const endDateMin = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  const nowSec = Math.floor(Date.now() / 1000);

  const { marketsScanned, withMove, buys } = await scanEarlyBuys({ endDateMin, marketCount, closedBeforeTs: nowSec });

  const tracked = new Set(TRACKED_WALLETS.map((w) => w.address.toLowerCase()));
  const skip = recentlyConfirmedAddresses();
  for (const a of tracked) skip.add(a);
  const all = aggregate(buys);
  const ranked = rankNominees(all, skip);
  console.log(
    `\n${withMove} markets with a qualifying move; ${buys.length} early winning buys by ${all.size} wallets; ` +
      `${ranked.length} with >= ${MIN_EVENTS} distinct events (excluding tracked + confirmed in the last ${RESCORE_AFTER_DAYS}d).`
  );

  const outcomes: PipelineOutcome[] = [];
  let dormant = 0;
  for (const n of ranked.slice(0, maxCandidates)) {
    const label = `${n.name ?? n.address} (early-mover sourced: early winning buys in ${n.events.size} events, $${n.usdc.toFixed(0)}; e.g. ${n.examples.join("; ")})`;
    const wallet: TrackedWallet = { address: n.address, label, archetype: "unclassified", source: `npm run ${SOURCE}` };
    const base = { address: n.address, label, provenance: wallet.source };
    console.log(`  scoring [${n.address}] ${n.name ?? "(no username)"} -- ${n.events.size} events, $${n.usdc.toFixed(0)}`);
    try {
      const latest = await getActivity(n.address, { limit: 1 });
      if (isCertainlyDormant(latest.length ? latest[0].timestamp : null)) {
        dormant++;
        console.log(`    -> dormant (no activity in 30d), skipped`);
        continue;
      }
      const { score, activity } = await scoreWalletShallow(wallet, SHALLOW_HISTORY_PAGES);
      const screen: ScoringAttempt = {
        method: "shallow",
        historyStart: null,
        historyPages: SHALLOW_HISTORY_PAGES,
        truncated: false,
        fills: activity.length,
        score,
      };
      console.log(
        `    -> shallow qualityScore=${score.qualityScore}/100  roi=${(score.roi * 100).toFixed(1)}%  flags=${score.flags.join(",") || "(none)"}`
      );
      const outcome = await screenAndConfirm(base, screen, { source: SOURCE, log: (line) => console.log(`  ${line}`) });
      outcomes.push(outcome);
      if (outcome.kind !== "screened-out") console.log(`      -> ${outcome.kind}${outcome.reason ? `: ${outcome.reason}` : ""}`);
    } catch (err) {
      console.log(`    -> scoring failed: ${(err as Error).message}`);
      outcomes.push({ ...base, kind: "error", reason: (err as Error).message });
    }
  }

  printVerdicts(outcomes);
  const count = (kind: PipelineOutcome["kind"]) => outcomes.filter((o) => o.kind === kind).length;
  console.log(
    `\nSummary: ${marketsScanned} settled markets -> ${withMove} with a move -> ${ranked.length} nominees -> ` +
      `${Math.min(ranked.length, maxCandidates)} scored (${dormant} dormant) -> ${count("confirmed-quality")} confirmed quality / ` +
      `${count("failed-confirmation")} failed confirmation / ${count("unconfirmed-truncated")} unconfirmed (truncated) / ` +
      `${count("screened-out")} screened out${count("error") ? ` / ${count("error")} errors` : ""}.`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
