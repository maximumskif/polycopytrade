// Track L2 (2026-09-24): weekly re-confirmation of the quality pool, run by
// ops/systemd/polycopytrade-rescore.timer through `npm run job`. Re-scores
// every wallet whose latest confirmed wallet_scores row passes
// isQualityWallet, via confirm-shallow (anchored pull + one later-anchor
// retry if truncated -- see src/research/walletConfirmation.ts), so the pool
// in `npm run status` and watch:check's `quality-pool-changed` entry reflect
// current trading instead of whatever was true when each wallet was first
// confirmed. With K3, a warm re-score is mostly DB reads.
//
// Usage: npm run rescore-pool [-- --dry-run]

import "dotenv/config";
import { spawnSync } from "node:child_process";
import { runMigrations } from "../storage/migrate";
import { listConfirmedQualityWallets } from "../storage/repository";
import { TRACKED_WALLETS } from "../wallets";

function main() {
  runMigrations();
  const pool = listConfirmedQualityWallets();
  if (pool.length === 0) {
    console.log("Quality pool is empty (no confirmed wallet_scores row passes isQualityWallet) -- nothing to re-score.");
    return;
  }
  const addresses = pool.map((r) => r.address);
  console.log(
    `Re-confirming ${addresses.length} quality-pool wallet(s): ${pool.map((r) => TRACKED_WALLETS.find((w) => w.address.toLowerCase() === r.address)?.label.split(" ")[0] ?? r.label ?? r.address).join(", ")}`
  );
  if (process.argv.includes("--dry-run")) return;
  const res = spawnSync("npm", ["run", "-s", "confirm-shallow", "--", ...addresses], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

main();
