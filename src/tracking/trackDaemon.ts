// Continuous polling loop. Unlike the old `index.ts`/`walletTracker.ts`
// combo (which ran once and exited despite POLL_INTERVAL_MS implying
// otherwise — see docs/AUDIT.md §8), this actually loops.
//
// - Polls at config.pollIntervalMs.
// - Never starts a second poll cycle while one is still running (the loop
//   is strictly sequential — a cycle that takes longer than the interval
//   just runs back-to-back with the next one, rather than overlapping).
// - Handles SIGINT/SIGTERM by finishing the current cycle, then exiting —
//   never killed mid-write.
// - Wallet list is re-read from storage every cycle, so `npm run
//   wallets:add` while the daemon is running is picked up on the next
//   cycle with no restart needed.

import "dotenv/config";
import { config } from "../config/env";
import { runMigrations } from "../storage/migrate";
import { upsertWallet, listTrackedWallets } from "../storage/repository";
import { TRACKED_WALLETS } from "../wallets";
import { pollAllWallets } from "./pollWallet";
import { wireApiErrorsToStorage } from "./wireApiErrors";
import { runPaperTradingCycle } from "../paperTrading/engine";

async function sleepInterruptible(ms: number, isStopping: () => boolean): Promise<void> {
  const step = 500;
  let waited = 0;
  while (waited < ms && !isStopping()) {
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
    waited += step;
  }
}

export async function main() {
  runMigrations();
  wireApiErrorsToStorage();
  for (const wallet of TRACKED_WALLETS) {
    if (wallet.address) upsertWallet(wallet);
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return; // second signal — already shutting down, ignore
    console.log(`\n[daemon] received ${signal}, finishing the current cycle then stopping...`);
    stopping = true;
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(`[daemon] starting — poll interval ${config.pollIntervalMs}ms, db ${config.dbPath}`);

  let cycle = 0;
  while (!stopping) {
    cycle++;
    const wallets = listTrackedWallets();
    console.log(`\n[daemon] cycle ${cycle} — polling ${wallets.length} wallets`);
    const results = await pollAllWallets(wallets);
    const failed = results.filter((r) => r.outcome !== "ok").length;
    if (failed > 0) console.warn(`[daemon] cycle ${cycle}: ${failed}/${results.length} wallets failed this cycle`);

    // A paper-trading failure must never take down wallet tracking — this
    // is a downstream consumer of the data this loop's real job is to
    // collect, not the other way around.
    try {
      await runPaperTradingCycle();
    } catch (err) {
      console.warn(`[daemon] cycle ${cycle}: paper-trading step failed: ${(err as Error).message}`);
    }

    if (stopping) break;
    await sleepInterruptible(config.pollIntervalMs, () => stopping);
  }

  console.log("[daemon] stopped.");
}

if (require.main === module) {
  main();
}
