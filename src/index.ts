// Convenience entrypoint: poll tracked wallets once, then scan the
// ladder-harvester track. Nothing here places an order — see README
// Roadmap for what's gated behind a deliberate go-live decision. For
// production polling use `npm run track:daemon` instead (this runs once
// and exits).

import "dotenv/config";
import { main as trackOnce } from "./tracking/trackOnce";
import { main as scanLadders } from "./research/ladderScanner";

async function main() {
  console.log("=== wallet tracker (once) ===");
  await trackOnce();

  console.log("\n=== ladder scanner ===");
  await scanLadders();
}

main();
