// Phase 2 (docs/AUDIT.md §6): every prior backtest in this project analyzed
// BUY fills only, treating each one as an independent buy-and-hold-to-
// resolution bet. That's a defensible simplification for "would blind
// copying have worked," but it means the project has never been able to
// tell a wallet that holds to resolution apart from one that actively
// scalps in and out — SELL fills were ignored entirely. This reconstructs
// real position lifecycles (open -> increase/reduce -> close) per wallet,
// market, and outcome, using weighted-average-cost accounting.
//
// A position is modeled as a sequence of CYCLES: flat -> opened -> (any
// number of increased/reduced) -> closed -> flat again. Re-opening the same
// (conditionId, outcome) after fully closing it produces a second, separate
// ReconstructedPosition — they're genuinely different bets, not one
// continuous position.

import type { Activity } from "../api/schemas";
import type { PositionEvent, PositionEventKind, ReconstructedPosition } from "../domain/types";

function marketKey(conditionId: string, outcome: string): string {
  return `${conditionId}:${outcome}`;
}

export function reconstructPositions(walletAddress: string, activity: Activity[]): ReconstructedPosition[] {
  const trades = activity.filter((a) => a.type === "TRADE" && (a.side === "BUY" || a.side === "SELL"));

  const byMarket = new Map<string, Activity[]>();
  for (const t of trades) {
    const key = marketKey(t.conditionId, t.outcome);
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key)!.push(t);
  }

  const positions: ReconstructedPosition[] = [];

  for (const [key, fills] of byMarket) {
    const [conditionId, outcome] = key.split(":");
    const sorted = [...fills].sort((a, b) => a.timestamp - b.timestamp);

    let size = 0;
    let avgCost = 0;
    let events: PositionEvent[] = [];
    let openedAt = 0;
    let incompleteHistory = false;

    const closeCycle = (closedAt: number | null) => {
      const realizedPnl = events.reduce((s, e) => s + e.realizedPnlDelta, 0);
      positions.push({
        walletAddress,
        conditionId,
        outcome,
        events,
        openedAt,
        closedAt,
        finalSize: size,
        avgCost,
        realizedPnl,
        holdDurationSeconds: closedAt !== null ? closedAt - openedAt : null,
        incompleteHistory,
      });
    };

    for (const fill of sorted) {
      if (fill.side === "BUY") {
        if (size === 0) {
          openedAt = fill.timestamp;
          events = [];
          incompleteHistory = false;
          avgCost = 0;
        }
        const newSize = size + fill.size;
        avgCost = (size * avgCost + fill.size * fill.price) / newSize;
        size = newSize;
        const kind: PositionEventKind = events.length === 0 ? "opened" : "increased";
        events.push({
          kind,
          timestamp: fill.timestamp,
          sizeDelta: fill.size,
          price: fill.price,
          positionSizeAfter: size,
          avgCostAfter: avgCost,
          realizedPnlDelta: 0,
        });
        continue;
      }

      // SELL
      if (size === 0) {
        // No tracked position to sell from — either a short (not a real
        // mechanic for these markets) or, far more likely, this wallet
        // already held shares before the pulled activity window began.
        // Open a synthetic cycle at zero cost basis so this fill has
        // somewhere to go, but flag it: realizedPnl on this cycle is not
        // trustworthy (it'll look like pure profit, an artifact of the
        // missing basis, not a real edge).
        openedAt = fill.timestamp;
        events = [];
        incompleteHistory = true;
        avgCost = 0;
        size = fill.size;
      }
      const sellSize = Math.min(fill.size, size);
      const overSize = fill.size - sellSize;
      if (overSize > 1e-9) incompleteHistory = true; // sold more than this reconstruction ever saw bought
      const realizedPnlDelta = sellSize * (fill.price - avgCost);
      size = size - sellSize;
      const kind: PositionEventKind = size === 0 ? "closed" : "reduced";
      events.push({
        kind,
        timestamp: fill.timestamp,
        sizeDelta: -fill.size,
        price: fill.price,
        positionSizeAfter: size,
        avgCostAfter: avgCost,
        realizedPnlDelta,
      });
      if (size === 0) {
        closeCycle(fill.timestamp);
        avgCost = 0;
      }
    }

    if (size > 0) {
      closeCycle(null); // still open as of the dataset cutoff
    }
  }

  return positions.sort((a, b) => a.openedAt - b.openedAt);
}

// A crude but useful hedging signal: two positions on the SAME market but
// OPPOSITE outcomes with overlapping open windows. Doesn't distinguish a
// deliberate hedge from e.g. correcting a mis-click, but flags the pattern
// for a human (or wallet scoring) to look at rather than silently ignoring
// it, per the "hedging behavior / opposing-outcome purchases" ask.
export interface HedgeSignal {
  conditionId: string;
  outcomeA: string;
  outcomeB: string;
  overlapStart: number;
  overlapEnd: number;
}

export function detectHedges(positions: ReconstructedPosition[]): HedgeSignal[] {
  const byMarket = new Map<string, ReconstructedPosition[]>();
  for (const p of positions) {
    if (!byMarket.has(p.conditionId)) byMarket.set(p.conditionId, []);
    byMarket.get(p.conditionId)!.push(p);
  }

  const hedges: HedgeSignal[] = [];
  for (const group of byMarket.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.outcome === b.outcome) continue;
        const aEnd = a.closedAt ?? Infinity;
        const bEnd = b.closedAt ?? Infinity;
        const overlapStart = Math.max(a.openedAt, b.openedAt);
        const overlapEnd = Math.min(aEnd, bEnd);
        if (overlapStart < overlapEnd) {
          hedges.push({ conditionId: a.conditionId, outcomeA: a.outcome, outcomeB: b.outcome, overlapStart, overlapEnd });
        }
      }
    }
  }
  return hedges;
}
