// Track E.14 (2026-09-13): re-checking a flagged-but-thin sub-signal from
// docs/AUDIT.md's 2026-08-16 bet-type breakdown of 0x1b20a0...: within its
// O/U (totals) trades, "Over" bets were 269 fills / 12 distinct markets,
// 96.7% win, +111.6% net -- "Under" bets were 521 fills / 25 markets, 34.2%
// win, +54.0% net. Flagged as "worth watching, NOT yet filtered on (12
// markets is still a thin sample)." This is NOT the same question
// ouOverBias.ts already answered (whether buying Over indiscriminately on
// ANY MLB game is market-wide profitable -- it isn't); this re-checks
// whether THIS WALLET's own Over-bet sample has grown past n=12 with ~26
// more days of real trading since the original check.
//
// O/U trials are identified directly by BacktestTrial.outcome being
// literally "Over"/"Under" (Activity.outcome passed straight through by
// buildTrials, see src/backtesting/engine.ts) -- no title regex needed,
// unlike the original ad hoc 2026-08-16 pass. A moneyline trial's outcome
// is a team name, never "Over"/"Under", so this filter cleanly isolates
// O/U markets without misclassifying anything.
//
// Reuses buildTrials/computeStrategyResult (src/backtesting/engine.ts,
// src/backtesting/statistics.ts) rather than hand-rolling sample counts --
// same discipline as sportSegmentation.ts/ouOverBias.ts.

import "dotenv/config";
import { getActivityFromStart } from "../api/client";
import { TRACKED_WALLETS } from "../wallets";
import { buildTrials, defaultBacktestConfig } from "../backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "../backtesting/statistics";

const TARGET_WALLET_FILTER = "0x1b20a0";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const wallet = TRACKED_WALLETS.find(
    (w) => w.address.toLowerCase().includes(TARGET_WALLET_FILTER) || w.label.toLowerCase().includes(TARGET_WALLET_FILTER)
  );
  if (!wallet) {
    console.error(`No tracked wallet matches "${TARGET_WALLET_FILTER}"`);
    process.exit(1);
  }

  const activity = await getActivityFromStart(wallet.address, wallet.historyPages ?? 10);
  const datasetCutoff = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : Math.floor(Date.now() / 1000);
  const config = defaultBacktestConfig({
    walletAddresses: [wallet.address],
    datasetCutoff,
    strategyName: "ou-over-under-split",
  });

  const allTrials = await buildTrials(wallet.address, activity, config);
  const sportsTrials = allTrials.filter((t) => t.category === "sports");
  const overTrials = sportsTrials.filter((t) => t.outcome === "Over");
  const underTrials = sportsTrials.filter((t) => t.outcome === "Under");

  console.log(`\n[${wallet.label}]`);
  console.log(`  ${allTrials.length} total resolved trials, ${sportsTrials.length} in "sports"`);
  console.log(`  ${overTrials.length} Over trials, ${underTrials.length} Under trials\n`);

  for (const [label, trials] of [
    ["Over", overTrials],
    ["Under", underTrials],
  ] as const) {
    const r = computeStrategyResult(trials, config);
    const flag = r.distinctEvents < MIN_SAMPLE_SIZE ? "  [below MIN_SAMPLE_SIZE — still provisional]" : "  [clears MIN_SAMPLE_SIZE]";
    console.log(
      `  ${label.padEnd(6)} trials=${r.trialCount}  distinctMarkets=${r.distinctMarkets}  distinctEvents=${r.distinctEvents}  ` +
        `winRate=${pct(r.winRate)}  roi=${pct(r.roi)}` +
        (r.roiBootstrapCI ? `  95% CI [${pct(r.roiBootstrapCI[0])}, ${pct(r.roiBootstrapCI[1])}]` : "  (no CI — below bootstrap floor)") +
        flag
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
