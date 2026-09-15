// CLI for the archetype classifier (src/scoring/archetypeClassifier.ts).
// Runs the same full-history pull + backtest engine scoreWallet() already
// uses for wallet-score (via scoreWalletWithActivity, which also hands back
// the raw activity/trials the classifier needs for order-clustering — one
// pull, not two), then compares the ALGORITHMIC archetype against the
// PROVISIONAL one hand-assigned in wallets.ts, flagging disagreements.
//
// Usage: npm run classify-archetypes -- <filter>|all [--write]
//
// --write updates wallets.ts's TrackedWallet.archetype field in place for
// every wallet with a confident (confidence > 0) classification, matching
// this project's existing provenance-logging practice (Track E.13 logged
// scored-but-ruled-out wallets permanently rather than discarding the
// work). Without --write this is read-only — prints the comparison only.

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scoreWalletWithActivity } from "../scoring/walletScore";
import { classifyArchetype } from "../scoring/archetypeClassifier";
import { TRACKED_WALLETS } from "../wallets";

const WALLETS_FILE = join(__dirname, "../wallets.ts");

export async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const filter = args.find((a) => a !== "--write")?.toLowerCase();

  if (!filter) {
    console.error("Usage: npm run classify-archetypes -- <wallet address/label filter>|all [--write]");
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

  let walletsSource = write ? readFileSync(WALLETS_FILE, "utf8") : "";
  let agreements = 0;
  let disagreements = 0;
  let newlyClassified = 0;
  let stillUnclassified = 0;

  for (const wallet of wallets) {
    try {
      const { score, activity, trials } = await scoreWalletWithActivity(wallet);
      const result = classifyArchetype(score, trials, activity);
      const declared = wallet.archetype;

      const status =
        result.archetype === "unclassified"
          ? "no confident match"
          : declared === "unclassified"
            ? "NEWLY CLASSIFIED"
            : declared === result.archetype
              ? "confirms declared"
              : "DISAGREES with declared";

      if (result.archetype === "unclassified") stillUnclassified++;
      else if (declared === "unclassified") newlyClassified++;
      else if (declared === result.archetype) agreements++;
      else disagreements++;

      console.log(`\n[${wallet.label}]`);
      console.log(`  declared=${declared}  algorithmic=${result.archetype} (confidence=${result.confidence.toFixed(2)})  -- ${status}`);
      for (const reason of result.reasons) console.log(`    - ${reason}`);

      if (write && result.confidence > 0 && result.archetype !== declared) {
        const addressLine = new RegExp(`(address:\\s*"${wallet.address}"[\\s\\S]*?archetype:\\s*")[a-z-]+(")`, "i");
        if (addressLine.test(walletsSource)) {
          walletsSource = walletsSource.replace(addressLine, `$1${result.archetype}$2`);
        } else {
          console.error(`    ! could not locate this wallet's archetype field in wallets.ts to update -- skipped`);
        }
      }
    } catch (err) {
      console.error(`  [${wallet.label}] classification failed: ${(err as Error).message}`);
    }
  }

  console.log(
    `\n=== summary: ${agreements} confirm declared, ${disagreements} disagree, ${newlyClassified} newly classified, ${stillUnclassified} still unclassified ===`
  );

  if (write) {
    writeFileSync(WALLETS_FILE, walletsSource);
    console.log("wallets.ts updated in place.");
  }
}

if (require.main === module) {
  main();
}
