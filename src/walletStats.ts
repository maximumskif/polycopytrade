// Characterizes each tracked wallet's REAL trading behavior from its full
// activity history, instead of trusting the archetype labels in wallets.ts
// (which were assigned from leaderboard stats before looking at any trades).
//
// Important nuance discovered while building this: data-api's /activity
// returns one row per FILL, not per decision. A single order against a thin
// book can generate dozens of fill rows at ~the same price within seconds.
// Naively counting "trades" massively overstates trading frequency and
// understates size. This clusters fills back into synthetic orders
// (same market + outcome + side, gaps <=120s) before computing stats.

import { getActivity, type Activity } from "./api/client";
import { TRACKED_WALLETS } from "./wallets";
import { categorize } from "./categorize";

interface SyntheticOrder {
  conditionId: string;
  outcome: string;
  side: string;
  usdcSize: number;
  size: number;
  firstTs: number;
  lastTs: number;
  fillCount: number;
}

function clusterFills(trades: Activity[]): SyntheticOrder[] {
  const sorted = [...trades].sort((a, b) =>
    a.conditionId === b.conditionId
      ? a.outcome === b.outcome
        ? a.side === b.side
          ? a.timestamp - b.timestamp
          : a.side.localeCompare(b.side)
        : a.outcome.localeCompare(b.outcome)
      : a.conditionId.localeCompare(b.conditionId)
  );

  const orders: SyntheticOrder[] = [];
  let cur: SyntheticOrder | null = null;
  for (const t of sorted) {
    const sameGroup = cur && cur.conditionId === t.conditionId && cur.outcome === t.outcome && cur.side === t.side;
    if (sameGroup && t.timestamp - cur!.lastTs <= 120) {
      cur!.usdcSize += t.usdcSize;
      cur!.size += t.size;
      cur!.lastTs = t.timestamp;
      cur!.fillCount += 1;
    } else {
      if (cur) orders.push(cur);
      cur = {
        conditionId: t.conditionId,
        outcome: t.outcome,
        side: t.side,
        usdcSize: t.usdcSize,
        size: t.size,
        firstTs: t.timestamp,
        lastTs: t.timestamp,
        fillCount: 1,
      };
    }
  }
  if (cur) orders.push(cur);
  return orders;
}

async function statsForWallet(wallet: (typeof TRACKED_WALLETS)[number], pages?: number) {
  const effectivePages = pages ?? wallet.historyPages ?? 3;
  const trades: Activity[] = [];
  for (let page = 0; page < effectivePages; page++) {
    const batch = await getActivity(wallet.address, { limit: 500, offset: page * 500 });
    trades.push(...batch.filter((a) => a.type === "TRADE"));
    if (batch.length < 500) break; // reached the end of this wallet's history
  }

  const orders = clusterFills(trades);
  const byCategory = new Map<string, { count: number; usdc: number }>();
  for (const t of trades) {
    const cat = categorize(t.title);
    const entry = byCategory.get(cat) ?? { count: 0, usdc: 0 };
    entry.count += 1;
    entry.usdc += t.usdcSize;
    byCategory.set(cat, entry);
  }

  const avgOrderUsdc = orders.length ? orders.reduce((s, o) => s + o.usdcSize, 0) / orders.length : 0;
  const spanDays = trades.length
    ? (Math.max(...trades.map((t) => t.timestamp)) - Math.min(...trades.map((t) => t.timestamp))) / 86400
    : 0;

  console.log(`\n[${wallet.label}] (labeled: ${wallet.archetype})`);
  console.log(`  ${trades.length} raw fills -> ${orders.length} synthetic orders over ${spanDays.toFixed(1)} days`);
  console.log(`  avg order size: $${avgOrderUsdc.toFixed(0)}, avg fills/order: ${(trades.length / Math.max(orders.length, 1)).toFixed(1)}`);
  console.log(`  categories:`, Object.fromEntries([...byCategory].map(([k, v]) => [k, `${v.count} fills / $${v.usdc.toFixed(0)}`])));
}

export async function main() {
  for (const wallet of TRACKED_WALLETS) {
    if (!wallet.address) continue;
    try {
      await statsForWallet(wallet);
    } catch (err) {
      console.error(`[${wallet.label}] failed:`, (err as Error).message);
    }
  }
}

if (require.main === module) {
  main();
}
