// Out-of-sample test of the early-movers channel itself (item 67,
// 2026-09-25). Items 62-64 nominated wallets for buying winners cheap and
// early, then confirmed them on a window that OVERLAPS the nomination --
// in-sample by construction. This splits time instead:
//
//   window A = [split - lookback, split): nominate from markets that closed
//              in A (same rules as source-early-movers), plus a CONTROL group
//              from the same markets -- wallets whose cheap early buys were
//              of an outcome that LOST;
//   window B = [split, now): score every nominee and control wallet only on
//              trades from `split` on (anchored pull; truncated pulls are
//              excluded and counted), none of which could inform nomination.
//
// Primary metric (pre-registered in IMPROVEMENT_PLAN.md item 67): the
// nominees' pooled window-B ROI with EQUAL WEIGHT per wallet (each wallet's
// trials scaled to total stake 1, so one whale can't carry the result) and
// an event-clustered bootstrap CI. Secondary: the same for the control group,
// the nominee-minus-control difference, and the fraction of wallets with
// ROI > 0.
//
// Usage: npm run early-movers-oos [-- --split=2026-05-28] [-- --lookbackDays=120]
//   [-- --markets=1500] [-- --perGroup=60] [-- --json=<path>]
//   [-- --controlMinEvents=3] [-- --pages=40]   (v2 knobs, item 68)

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getActivity } from "../api/client";
import { defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult } from "../backtesting/statistics";
import type { BacktestTrial } from "../domain/types";
import { runMigrations } from "../storage/migrate";
import { scoreWalletWithActivity } from "../scoring/walletScore";
import { aggregate, rankNominees, scanEarlyBuys, type Nominee } from "./sourceEarlyMovers";

const DEFAULT_HISTORY_PAGES = 40;

