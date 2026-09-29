// Take-profit favorites (item 75, 2026-09-29). The user's idea: buy
// heavily-favoured outcomes (YES or NO, whichever side is favoured) over
// and over, and cash out small gains by SELLING when the price ticks up,
// instead of holding to resolution. Items 32-34/44/71 only tested the
// hold-to-resolution version (80-99c favourites: flat to negative after
// fees). Here each entry is walked along its real CLOB price path:
//   - take profit: sell at the first observed price >= entry + tp cents;
//   - optional stop: sell at the first observed price <= entry - stop;
//   - otherwise hold to resolution ($1 or $0).
// Prior: if prices are fair (a martingale), a take-profit rule only
// reshapes the payoff -- many small wins, rare large losses -- without
// changing its mean, and every round trip pays the spread and taker fee
// twice. So this can only win if favourites drift up after entry.
//
// Reuses item 71's calibration-scan pulls (no API calls): each market's
// Yes-price series at 10-minute fidelity from endDate-24h (minus
// staleness) to min(closedTime, endDate+3h). After the series ends the
// position is held to resolution. Entries at -24h/-6h vs endDate.
// Costs per side: slippage (buy at p*(1+s), sell at p*(1-s)) and the
// taker fee rate*p*(1-p) per share, rate per tag (calibrationScan.ts).
//
// Usage: npm run take-profit-scan -- --cache=data/calibration-scan/pull-discovery.json
//   [--slippageBps=100] [--sensitivityBps=300] [--json=...]

