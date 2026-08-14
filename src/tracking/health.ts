// Per-wallet freshness/health, read straight from storage — the minimal
// "expose health information" requirement for Phase 1 without building the
// full dashboard (Phase 4).

import "dotenv/config";
import { runMigrations } from "../storage/migrate";
import { listWalletHealth } from "../storage/repository";

function fmtAgo(ts: number | null): string {
  if (ts === null) return "never";
  const seconds = Math.floor(Date.now() / 1000) - ts;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

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
