// CLI for the Phase 3 paper-trading portfolio (src/paperTrading/).
// Read-only reporting — the trackDaemon actually runs the engine; this just
// summarizes what's in paper_orders so far.
//
// Usage: npm run paper:report

import "dotenv/config";
import { listPaperOrders } from "../storage/repository";
import { PAPER_TRADE_TARGETS } from "../paperTrading/config";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export async function main() {
  for (const target of PAPER_TRADE_TARGETS) {
    const orders = listPaperOrders(target.address);
    const open = orders.filter((o) => o.status === "filled");
    const unresolvable = orders.filter((o) => o.status === "unresolvable");
    const closed = orders.filter((o) => o.status === "won" || o.status === "lost");
    const won = closed.filter((o) => o.status === "won");

    console.log(`\n[${target.label}] ${target.address}`);
    console.log(`  stake=$${target.stakeUsdc}  delay=${target.delaySeconds}s  categoryFilter=${target.categoryFilter ?? "(none)"}`);
    console.log(`  open=${open.length} ($${(open.length * target.stakeUsdc).toFixed(2)} staked)  unresolvable=${unresolvable.length}`);

    if (closed.length === 0) {
      console.log(`  closed=0 — no paper trades have resolved yet`);
      continue;
    }

    const staked = closed.length * target.stakeUsdc;
    const netPnl = closed.reduce((s, o) => s + (o.pnlUsdc ?? 0), 0);
    const distinctEvents = new Set(closed.map((o) => o.conditionId)).size;
    console.log(
      `  closed=${closed.length}  winRate=${pct(won.length / closed.length)}  netPnl=$${netPnl.toFixed(2)}  roi=${pct(netPnl / staked)}`
    );
    // Fills, not independent bets: a wallet often splits one real bet into
    // many small fills on the same market (docs/AUDIT.md §7's
    // sample-inflation lesson — see effectiveIndependentSampleCount in the
    // backtest engine). A low distinctEvents count means this number is
    // still mostly noise, whatever the win rate looks like.
    if (distinctEvents < 20) {
      console.log(`  ⚠ only ${distinctEvents} distinct market(s) behind these ${closed.length} fills — too few to be meaningful yet, do not read winRate/roi above as a real signal`);
    } else {
      console.log(`  distinctEvents=${distinctEvents}`);
    }
  }
}

if (require.main === module) {
  main();
}
