// Reusable backtest engine: turns a wallet's raw activity into BacktestTrial[]
// under a chosen resolution treatment, then hands off to statistics.ts for
// the actual numbers. Two treatments, matching the "compare copy styles"
// ask in docs/AUDIT.md:
//
// - "hold-to-resolution": every BUY fill is its own independent trial, held
//   to the market's final outcome regardless of whether the wallet itself
//   sold early. This is the project's original methodology (walletBacktest.ts
//   pre-Phase-2) — simple, conservative, but blind to the wallet's real exit
//   behavior.
// - "mirror-exit": uses position reconstruction (src/backtesting/
//   positionReconstruction.ts) so a trial's P&L reflects the wallet's ACTUAL
//   entries and exits. A cycle still open when the underlying market has
//   already settled is force-resolved at the settlement price (the wallet
//   just never got around to selling); a cycle still open on a still-active
//   market is excluded — there's no resolved P&L to report yet.

import { getMarketByConditionId, type Activity, type GammaMarket } from "../api/client";
import { categorize } from "../categorize";
import { reconstructPositions } from "./positionReconstruction";
import type { BacktestConfig, BacktestTrial } from "../domain/types";

function eventKeyFor(a: Activity): string {
  return a.eventSlug && a.eventSlug.length > 0 ? a.eventSlug : a.slug;
}

// Fee taken off the stake before it buys shares; slippage worsens the price
// actually paid. Both are simple proportional models, not an order-book
// simulation — see src/backtesting/followerExecution.ts for the
// higher-fidelity (but far more API-expensive) version of "what price would
// a delayed follower actually get."
function applyCosts(usdcStaked: number, entryPrice: number, config: BacktestConfig): { shares: number; effectivePrice: number } {
  const effectivePrice = Math.min(1, entryPrice * (1 + config.slippageBps / 10_000));
  const effectiveStake = usdcStaked * (1 - config.feeBps / 10_000);
  const shares = effectivePrice > 0 ? effectiveStake / effectivePrice : 0;
  return { shares, effectivePrice };
}

const marketCache = new Map<string, GammaMarket | null>();
async function resolveMarket(conditionId: string): Promise<GammaMarket | null> {
  if (marketCache.has(conditionId)) return marketCache.get(conditionId)!;
  let market = await getMarketByConditionId(conditionId, true);
  if (!market) market = await getMarketByConditionId(conditionId, false);
  marketCache.set(conditionId, market);
  return market;
}

function outcomeWon(market: GammaMarket, outcome: string): boolean | null {
  const outcomes: string[] = JSON.parse(market.outcomes ?? "[]");
  const finalPrices: number[] = JSON.parse(market.outcomePrices ?? "[]").map(Number);
  const idx = outcomes.indexOf(outcome);
  if (idx === -1 || finalPrices[idx] === undefined) return null;
  return finalPrices[idx] > 0.5;
}

async function buildHoldToResolutionTrials(walletAddress: string, activity: Activity[], config: BacktestConfig): Promise<BacktestTrial[]> {
  const buys = activity.filter((a) => a.type === "TRADE" && a.side === "BUY" && a.timestamp <= config.datasetCutoff);
  const trials: BacktestTrial[] = [];
  const uniqueConditionIds = [...new Set(buys.map((b) => b.conditionId))];

  for (const conditionId of uniqueConditionIds) {
    const market = await resolveMarket(conditionId);
    if (!market || !market.closed) continue;

    for (const b of buys.filter((x) => x.conditionId === conditionId)) {
      const won = outcomeWon(market, b.outcome);
      if (won === null) continue;
      const { shares } = applyCosts(b.usdcSize, b.price, config);
      const payout = won ? shares : 0;
      trials.push({
        walletAddress,
        conditionId,
        outcome: b.outcome,
        eventKey: eventKeyFor(b),
        category: categorize(b.title),
        entryTimestamp: b.timestamp,
        entryPrice: b.price,
        usdcStaked: b.usdcSize,
        shares,
        resolved: true,
        won,
        netReturn: payout - b.usdcSize,
      });
    }
  }
  return trials;
}

async function buildMirrorExitTrials(walletAddress: string, activity: Activity[], config: BacktestConfig): Promise<BacktestTrial[]> {
  const cutoffActivity = activity.filter((a) => a.timestamp <= config.datasetCutoff);
  const positions = reconstructPositions(walletAddress, cutoffActivity);

  // Per-(conditionId,outcome) metadata for event/category/title lookup —
  // position reconstruction deliberately doesn't carry this (see its file
  // header), so it's looked up from the original activity here instead.
  const metaByMarket = new Map<string, Activity>();
  for (const a of cutoffActivity) {
    if (a.type !== "TRADE") continue;
    const key = `${a.conditionId} ${a.outcome}`;
    if (!metaByMarket.has(key)) metaByMarket.set(key, a);
  }

  const trials: BacktestTrial[] = [];
  for (const pos of positions) {
    const meta = metaByMarket.get(`${pos.conditionId} ${pos.outcome}`);
    if (!meta) continue; // shouldn't happen — every position came from this same activity set

    let realizedPnl = pos.realizedPnl;
    let resolved = pos.closedAt !== null;

    if (!resolved) {
      // Still open per the fills alone — check whether the underlying
      // market has already settled anyway (the wallet just never sold).
      const market = await resolveMarket(pos.conditionId);
      if (market?.closed) {
        const won = outcomeWon(market, pos.outcome);
        if (won !== null) {
          const settlementPrice = won ? 1 : 0;
          realizedPnl += pos.finalSize * (settlementPrice - pos.avgCost);
          resolved = true;
        }
      }
    }
    if (!resolved) continue; // genuinely unresolved — no P&L to report yet

    const totalStaked = pos.events.filter((e) => e.sizeDelta > 0).reduce((s, e) => s + e.sizeDelta * e.price, 0);
    trials.push({
      walletAddress,
      conditionId: pos.conditionId,
      outcome: pos.outcome,
      eventKey: eventKeyFor(meta),
      category: categorize(meta.title),
      entryTimestamp: pos.openedAt,
      entryPrice: pos.avgCost,
      usdcStaked: totalStaked,
      shares: pos.finalSize,
      resolved: true,
      won: realizedPnl > 0,
      netReturn: realizedPnl,
    });
  }
  return trials;
}

export async function buildTrials(walletAddress: string, activity: Activity[], config: BacktestConfig): Promise<BacktestTrial[]> {
  if (config.resolutionTreatment === "hold-to-resolution") {
    return buildHoldToResolutionTrials(walletAddress, activity, config);
  }
  return buildMirrorExitTrials(walletAddress, activity, config);
}

export function defaultBacktestConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    strategyName: "wallet-copy",
    strategyVersion: "2.0.0",
    datasetCutoff: Math.floor(Date.now() / 1000),
    walletAddresses: [],
    entryRule: "copy every BUY fill at the wallet's real fill price",
    exitRule: "hold to resolution",
    observationDelaySeconds: 0,
    executionDelaySeconds: 0,
    feeBps: 0,
    slippageBps: 0,
    resolutionTreatment: "hold-to-resolution",
    ...overrides,
  };
}
