// Phase 0: poll every tracked wallet's current positions + activity history
// and append snapshots to data/*.jsonl. This is our paper-trading-equivalent
// for the copy-trading tracks — no capital at risk, just building the
// dataset Phase 1 backtests will run against.

import fs from "node:fs";
import path from "node:path";
import { getActivity, getPositions, type Activity, type Position } from "./polymarketClient";
import { TRACKED_WALLETS } from "./wallets";

const DATA_DIR = path.join(__dirname, "..", "data");
const POSITIONS_LOG = path.join(DATA_DIR, "positions.jsonl");
const ACTIVITY_LOG = path.join(DATA_DIR, "activity.jsonl");

function appendJsonl(file: string, rows: unknown[]) {
  if (rows.length === 0) return;
  const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(file, lines);
}

async function pollWallet(wallet: (typeof TRACKED_WALLETS)[number]) {
  const polledAt = Date.now();

  const positions: Position[] = await getPositions(wallet.address);
  appendJsonl(
    POSITIONS_LOG,
    positions.map((p) => ({ polledAt, label: wallet.label, archetype: wallet.archetype, ...p }))
  );

  const activity: Activity[] = await getActivity(wallet.address, { limit: 200 });
  appendJsonl(
    ACTIVITY_LOG,
    activity.map((a) => ({ polledAt, label: wallet.label, archetype: wallet.archetype, ...a }))
  );

  const openValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + p.cashPnl, 0);
  console.log(
    `[${wallet.label}] ${positions.length} open positions worth $${openValue.toFixed(0)} ` +
      `(unrealized P/L $${unrealizedPnl.toFixed(0)}), ${activity.length} recent activity rows logged`
  );
}

export async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const wallet of TRACKED_WALLETS) {
    if (!wallet.address) {
      console.warn(`[${wallet.label}] no address set, skipping`);
      continue;
    }
    try {
      await pollWallet(wallet);
    } catch (err) {
      console.error(`[${wallet.label}] poll failed:`, (err as Error).message);
    }
  }
}

if (require.main === module) {
  main();
}
