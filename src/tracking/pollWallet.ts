// One wallet, one poll: fetch recent activity, persist it idempotently,
// record the outcome. Shared by both track:once and track:daemon so they
// can never drift in behavior.
//
// Positions were fetched and snapshotted here through 2026-08-15, but
// nothing in the codebase has ever read the `positions` table (it's
// write-only dead data) and the 0001_init schema never dedupes snapshots —
// at one full-wallet-snapshot-per-wallet-per-60s-cycle across 39 wallets,
// this reached 1.6M rows / ~1.85GB inside a single day, which would have
// made Phase 3's "run for weeks" plan fill the disk. Stopped polling
// positions entirely rather than adding retention logic for data nothing
// uses — see docs/AUDIT.md's Phase 3 section. The `positions` table,
// `insertPositionsSnapshot`, and `getPositions` are left in place
// (harmless, unused) for Phase 4 to pick back up deliberately if a
// dashboard ever needs current-position data, with real retention design
// done at that point instead of guessed at now.

import { getActivity } from "../api/client";
import { insertActivity, recordWalletPoll } from "../storage/repository";
import type { Trackable, WalletPollResult } from "../domain/types";

export async function pollWallet(wallet: Trackable): Promise<WalletPollResult> {
  const polledAt = Math.floor(Date.now() / 1000);
  try {
    const activity = await getActivity(wallet.address, { limit: 200 });

    const activityInserted = insertActivity(wallet.address, activity);

    const result: WalletPollResult = {
      address: wallet.address,
      polledAt,
      outcome: "ok",
      positionsFetched: 0,
      activityFetched: activity.length,
      activityInserted,
    };
    recordWalletPoll(result);
    return result;
  } catch (err) {
    const result: WalletPollResult = {
      address: wallet.address,
      polledAt,
      outcome: "failed",
      positionsFetched: 0,
      activityFetched: 0,
      activityInserted: 0,
      error: (err as Error).message,
    };
    recordWalletPoll(result);
    return result;
  }
}

export async function pollAllWallets(wallets: Trackable[]): Promise<WalletPollResult[]> {
  const results: WalletPollResult[] = [];
  for (const wallet of wallets) {
    if (!wallet.address) {
      console.warn(`[${wallet.label}] no address set, skipping`);
      continue;
    }
    const result = await pollWallet(wallet);
    const status = result.outcome === "ok" ? "ok" : `FAILED (${result.error})`;
    console.log(`[${wallet.label}] ${status} — ${result.activityFetched} activity rows fetched (${result.activityInserted} new)`);
    results.push(result);
  }
  return results;
}
