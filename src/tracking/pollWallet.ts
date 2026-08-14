// One wallet, one poll: fetch positions + recent activity, persist both
// idempotently, record the outcome. Shared by both track:once and
// track:daemon so they can never drift in behavior.

import { getActivity, getPositions } from "../api/client";
import { insertActivity, insertPositionsSnapshot, recordWalletPoll } from "../storage/repository";
import type { Trackable, WalletPollResult } from "../domain/types";

export async function pollWallet(wallet: Trackable): Promise<WalletPollResult> {
  const polledAt = Math.floor(Date.now() / 1000);
  try {
    const positions = await getPositions(wallet.address);
    const activity = await getActivity(wallet.address, { limit: 200 });

    insertPositionsSnapshot(wallet.address, positions);
    const activityInserted = insertActivity(wallet.address, activity);

    const result: WalletPollResult = {
      address: wallet.address,
      polledAt,
      outcome: "ok",
      positionsFetched: positions.length,
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
    console.log(
      `[${wallet.label}] ${status} — ${result.positionsFetched} positions, ` +
        `${result.activityFetched} activity rows fetched (${result.activityInserted} new)`
    );
    results.push(result);
  }
  return results;
}
