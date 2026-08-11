// Phase 0/1 entrypoint: poll tracked wallets, then scan the ladder-harvester
// track. Nothing here places an order — see README Roadmap for what's gated
// behind a deliberate go-live decision.

import "dotenv/config";
import { main as trackWallets } from "./walletTracker";
import { main as scanLadders } from "./ladderScanner";

async function main() {
  console.log("=== wallet tracker ===");
  await trackWallets();

  console.log("\n=== ladder scanner ===");
  await scanLadders();
}

main();
