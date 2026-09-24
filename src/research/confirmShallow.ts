// Confirms a `[shallow]` score from sourceWallets.ts with a reproducible
// pull (item 41). scoreWalletShallow() pages backward from "now", so its
// window shifts every call -- fine as a screen, not as a number to record.
// This re-scores the same wallet forward from a PINNED anchor timestamp
// (getActivityFromStart's `fromTs`), which reaches recent trades within the
// page budget yet returns the same fills on every re-run. Also re-checks the
// truncation condition sourceWallets.ts uses: if the pull's newest fill is
// still older than the wallet's actual newest activity, the page budget ran
// out before the present and the result is reported as such, not trusted.
//
// Usage: npm run confirm-shallow -- [--from=YYYY-MM-DD] <address> [<address> ...]
//
// `--from` overrides the default anchor for very high-volume wallets whose
// 40 pages can't span ~3 months (item 42: three soccer wallets hit ~20K
// fills within two weeks of the default). Record whatever anchor was used
// as that wallet's `historyStart`.
import "dotenv/config";
import { getActivity } from "../api/client";
import { scoreWalletWithActivity } from "../scoring/walletScore";
import type { TrackedWallet } from "../wallets";

// 2026-06-24T00:00:00Z -- ~90 days before item 41's sweep. Pinned, not
// computed from Date.now(), so the fills (and therefore the score) are
// reproducible; record this same value as `historyStart` in wallets.ts.
export const CONFIRM_HISTORY_START = 1782259200;
const CONFIRM_HISTORY_PAGES = 40;

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

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
  console.log(
    `Confirming ${addresses.length} wallet(s) from anchor ${new Date(historyStart * 1000).toISOString()}, ` +
      `historyPages=${CONFIRM_HISTORY_PAGES}\n`
  );
  for (const address of addresses) {
    const wallet: TrackedWallet = {
      address,
      label: address,
      archetype: "unclassified",
      source: "confirm-shallow",
      historyPages: CONFIRM_HISTORY_PAGES,
      historyStart,
    };
    try {
      const latest = await getActivity(address, { limit: 1 });
      const latestTs = latest.length ? latest[0].timestamp : null;
      const { score, activity } = await scoreWalletWithActivity(wallet);
      const pulledLatestTs = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : null;
      const truncated = latestTs !== null && (pulledLatestTs === null || pulledLatestTs < latestTs);
      console.log(
        `[${address}] fills=${activity.length}${truncated ? "  TRUNCATED -- page budget ended before present, not confirmed" : ""}`
      );
      console.log(`  qualityScore=${score.qualityScore}/100${score.flags.length ? `  (VETOED -- ${score.flags.join(", ")})` : "  clean"}`);
      console.log(
        `  events=${score.distinctEvents}  winRate=${pct(score.winRate)}  roi=${pct(score.roi)}  netPnl=$${score.netPnl.toFixed(2)}` +
          `  medianGapSeconds=${score.medianGapSeconds.toFixed(1)}  daysSinceLastActivity=${score.daysSinceLastActivity.toFixed(1)}\n`
      );
    } catch (err) {
      console.log(`[${address}] scoring failed: ${(err as Error).message}\n`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
