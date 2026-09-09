// Per-wallet freshness/health, read straight from storage — the minimal
// "expose health information" requirement for Phase 1 without building the
// full dashboard (Phase 4).

import "dotenv/config";
import { runMigrations } from "../storage/migrate";
import { listWalletHealth } from "../storage/repository";
import { fmtAgo } from "../utils/format";

export function main() {
  runMigrations();
  const health = listWalletHealth();
  if (health.length === 0) {
    console.log("No wallets tracked yet — run `npm run track:once` first.");
    return;
  }
  for (const h of health) {
    const status = h.consecutiveFailures > 0 ? `${h.consecutiveFailures} consecutive failures` : "healthy";
    console.log(
      `[${h.label}] last polled ${fmtAgo(h.lastPolledAt)}, last success ${fmtAgo(h.lastSuccessAt)}, ` +
        `${h.totalActivityRows} activity rows stored — ${status}`
    );
  }
}

if (require.main === module) {
  main();
}
