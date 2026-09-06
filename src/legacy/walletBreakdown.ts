// Phase 1f: what is 0x_exit's wallet actually buying? walletBacktest.ts
// answers "would copying this wallet have made money" at the whole-wallet
// level (Phase 1e: yes, but only +7.1% net over its full 253-market
// history) — this answers "where does that +7.1% actually come from,"
// broken down by category and by entry price band, so a real selection
// rule can be judged instead of treating the wallet as a black box before
// deciding whether Phase 2 (paper trading) is worth doing.

// Historically-cited original (README Phase 1f) -- see backtestLadder.ts's
// header note; same "moved to src/legacy/, bug-fix only" status applies.

import { writeFileSync, mkdirSync } from "node:fs";
import { backtestWallet, summarize, type ResolvedTrial } from "./walletBacktest";
import { TRACKED_WALLETS } from "../wallets";

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function reportGroup(label: string, trials: ResolvedTrial[]) {
  if (trials.length === 0) return;
  const { totalStaked, totalReturned, wins, distinctMarkets } = summarize(trials);
  const net = (totalReturned - totalStaked) / totalStaked;
  console.log(
    `  ${label.padEnd(14)} ${String(trials.length).padStart(5)} fills  ${String(distinctMarkets).padStart(4)} markets  ` +
      `win ${pct(wins / trials.length).padStart(6)}  staked $${totalStaked.toFixed(0).padStart(8)}  net ${pct(net).padStart(7)}`
  );
}

const PRICE_BANDS: [number, number][] = [
  [0, 0.05],
  [0.05, 0.15],
  [0.15, 0.3],
  [0.3, 0.5],
  [0.5, 0.7],
  [0.7, 0.85],
  [0.85, 0.95],
  [0.95, 1.0],
];

async function main() {
  const filter = process.argv[2]?.toLowerCase() ?? "0x_exit";
  const wallet = TRACKED_WALLETS.find((w) => w.address.toLowerCase().includes(filter) || w.label.toLowerCase().includes(filter));
  if (!wallet) {
    console.error(`No tracked wallet matches "${filter}"`);
    process.exit(1);
  }

  const trials = await backtestWallet(wallet);

  console.log(`\nBy category:`);
  const categories = [...new Set(trials.map((t) => t.category))];
  for (const cat of categories) {
    reportGroup(
      cat,
      trials.filter((t) => t.category === cat)
    );
  }

  console.log(`\nBy entry price band:`);
  for (const [lo, hi] of PRICE_BANDS) {
    const inBand = trials.filter((t) => t.entryPrice >= lo && t.entryPrice < hi);
    reportGroup(`${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}c`, inBand);
  }

  console.log(`\nBy side (ladder rungs are phrased "(HIGH) $X" / "(LOW) $X"):`);
  const highTrials = trials.filter((t) => /\(HIGH\)/.test(t.question));
  const lowTrials = trials.filter((t) => /\(LOW\)/.test(t.question));
  const otherSide = trials.filter((t) => !/\(HIGH\)/.test(t.question) && !/\(LOW\)/.test(t.question));
  reportGroup("HIGH", highTrials);
  reportGroup("LOW", lowTrials);
  reportGroup("n/a", otherSide);

  console.log(`\nBy week (edge decay / concentration over the wallet's lifetime):`);
  const oldestTs = Math.min(...trials.map((t) => t.timestamp));
  const byWeek = new Map<number, ResolvedTrial[]>();
  for (const t of trials) {
    const week = Math.floor((t.timestamp - oldestTs) / (7 * 86400));
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week)!.push(t);
  }
  for (const [week, ts] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    const startDate = new Date((oldestTs + week * 7 * 86400) * 1000).toISOString().slice(0, 10);
    reportGroup(`wk${week} (${startDate})`, ts);
  }

  console.log(`\n15-30c band, by side:`);
  const sweetSpot = trials.filter((t) => t.entryPrice >= 0.15 && t.entryPrice < 0.3);
  reportGroup(
    "HIGH",
    sweetSpot.filter((t) => /\(HIGH\)/.test(t.question))
  );
  reportGroup(
    "LOW",
    sweetSpot.filter((t) => /\(LOW\)/.test(t.question))
  );

  mkdirSync("data", { recursive: true });
  const cachePath = `data/${wallet.address}-trials.json`;
  writeFileSync(cachePath, JSON.stringify(trials));
  console.log(`\nCached ${trials.length} trials to ${cachePath} for offline reanalysis.`);

  console.log(`\nTop 10 markets by stake:`);
  const byMarket = new Map<string, ResolvedTrial[]>();
  for (const t of trials) {
    const key = t.question;
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key)!.push(t);
  }
  const ranked = [...byMarket.entries()]
    .map(([question, ts]) => ({ question, ...summarize(ts), trials: ts }))
    .sort((a, b) => b.totalStaked - a.totalStaked)
    .slice(0, 10);
  for (const m of ranked) {
    const wins = m.trials.filter((t) => t.won).length;
    const net = (m.totalReturned - m.totalStaked) / m.totalStaked;
    console.log(
      `  $${m.totalStaked.toFixed(0).padStart(7)}  win ${pct(wins / m.trials.length).padStart(6)}  net ${pct(net).padStart(7)}  ${m.question.slice(0, 70)}`
    );
  }
}

main();
