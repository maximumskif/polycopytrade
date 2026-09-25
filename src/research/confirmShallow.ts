// Confirms a `[shallow]` score with a reproducible pull (item 41).
// scoreWalletShallow() pages backward from "now", so its window shifts
// every call -- fine as a screen, not as a number to record. This re-scores
// the same wallet forward from a PINNED anchor timestamp
// (getActivityFromStart's `fromTs`), which reaches recent trades within the
// page budget yet returns the same fills on every re-run, and re-checks
// truncation: if the pull's newest fill is still older than the wallet's
// actual newest activity, the page budget ran out before the present.
//
// Since Track M1 (2026-09-24) the anchor/truncation/retry logic lives in
// walletConfirmation.ts, shared with the sourcing scripts (which now run
// it automatically on every shallow pass): a truncated pull is retried
// ONCE from a later pinned anchor (retryAnchorFor), and a wallet still
// truncated after that is reported UNCONFIRMED, not passed. Every attempt
// is recorded in `wallet_scores` (source "confirm-shallow").
//
// Usage: npm run confirm-shallow -- [--from=YYYY-MM-DD] <address> [<address> ...]
//
// `--from` overrides the default first anchor for very high-volume wallets
// whose 40 pages can't span ~3 months (item 42: three soccer wallets hit
// ~20K fills within two weeks of the default). The anchor actually used is
// recorded and printed in the wallets.ts entry.
import "dotenv/config";
import { runMigrations } from "../storage/migrate";
import { TRACKED_WALLETS } from "../wallets";
import {
  CONFIRM_HISTORY_PAGES,
  CONFIRM_HISTORY_START,
  confirmWallet,
  describeScore,
  describeWindow,
  printVerdicts,
  recordAttempt,
  verdictToOutcome,
  type PipelineOutcome,
} from "./walletConfirmation";

const SOURCE = "confirm-shallow";

async function main() {
  const args = process.argv.slice(2);
  const fromArg = args.find((a) => a.startsWith("--from="))?.slice("--from=".length);
  const historyStart = fromArg ? Math.floor(Date.parse(`${fromArg}T00:00:00Z`) / 1000) : CONFIRM_HISTORY_START;
  if (!Number.isFinite(historyStart)) {
    console.error(`--from must be YYYY-MM-DD, got "${fromArg}"`);
    process.exit(1);
  }
  const addresses = args.filter((a) => !a.startsWith("--"));
  if (!addresses.length) {
    console.error("usage: npm run confirm-shallow -- [--from=YYYY-MM-DD] <address> [<address> ...]");
    process.exit(1);
  }
  runMigrations();
  console.log(
    `Confirming ${addresses.length} wallet(s) from anchor ${new Date(historyStart * 1000).toISOString()}, ` +
      `historyPages=${CONFIRM_HISTORY_PAGES} (one retry from a later anchor if truncated)\n`
  );
  const outcomes: PipelineOutcome[] = [];
  for (const address of addresses) {
    // A tracked wallet's name (first word of its wallets.ts label) makes the
    // wallet_scores row and `npm run status` readable; fall back to the
    // address for untracked candidates.
    const tracked = TRACKED_WALLETS.find((w) => w.address.toLowerCase() === address.toLowerCase());
    const label = tracked ? tracked.label.split(" ")[0] : address;
    const base = { address, label, provenance: "npm run confirm-shallow" };
    try {
      console.log(`[${address}]`);
      const { verdict } = await confirmWallet(
        { address, label },
        {
          historyStart,
          onAttempt: (a) => {
            recordAttempt(a, { source: SOURCE });
            console.log(
              `  [${describeWindow(a)}] fills=${a.fills}` +
                `${a.truncated ? "  TRUNCATED -- page budget ended before present" : "  reached present"}\n    ${describeScore(a.score)}`
            );
          },
        }
      );
      outcomes.push(verdictToOutcome(base, verdict));
    } catch (err) {
      console.log(`  scoring failed: ${(err as Error).message}`);
      outcomes.push({ ...base, kind: "error", reason: (err as Error).message });
    }
  }
  printVerdicts(outcomes);
  // One-line result for `npm run jobs` (see lastLogLine's SUMMARY_LINE).
  const count = (k: PipelineOutcome["kind"]) => outcomes.filter((o) => o.kind === k).length;
  console.log(
    `\nSummary: ${outcomes.length} wallet(s) -> ${count("confirmed-quality")} confirmed quality / ` +
      `${count("failed-confirmation")} failed / ${count("unconfirmed-truncated")} unconfirmed (truncated) / ${count("error")} errors`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
