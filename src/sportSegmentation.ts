// New angle (2026-08-18): drilling one level deeper into an already-found
// signal. docs/AUDIT.md already established that 0x1b20a0...'s sports
// trades split unevenly by bet TYPE (O/U 55.4% win / +63.7% net vs.
// moneyline 51.9% win / +14.6% net). This asks the next question: does
// that edge also concentrate in a specific SPORT/LEAGUE, the way it does
// in a specific bet type? If one league carries most of the edge and
// another is closer to breakeven or negative, that's a further filter for
// the live paper-trading config the same way minLeaderStakeUsdc was.
//
// League is read directly off eventKey (eventSlug when present, else
// market slug) rather than parsed from the title — this project's real
// slugs are consistently "{league}-{team}-{team}-{date}[-total-N]"
// (confirmed for mlb/wnba while building ouOverBias.ts and by inspecting
// this wallet's own live wallet_activity rows), so the league prefix is a
// clean, reliable signal already present in data every trial carries.
//
// Reuses the same engine as everywhere else in this project
// (src/backtesting/engine.ts's buildTrials, src/backtesting/statistics.ts's
// computeStrategyResult) rather than hand-rolling a fill/market count —
// this project has repeatedly found that hand-rolled bucket counts overstate
// sample size on correlated markets (docs/AUDIT.md §7), and the stake-sizing
// refinement was specifically re-done through this engine after an earlier,
// less rigorous pass gave an unreliable number.

import "dotenv/config";
import { getActivityFromStart } from "./api/client";
import { TRACKED_WALLETS } from "./wallets";
import { buildTrials, defaultBacktestConfig } from "./backtesting/engine";
import { computeStrategyResult, MIN_SAMPLE_SIZE } from "./backtesting/statistics";
import type { BacktestTrial } from "./domain/types";

const TARGET_WALLET_FILTER = "0x1b20a0";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function leagueOf(trial: BacktestTrial): string {
  return trial.eventKey.split("-")[0].toUpperCase();
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
    strategyName: "sport-segmentation",
  });

  const allTrials = await buildTrials(wallet.address, activity, config);
  const sportsTrials = allTrials.filter((t) => t.category === "sports");

  console.log(`\n[${wallet.label}]`);
  console.log(`  ${allTrials.length} total resolved trials, ${sportsTrials.length} in the "sports" category`);

  const overall = computeStrategyResult(sportsTrials, config);
  console.log(
    `\n  Overall sports: trials=${overall.trialCount} distinctEvents=${overall.distinctEvents} ` +
      `winRate=${pct(overall.winRate)} roi=${pct(overall.roi)}` +
      (overall.roiBootstrapCI ? `  95% CI [${pct(overall.roiBootstrapCI[0])}, ${pct(overall.roiBootstrapCI[1])}]` : "")
  );

  const leagues = [...new Set(sportsTrials.map(leagueOf))];
  const byLeague = leagues
    .map((league) => ({ league, trials: sportsTrials.filter((t) => leagueOf(t) === league) }))
    .sort((a, b) => b.trials.length - a.trials.length);

  console.log(`\n  By league (${leagues.length} distinct):`);
  for (const { league, trials } of byLeague) {
    const r = computeStrategyResult(trials, config);
    const flag = r.distinctEvents < MIN_SAMPLE_SIZE ? "  [below MIN_SAMPLE_SIZE — provisional]" : "";
    console.log(
      `    ${league.padEnd(6)} trials=${String(r.trialCount).padStart(4)} distinctEvents=${String(r.distinctEvents).padStart(3)} ` +
        `winRate=${pct(r.winRate).padStart(6)} roi=${pct(r.roi).padStart(7)}` +
        (r.roiBootstrapCI ? `  95% CI [${pct(r.roiBootstrapCI[0])}, ${pct(r.roiBootstrapCI[1])}]` : "") +
        flag
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
