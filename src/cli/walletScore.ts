// CLI for the Phase 2 wallet scoring module (src/scoring/walletScore.ts).
// Runs the full-history pull + backtest engine + flag logic for one wallet
// (filtered by address/label substring) or every TRACKED_WALLET at once.
//
// Usage: npm run wallet-score -- <filter>|all

import "dotenv/config";
import { scoreWallet } from "../scoring/walletScore";
import { TRACKED_WALLETS } from "../wallets";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export async function main() {
  const filter = process.argv[2]?.toLowerCase();
  if (!filter) {
    console.error("Usage: npm run wallet-score -- <wallet address/label filter>|all");
    process.exit(1);
  }

  const wallets =
    filter === "all"
      ? TRACKED_WALLETS
      : TRACKED_WALLETS.filter((w) => w.address.toLowerCase().includes(filter) || w.label.toLowerCase().includes(filter));

  if (wallets.length === 0) {
    console.error(`No tracked wallet matches "${filter}"`);
    process.exit(1);
  }

  for (const wallet of wallets) {
    try {
      const score = await scoreWallet(wallet);
      console.log(`\n[${wallet.label}]`);
      console.log(`  flags: ${score.flags.length ? score.flags.join(", ") : "(none)"}`);
      console.log(
        `  events=${score.distinctEvents}  spanDays=${score.activitySpanDays.toFixed(1)}  daysSinceLastActivity=${score.daysSinceLastActivity.toFixed(1)}`
      );
      console.log(
        `  topEventShare=${pct(score.concentrationTopEventShare)}  electionShare=${pct(score.electionShare)}  winRate=${pct(score.winRate)}  netPnl=$${score.netPnl.toFixed(2)}  roi=${pct(score.roi)}`
      );
    } catch (err) {
      console.error(`  [${wallet.label}] scoring failed: ${(err as Error).message}`);
    }
  }
}

if (require.main === module) {
  main();
}
