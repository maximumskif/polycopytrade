// CLI for the Phase 2 reusable backtest engine (src/backtesting/engine.ts +
// statistics.ts). Deliberately separate from the existing, already-
// validated `wallet-backtest`/`wallet-breakdown` scripts rather than
// refactoring them to share this engine — those scripts' exact numbers are
// cited throughout README.md as historical findings (Phase 1e/1f/1g), and
// forcing them through new code for consolidation's own sake would risk
// silently changing those numbers. Running this independent implementation
// against the same wallet and confirming it agrees is a stronger check than
// sharing code would have been — see Phase 2's "Verify" step.
//
// Usage: npm run backtest -- <wallet address/label filter> [--mirror-exit] [--rolling-window=<days>]

import "dotenv/config";
import { getActivityFromStart } from "../api/client";
import { TRACKED_WALLETS } from "../wallets";
import { buildTrials, defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult } from "../backtesting/statistics";
import { computeRollingWindowResults } from "../backtesting/rollingWindow";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export async function main() {
  const filter = process.argv[2]?.toLowerCase();
  const mirrorExit = process.argv.includes("--mirror-exit");
  const rollingWindowArg = process.argv.find((a) => a.startsWith("--rolling-window="));
  const rollingWindowDays = rollingWindowArg ? Number(rollingWindowArg.split("=")[1]) : null;
  if (!filter) {
    console.error("Usage: npm run backtest -- <wallet address/label filter> [--mirror-exit] [--rolling-window=<days>]");
    process.exit(1);
  }
  const wallet = TRACKED_WALLETS.find((w) => w.address.toLowerCase().includes(filter) || w.label.toLowerCase().includes(filter));
  if (!wallet) {
    console.error(`No tracked wallet matches "${filter}"`);
    process.exit(1);
  }

  const activity = await getActivityFromStart(wallet.address, wallet.historyPages ?? 10);
  const datasetCutoff = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : Math.floor(Date.now() / 1000);

  const config = defaultBacktestConfig({
    walletAddresses: [wallet.address],
    datasetCutoff,
    resolutionTreatment: mirrorExit ? "mirror-exit" : "hold-to-resolution",
    exitRule: mirrorExit
      ? "mirror the wallet's actual sells; force-close at settlement if still held when the market closes"
      : "hold to resolution",
  });

  const trials = await buildTrials(wallet.address, activity, config);
  const result = computeStrategyResult(trials, config);

  console.log(`\n[${wallet.label}] (${config.resolutionTreatment})`);
  console.log(
    `  ${result.trialCount} resolved trials across ${result.distinctMarkets} markets, ` +
      `${result.distinctEvents} distinct events (effective independent sample size)`
  );
  if (!result.meetsMinimumSample) {
    console.log(`  ⚠ below the minimum sample size — treat every stat below as provisional, not confirmed`);
  }
  console.log(
    `  win rate ${pct(result.winRate)}  staked $${result.totalStaked.toFixed(0)}  ` +
      `net $${result.netPnl.toFixed(0)}  ROI ${pct(result.roi)}` +
      (result.roiBootstrapCI ? `  (95% CI ${pct(result.roiBootstrapCI[0])} to ${pct(result.roiBootstrapCI[1])})` : "")
  );
  console.log(
    `  avg win $${result.avgWin.toFixed(2)}  avg loss $${result.avgLoss.toFixed(2)}  ` +
      `profit factor ${result.profitFactor?.toFixed(2) ?? "n/a (no losses)"}  ` +
      `max drawdown ${pct(result.maxDrawdownPct)}`
  );
  console.log(
    `  volatility ${result.volatility.toFixed(3)}  Sharpe-like ${result.sharpeLike?.toFixed(2) ?? "n/a"}  ` +
      `Sortino-like ${result.sortinoLike?.toFixed(2) ?? "n/a"}  (per-trial return basis, not annualized)`
  );
  console.log(`\n  By category:`);
  for (const [cat, b] of Object.entries(result.categoryBreakdown).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${cat.padEnd(16)} n=${String(b.n).padStart(4)}  win ${pct(b.winRate).padStart(6)}  net $${b.netPnl.toFixed(0)}`);
  }

  if (rollingWindowDays) {
    const windows = computeRollingWindowResults(trials, config, rollingWindowDays * 86400);
    console.log(`\n  By ${rollingWindowDays}-day window (time-decay check — see Phase 1f's week-by-week finding):`);
    windows.forEach((w, i) => {
      const start = new Date(w.windowStart * 1000).toISOString().slice(0, 10);
      console.log(
        `    wk${i} (${start})  n=${String(w.result.trialCount).padStart(4)}  win ${pct(w.result.winRate).padStart(6)}  net $${w.result.netPnl.toFixed(0).padStart(8)}  ROI ${pct(w.result.roi)}`
      );
    });
  }
}

if (require.main === module) {
  main();
}
