// Sourcing dedupe against `wallet_scores` (item 53). Both sourcing scripts
// skipped only wallets already in TRACKED_WALLETS, so every run re-scored
// the same candidates from scratch -- including ones a previous run had
// already confirmed (pass or fail) with a full reproducible pull. A wallet
// whose latest CONFIRMED score (non-shallow, non-truncated; see
// listLatestWalletScores) is younger than RESCORE_AFTER_DAYS is skipped;
// after that it's fair game again, since a wallet's recent trading can
// change the verdict. `--rescore` on either script bypasses this.

import { listLatestWalletScores } from "../storage/repository";
import type { WalletScoreRecord } from "../domain/types";

export const RESCORE_AFTER_DAYS = 14;

export function recentlyConfirmed(
  rows: Pick<WalletScoreRecord, "address" | "scoredAt">[],
  nowSeconds: number,
  maxAgeDays = RESCORE_AFTER_DAYS
): Set<string> {
  const cutoff = nowSeconds - maxAgeDays * 86400;
  return new Set(rows.filter((r) => r.scoredAt >= cutoff).map((r) => r.address.toLowerCase()));
}

// Empty when `--rescore` is passed, so callers can apply it unconditionally.
export function recentlyConfirmedAddresses(argv: string[] = process.argv.slice(2)): Set<string> {
  if (argv.includes("--rescore")) return new Set();
  return recentlyConfirmed(listLatestWalletScores({ confirmedOnly: true }), Math.floor(Date.now() / 1000));
}