import { readFileSync } from "node:fs";
import { defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../backtesting/statistics";
import type { BacktestTrial, StrategyResult } from "../domain/types";
import { priceAt, settledWinnerIndex, type PricePoint } from "./weatherFavorites";
import { scorableMarkets, snapshotTs, TAG_FEE_RATES, type ScanEvent } from "./calibrationScan";
import {
  countComparisons,
  describeComparisons,
  multipleComparisonReport,
  type ComparisonCandidate,
  type ComparisonDimension,
} from "./comparisons";
import { parseBpsList, resultRow, spanOf, writeResearchResult, type ResultRow } from "./researchResult";
import type { RowKeySpace } from "./preregistration";

export const BANDS = [
  { label: "70-80", min: 0.7, max: 0.8 },
  { label: "80-90", min: 0.8, max: 0.9 },
  { label: "90-95", min: 0.9, max: 0.95 },
  { label: "95-99", min: 0.95, max: 0.99 },
];
export const ENTRIES = [-24, -6];
// Take-profit in cents; 0 = no take-profit (hold to resolution).
export const TPS = [0, 1, 2, 3, 5];
// Stop in cents; 0 = no stop.
export const STOPS = [0, 10];
const MIN_VOLUME = 5000;
const MAX_STALE_SECONDS = 3600;

export interface Rule {
  tpCents: number;
  stopCents: number;
}

// Walk one position along the favoured side's price path. Returns the
// exit price (quoted) and whether it exited before resolution.
export function simulateExit(
  path: PricePoint[], // favoured-side prices strictly after entry, ascending t
  entry: number,
  won: boolean,
  rule: Rule
): { exitQuote: number; early: boolean; target?: number } {
  const target = entry + rule.tpCents / 100;
  for (const pt of path) {
    if (rule.tpCents > 0 && pt.p >= target - 1e-9) return { exitQuote: pt.p, early: true, target };
    if (rule.stopCents > 0 && pt.p <= entry - rule.stopCents / 100 + 1e-9) return { exitQuote: pt.p, early: true };
  }
  return { exitQuote: won ? 1 : 0, early: false };
}

// Net return on $1: buy at entry*(1+s) paying rate*(1-p) of the stake,
// sell early at exit*(1-s) paying rate*p*(1-p) per share, or redeem at
// $1/$0 (no fee on redemption).
// makerExit: the take-profit is a resting limit sell (0 maker fee, no
// spread crossed) that fills at exactly the target -- an optimistic upper
// bound (queue position and partial fills ignored). Stops stay taker.
export function roundTripReturn(
  entryQuote: number,
  exit: { exitQuote: number; early: boolean; target?: number },
  feeRate: number,
  slippageBps: number,
  makerExit = false
): number {
  const s = slippageBps / 10_000;
  const pIn = Math.min(0.999, entryQuote * (1 + s));
  const shares = (1 - feeRate * (1 - pIn)) / pIn;
  if (!exit.early) return shares * exit.exitQuote - 1;
  if (makerExit && exit.target !== undefined) return shares * exit.target - 1;
  const pOut = Math.max(0.001, exit.exitQuote * (1 - s));
  return shares * (pOut - feeRate * pOut * (1 - pOut)) - 1;
}

export function trialsFor(
  events: ScanEvent[],
  picked: Record<string, string[]>,
  histories: Map<string, PricePoint[]>,
  entryOffset: number,
  rule: Rule,
  slippageBps: number,
  makerExit = false
): BacktestTrial[] {
  const out: BacktestTrial[] = [];
  for (const event of events) {
    const ids = new Set(picked[event.slug] ?? []);
    for (const m of scorableMarkets(event, MIN_VOLUME)) {
      if (!ids.has(m.conditionId)) continue;
      const series = histories.get(JSON.parse(m.clobTokenIds!)[0]);
      if (!series) continue;
      const ts = snapshotTs(m, event.endDate, entryOffset);
      if (ts === null) continue;
      const yes = priceAt(series, ts, MAX_STALE_SECONDS);
      if (yes === null) continue;
      const favIdx: 0 | 1 = yes >= 0.5 ? 0 : 1;
      const entry = favIdx === 0 ? yes : 1 - yes;
      if (!BANDS.some((b) => entry >= b.min && entry < b.max)) continue;
      const won = settledWinnerIndex(m) === favIdx;
      const path = series.filter((pt) => pt.t > ts).map((pt) => ({ t: pt.t, p: favIdx === 0 ? pt.p : 1 - pt.p }));
      const exit = simulateExit(path, entry, won, rule);
      const net = roundTripReturn(entry, exit, TAG_FEE_RATES[event.tag] ?? 0.05, slippageBps, makerExit);
      out.push({
        walletAddress: "take-profit-scan",
        conditionId: m.conditionId,
        outcome: JSON.parse(m.outcomes!)[favIdx],
        eventKey: event.slug,
        category: event.tag,
        entryTimestamp: ts,
        entryPrice: entry,
        usdcStaked: 1,
        shares: net + 1, // gross proceeds per $1, so ROI math stays exact
        resolved: true,
        won: net > 0,
        netReturn: net,
      });
    }
  }
  return out;
}

export interface Args {
  cache: string;
  slippageBps: number;
  sensitivityBps: number[];
  json: string | null;
  makerExit: boolean;
}
export function parseArgs(argv: string[]): Args {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const cache = get("cache");
  if (!cache) throw new Error("--cache=<calibration-scan pull file> is required");
  const slip = Number(get("slippageBps") ?? 100);
  if (!Number.isFinite(slip) || slip < 0) throw new Error(`--slippageBps must be >= 0`);
  return {
    cache,
    slippageBps: slip,
    sensitivityBps: parseBpsList(get("sensitivityBps") ?? "300", "sensitivityBps"),
    json: get("json") ?? null,
    makerExit: argv.includes("--makerExit"),
  };
}

export function resultKeySpace(args: Args): RowKeySpace {
  return {
    band: BANDS.map((b) => b.label),
    entry: ENTRIES,
    tp: TPS,
    stop: STOPS,
    slippageBps: [...new Set([args.slippageBps, ...args.sensitivityBps])],
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function line(label: string, trials: BacktestTrial[], r: StrategyResult): string {
  const worst = Math.min(...trials.map((t) => t.netReturn ?? 0));
  const ci = r.roiBootstrapCI ? `[${pct(r.roiBootstrapCI[0])}, ${pct(r.roiBootstrapCI[1])}]` : "n/a";
  return (
    `  ${label.padEnd(22)} n=${String(r.trialCount).padStart(4)} ev=${String(r.distinctEvents).padStart(4)} ` +
    `win=${pct(r.winRate)} roi=${pct(r.roi)} CI ${ci} worst=${pct(worst)}` +
    (r.distinctEvents < MIN_SAMPLE_SIZE ? " [provisional]" : "")
  );
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`take-profit-scan: ${JSON.stringify(args)}`);
  const data = JSON.parse(readFileSync(args.cache, "utf8")) as {
    events: ScanEvent[];
    picked: Record<string, string[]>;
    histories: Record<string, PricePoint[]>;
  };
  const histories = new Map(Object.entries(data.histories));
  console.log(`Loaded ${data.events.length} events, ${histories.size} price histories from ${args.cache}`);
  const config = defaultBacktestConfig({
    strategyName: "take-profit-scan",
    strategyVersion: "1.0.0",
    entryRule: "buy the favoured side at a fixed snapshot vs endDate; sell at +tp cents / -stop cents, else hold to resolution",
    slippageBps: args.slippageBps,
  });
  const candidates: ComparisonCandidate[] = [];
  const rows: ResultRow[] = [];
  for (const entry of ENTRIES) {
    console.log(
      `\n=== entry ${entry}h vs endDate (slippage ${args.slippageBps}bps per side, ${args.makerExit ? "take-profit exits as maker (no fee, no slippage)" : "taker fee both sides"}) ===`
    );
    for (const stop of STOPS) {
      for (const tp of TPS) {
        const rule = { tpCents: tp, stopCents: stop };
        const all = trialsFor(data.events, data.picked, histories, entry, rule, args.slippageBps, args.makerExit);
        for (const b of BANDS) {
          const inB = all.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max);
          if (inB.length === 0) continue;
          const r = computeStrategyResult(inB, config);
          const label = `${b.label} tp=${tp || "hold"} stop=${stop || "none"}`;
          candidates.push({ label: `${label} @${entry}h`, result: r, trials: inB });
          console.log(line(label, inB, r));
        }
        if (args.json) {
          for (const slippageBps of new Set([args.slippageBps, ...args.sensitivityBps])) {
            const costed =
              slippageBps === args.slippageBps
                ? all
                : trialsFor(data.events, data.picked, histories, entry, rule, slippageBps, args.makerExit);
            for (const b of BANDS) {
              const inB = costed.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max);
              if (inB.length === 0) continue;
              rows.push(resultRow({ band: b.label, entry, tp, stop, slippageBps }, computeStrategyResult(inB, config)));
            }
          }
        }
      }
    }
  }
  const dims: ComparisonDimension[] = [
    { name: "bands", count: BANDS.length },
    { name: "entries", count: ENTRIES.length },
    { name: "take-profits", count: TPS.length },
    { name: "stops", count: STOPS.length },
  ];
  console.log("");
  for (const l of multipleComparisonReport(dims, candidates)) console.log(l);
  if (args.json) {
    writeResearchResult(args.json, {
      script: "take-profit-scan",
      argv: process.argv.slice(2),
      args: { ...args },
      requestedWindow: null,
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
