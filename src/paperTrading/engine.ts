// Phase 3 paper-trading engine: watches a wallet's real fills as they're
// ingested by the tracking daemon and simulates a delayed, fixed-stake
// follower copying them, with no real capital ever at risk. Two steps,
// run every tracking-daemon cycle (src/tracking/trackDaemon.ts):
//
// 1. processNewFills — turn newly-seen leader BUY fills into paper orders,
//    at the follower's real observed entry price `delaySeconds` later.
// 2. resolveOpenOrders — check open paper orders against now-closed
//    markets and book their P&L.
//
// Deliberately reuses this project's existing resolution/price-lookup
// logic (resolveMarket/outcomeWon from src/backtesting/engine.ts,
// tokenIdForOutcome/priceAtOrAfter from
// src/backtesting/followerExecution.ts) rather than re-deriving it — see
// docs/AUDIT.md's §4 lesson about the cost of two independent
// implementations of the same math drifting apart.

import { getPricesHistory } from "../api/client";
import { categorize } from "../research/categorize";
import { resolveMarket, outcomeWon } from "../backtesting/engine";
import { tokenIdForOutcome, priceAtOrAfter } from "../backtesting/followerExecution";
import { listUncopiedBuyFills, insertPaperOrder, listOpenPaperOrders, resolvePaperOrder } from "../storage/repository";
import type { NewPaperOrder } from "../domain/types";
import { PAPER_TRADE_TARGETS, type PaperTradeTarget } from "./config";

export interface ProcessNewFillsResult {
  examined: number; // uncopied fills seen this cycle, after the category filter
  filled: number; // turned into a paper order with a real follower entry price
  unresolvable: number; // turned into a paper order with no observable price (never retried)
}

export async function processNewFills(target: PaperTradeTarget): Promise<ProcessNewFillsResult> {
  const uncopied = listUncopiedBuyFills(target.address);
  let candidates = target.categoryFilter ? uncopied.filter((f) => categorize(f.title) === target.categoryFilter) : uncopied;
  if (target.excludeTitleKeywords?.length) {
    const excluded = target.excludeTitleKeywords.map((k) => k.toLowerCase());
    candidates = candidates.filter((f) => !excluded.some((k) => f.title.toLowerCase().includes(k)));
  }
  if (target.minLeaderStakeUsdc != null) {
    candidates = candidates.filter((f) => f.usdcSize >= target.minLeaderStakeUsdc!);
  }

  let filled = 0;
  let unresolvable = 0;

  for (const fill of candidates) {
    const market = await resolveMarket(fill.conditionId);
    if (!market) continue; // transient lookup failure — leave uncopied, retried next cycle

    const category = categorize(fill.title);
    const base: Omit<NewPaperOrder, "followerEntryPrice" | "filledAt" | "status"> = {
      walletAddress: target.address,
      sourceActivityId: fill.id,
      conditionId: fill.conditionId,
      outcome: fill.outcome,
      category,
      leaderPrice: fill.price,
      leaderTimestamp: fill.timestamp,
      stakeUsdc: target.stakeUsdc,
      delaySeconds: target.delaySeconds,
    };

    const tokenId = tokenIdForOutcome(market, fill.outcome);
    if (!tokenId) {
      insertPaperOrder({ ...base, followerEntryPrice: null, filledAt: null, status: "unresolvable" });
      unresolvable++;
      continue;
    }

    const res = await getPricesHistory(tokenId, fill.timestamp - 30, fill.timestamp + target.delaySeconds + 60, 1);
    const history = res.history ?? [];
    const followerPrice = priceAtOrAfter(history, fill.timestamp + target.delaySeconds);

    if (followerPrice == null) {
      insertPaperOrder({ ...base, followerEntryPrice: null, filledAt: null, status: "unresolvable" });
      unresolvable++;
    } else {
      insertPaperOrder({ ...base, followerEntryPrice: followerPrice, filledAt: fill.timestamp + target.delaySeconds, status: "filled" });
      filled++;
    }
  }

  return { examined: candidates.length, filled, unresolvable };
}

export async function resolveOpenOrders(): Promise<{ resolved: number }> {
  const open = listOpenPaperOrders();
  let resolved = 0;

  for (const order of open) {
    const market = await resolveMarket(order.conditionId);
    if (!market?.closed) continue;

    const won = outcomeWon(market, order.outcome);
    if (won === null) continue; // shouldn't happen for a closed market, but don't guess if it does

    const followerEntryPrice = order.followerEntryPrice as number; // always set for status 'filled'
    const payoutUsdc = won ? order.stakeUsdc / followerEntryPrice : 0;
    const pnlUsdc = payoutUsdc - order.stakeUsdc;
    resolvePaperOrder(order.id, won ? "won" : "lost", payoutUsdc, pnlUsdc);
    resolved++;
  }

  return { resolved };
}

export async function runPaperTradingCycle(): Promise<void> {
  for (const target of PAPER_TRADE_TARGETS) {
    const result = await processNewFills(target);
    if (result.examined > 0) {
      console.log(`[paper-trading] ${target.label}: ${result.filled} filled, ${result.unresolvable} unresolvable (of ${result.examined} new fills)`);
    }
  }
  const { resolved } = await resolveOpenOrders();
  if (resolved > 0) console.log(`[paper-trading] resolved ${resolved} paper order(s)`);
}