// Scale one wallet's resolved trials to total stake 1, so pooling across
// wallets weights each wallet equally.
export function equalWeight(trials: BacktestTrial[]): BacktestTrial[] {
  const total = trials.reduce((s, t) => s + t.usdcStaked, 0);
  if (total <= 0) return [];
  return trials.map((t) => ({ ...t, usdcStaked: t.usdcStaked / total, netReturn: t.netReturn / total }));
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}
function num(name: string, dflt: number): number {
  const v = Number(arg(name) ?? dflt);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be positive`);
  return v;
}

interface WalletResult {
  address: string;
  name: string | null;
  eventsA: number;
  status: "scored" | "truncated" | "no-trials" | "error";
  roi?: number;
  resolvedEvents?: number;
  net?: number;
  trials: BacktestTrial[];
}

async function scoreWindowB(n: Nominee, splitTs: number, historyPages: number): Promise<WalletResult> {
  const base = { address: n.address, name: n.name, eventsA: n.events.size, trials: [] as BacktestTrial[] };
  try {
    const latest = await getActivity(n.address, { limit: 1 });
    const latestTs = latest.length ? latest[0].timestamp : null;
    const { trials, activity } = await scoreWalletWithActivity({
      address: n.address,
      label: n.name ?? n.address,
      archetype: "unclassified",
      source: "early-movers-oos",
      historyPages,
      historyStart: splitTs,
    });
    const newest = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : null;
    if (latestTs !== null && latestTs >= splitTs && (newest === null || newest < latestTs)) return { ...base, status: "truncated" };
    const resolved = trials.filter((t) => t.resolved && t.entryTimestamp >= splitTs);
    if (resolved.length === 0) return { ...base, status: "no-trials" };
    const staked = resolved.reduce((s, t) => s + t.usdcStaked, 0);
    const net = resolved.reduce((s, t) => s + t.netReturn, 0);
    return {
      ...base,
      status: "scored",
      roi: net / staked,
      net,
      resolvedEvents: new Set(resolved.map((t) => t.eventKey)).size,
      trials: resolved,
    };
  } catch (err) {
    console.log(`    error scoring ${n.address}: ${(err as Error).message}`);
    return { ...base, status: "error" };
  }
}

function summarize(label: string, results: WalletResult[]) {
  const scored = results.filter((r) => r.status === "scored");
  const pooled = scored.flatMap((r) => equalWeight(r.trials));
  const res = pooled.length ? computeStrategyResult(pooled, defaultBacktestConfig()) : null;
  const positive = scored.filter((r) => (r.roi ?? 0) > 0).length;
  const counts = Object.fromEntries(
    ["scored", "truncated", "no-trials", "error"].map((k) => [k, results.filter((r) => r.status === k).length])
  );
  const ci = res?.roiBootstrapCI ?? null;
  console.log(
    `\n[${label}] wallets: ${JSON.stringify(counts)}\n` +
      `  equal-weight pooled window-B ROI ${res ? (res.roi * 100).toFixed(1) : "n/a"}%  ` +
      `95% CI ${ci ? `[${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]` : "n/a"}  ` +
      `independent events ${res?.distinctEvents ?? 0}  wallets with ROI > 0: ${positive}/${scored.length}`
  );
  return {
    label,
    counts,
    roi: res?.roi ?? null,
    ciLowerBound: ci?.[0] ?? null,
    ciUpperBound: ci?.[1] ?? null,
    events: res?.distinctEvents ?? 0,
    walletsPositive: positive,
    walletsScored: scored.length,
    wallets: results.map(({ trials: _t, ...r }) => r),
  };
}

async function main() {
  runMigrations();
  const split = arg("split") ?? "2026-05-28";
  const splitTs = Math.floor(Date.parse(`${split}T00:00:00Z`) / 1000);
  if (!Number.isFinite(splitTs)) throw new Error(`--split must be YYYY-MM-DD`);
  const lookbackDays = num("lookbackDays", 120);
  const marketCount = num("markets", 1500);
  const perGroup = num("perGroup", 60);
  // v2 knobs (item 68); defaults reproduce item 67 exactly.
  const controlMinEvents = num("controlMinEvents", 3);
  const historyPages = num("pages", DEFAULT_HISTORY_PAGES);
  const endDateMin = new Date((splitTs - lookbackDays * 86400) * 1000).toISOString().slice(0, 10);
  console.log(`early-movers OOS: window A ${endDateMin}..${split} (nominate), window B ${split}..now (score)`);

  const { marketsScanned, withMove, buys, losingBuys } = await scanEarlyBuys({
    endDateMin,
    endDateMax: split,
    marketCount,
    closedBeforeTs: splitTs,
  });
  const nominees = rankNominees(aggregate(buys), new Set()).slice(0, perGroup);
  const nomineeSet = new Set(nominees.map((n) => n.address.toLowerCase()));
  const controls = rankNominees(aggregate(losingBuys), nomineeSet, controlMinEvents).slice(0, perGroup);
  console.log(
    `\n${marketsScanned} markets scanned, ${withMove} with a move; ${nominees.length} nominees, ${controls.length} controls ` +
      `(nominees >= 3 events, controls >= ${controlMinEvents}; controls exclude nominees; ${historyPages}-page pulls)`
  );

  const score = async (group: Nominee[], label: string) => {
    const out: WalletResult[] = [];
    for (const [i, n] of group.entries()) {
      const r = await scoreWindowB(n, splitTs, historyPages);
      console.log(
        `  [${label} ${i + 1}/${group.length}] ${n.name ?? n.address}: ${r.status}` +
          (r.status === "scored" ? ` roi=${((r.roi ?? 0) * 100).toFixed(1)}% events=${r.resolvedEvents}` : "")
      );
      out.push(r);
    }
    return out;
  };
  const nomineeResults = await score(nominees, "nominee");
  const controlResults = await score(controls, "control");

  const nom = summarize("NOMINEES (primary)", nomineeResults);
  const ctl = summarize("CONTROL (early losing longshot buyers)", controlResults);
  const diff = nom.roi !== null && ctl.roi !== null ? nom.roi - ctl.roi : null;
  const pass = nom.ciLowerBound !== null && nom.ciLowerBound > 0;
  console.log(
    `\nSummary: nominees ROI ${nom.roi !== null ? (nom.roi * 100).toFixed(1) : "n/a"}% CI lower ${nom.ciLowerBound !== null ? (nom.ciLowerBound * 100).toFixed(1) : "n/a"}% ` +
      `vs control ${ctl.roi !== null ? (ctl.roi * 100).toFixed(1) : "n/a"}% (diff ${diff !== null ? (diff * 100).toFixed(1) : "n/a"}pp) -> ${pass ? "PASS" : "FAIL"} (pre-registered: nominee CI lower bound > 0)`
  );

  const jsonPath = arg("json") ?? path.join("data", "research-results", `early-movers-oos-${split}.json`);
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        split,
        lookbackDays,
        marketCount,
        perGroup,
        marketsScanned,
        withMove,
        nominees: nom,
        control: ctl,
        diff,
        pass,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log(`result written to ${jsonPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
