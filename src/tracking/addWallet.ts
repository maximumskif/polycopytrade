// `npm run wallets:add -- <address> <label> [archetype]` — adds a wallet to
// the tracking daemon's list without editing wallets.ts. Satisfies "use a
// configurable wallet list rather than requiring source edits"
// (docs/AUDIT.md Phase 1 scope). wallets.ts remains the seed/default set
// and the source of archetype metadata the research scripts (walletBacktest
// etc.) key off of — this only affects what track:once/track:daemon poll.

import "dotenv/config";
import { runMigrations } from "../storage/migrate";
import { addWallet } from "../storage/repository";

function main() {
  const [address, label, archetype] = process.argv.slice(2);
  if (!address || !label) {
    console.error("Usage: npm run wallets:add -- <address> <label> [archetype]");
    process.exit(1);
  }
  runMigrations();
  addWallet(address, label, archetype);
  console.log(`Added ${label} (${address}) to the tracking list.`);
}

main();
