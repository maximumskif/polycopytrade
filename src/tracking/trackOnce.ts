// Poll every tracked wallet exactly once and exit. Replaces the old
// walletTracker.ts's JSONL-appending behavior (see docs/AUDIT.md §8) with
// idempotent SQLite writes.

import "dotenv/config";
import { runMigrations } from "../storage/migrate";
import { upsertWallet, listTrackedWallets } from "../storage/repository";
import { TRACKED_WALLETS } from "../wallets";
import { pollAllWallets } from "./pollWallet";
import { wireApiErrorsToStorage } from "./wireApiErrors";

export async function main() {
  runMigrations();
  wireApiErrorsToStorage();

  // wallets.ts is the seed/default set; anything added at runtime via
  // `npm run wallets:add` is preserved (upsert never deletes).
  for (const wallet of TRACKED_WALLETS) {
    if (wallet.address) upsertWallet(wallet);
  }

  const wallets = listTrackedWallets();
  console.log(`Polling ${wallets.length} tracked wallets once...`);
  const results = await pollAllWallets(wallets);

  const failed = results.filter((r) => r.outcome !== "ok").length;
  const newRows = results.reduce((s, r) => s + r.activityInserted, 0);
  console.log(`\nDone: ${results.length - failed}/${results.length} wallets ok, ${newRows} new activity rows stored.`);
}

if (require.main === module) {
  main();
}
