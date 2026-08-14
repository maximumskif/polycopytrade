// Demo CLI for src/backtesting/followerExecution.ts (docs/AUDIT.md's
// "realistic copy-trade delay/slippage simulation" ask). Deliberately
// scoped: ONE wallet, a small sample of its resolved BUY trials -- see
// followerExecution.ts's header comment for why this isn't run across all
// 24 tracked wallets or a wallet's full trial set.
//
// Usage: npm run follower-delay-demo -- <wallet address/label filter> [sampleSize]

import "dotenv/config";
import { getActivityFromStart } from "../api/client";
import { TRACKED_WALLETS } from "../wallets";
import { buildTrials, defaultBacktestConfig } from "../backtesting/engine";
import { estimateFollowerFill, summarizeDelayDegradation, type LeaderFill } from "../backtesting/followerExecution";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Evenly spaced picks across the resolved trial list (in entry-time order)
// rather than the first N -- avoids the sample all landing in one burst of
// activity, which for a high-frequency wallet could all be the same event.
function sampleEvenly<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]);
}

export async function main() {
  const filter = process.argv[2]?.toLowerCase();
  const sampleSize = Number(process.argv[3] ?? 20);
  if (!filter) {
    console.error("Usage: npm run follower-delay-demo -- <wallet address/label filter> [sampleSize]");
    process.exit(1);
  }
  const wallet = TRACKED_WALLETS.find((w) => w.address.toLowerCase().includes(filter) || w.label.toLowerCase().includes(filter));
  if (!wallet) {
    console.error(`No tracked wallet matches "${filter}"`);
    process.exit(1);
  }

  console.log(`Pulling activity for [${wallet.label}]...`);
  const activity = await getActivityFromStart(wallet.address, wallet.historyPages ?? 10);
  const datasetCutoff = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : Math.floor(Date.now() / 1000);
  const config = defaultBacktestConfig({ walletAddresses: [wallet.address], datasetCutoff });
  const trials = await buildTrials(wallet.address, activity, config);
  const resolved = trials.filter((t) => t.resolved).sort((a, b) => a.entryTimestamp - b.entryTimestamp);

  const sample: LeaderFill[] = sampleEvenly(resolved, sampleSize).map((t) => ({
    conditionId: t.conditionId,
    outcome: t.outcome,
    timestamp: t.entryTimestamp,
    price: t.entryPrice,
    won: t.won === true,
  }));

  console.log(`Sampled ${sample.length} of ${resolved.length} resolved trials. Fetching per-fill price history (rate-limited, ~1 req/sec)...`);

  const estimates = [];
  for (const fill of sample) {
    const est = await estimateFollowerFill(fill);
    if (est) estimates.push(est);
  }

  console.log(`\n[${wallet.label}] follower delay/slippage demo — ${estimates.length}/${sample.length} fills resolved to a market+price lookup`);
  for (const row of summarizeDelayDegradation(estimates)) {
    console.log(
      `  +${String(row.delaySeconds).padStart(2)}s  n=${String(row.sampleSize).padStart(3)}  ` +
        `leaderEntry=${row.avgLeaderEntryPrice.toFixed(3)}  followerEntry=${row.avgFollowerEntryPrice.toFixed(3)}  ` +
        `slippage=${row.avgPriceSlippage >= 0 ? "+" : ""}${row.avgPriceSlippage.toFixed(3)}  ` +
        `leaderROI=${pct(row.leaderRoi)}  followerROI=${pct(row.followerRoi)}`
    );
  }
}

if (require.main === module) {
  main();
}
