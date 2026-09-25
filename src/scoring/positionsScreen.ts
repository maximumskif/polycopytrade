// K5 (2026-09-25): a cheaper screening pass for wallet sourcing. The
// activity screen (scoreWalletShallow) pulls 4 pages of /activity and then
// looks up every traded market on gamma to learn how it settled. This
// screen reads settled P&L per position straight from data-api instead:
//
//   1 x /activity (500 newest rows)  -> dormancy + high-frequency median gap
//   N x /closed-positions (50/page)  -> positions the wallet closed/redeemed
//   R x /positions?redeemable=true   -> settled positions it never redeemed
//   G x gamma /markets (batched 50)  -> close time of those unredeemed ones
//
// Gamma is only asked about unredeemed positions near the window, and
// those markets are settled, so the K1 cache keeps them for good. Screening only decides who gets the anchored
// confirmation (walletConfirmation.ts), which is unchanged and still
// authoritative.
//
// Mapping, checked on real data 2026-09-25 (see the K5 commit message):
// `totalBought` is SHARES bought and `avgPrice` their buy-weighted average
// price (both matched the wallet's own BUY fills to 4 decimals), so a
// position is exactly the sum of its BUY fills. Held to resolution, those
// fills return totalBought * (settle - avgPrice) -- the same number
// engine.ts's hold-to-resolution treatment (the activity screen's) sums
// fill by fill. For positions the wallet held to settlement this equals
// the API's own realizedPnl to within rounding. `won` is settle == 1, NOT
// realizedPnl > 0: a wallet that sold a winner early at a loss still picked
// the winning side, and hold-to-resolution scores the side, not the exit.
//
// Positions whose curPrice is not exactly 0 or 1 are left out: that's a
// position closed by selling/merging on a market that hasn't settled yet,
// which the activity screen also skips (market not closed on gamma).
//
// Why /positions too: /closed-positions alone is survivorship-biased. A
// settled position only moves there once redeemed, and losing tokens pay
// nothing, so wallets often never redeem them. On a real wallet 0 of 200
// closed positions were losers without a winning sibling in the same
// market, while /positions held 1000+ unredeemed curPrice=0 positions.
// Without them the screen sees mostly winners.
//
// Windowing them is the subtle part. /positions has no timestamp, only
// the market's SCHEDULED endDate, which can be a week after the market
// actually closed (tennis). The first version windowed by endDate, and on
// a 1-day closed-positions window it pulled in a week+ of unredeemed
// losers: ROI -42.6% where the activity screen saw -16.9% (0x076daa,
// 2026-09-25). So an unredeemed position is kept iff its market's gamma
// closedTime falls inside the window (endDate only as a fallback when
// gamma has no closedTime).
//
// Known differences from the activity screen (documented, not hidden):
// - One trial per POSITION instead of per BUY fill. ROI, the event-
//   clustered CI, concentration and one-shot are unaffected (they sum by
//   event); meetsMinimumSample (>= 20 trials), the per-trial Sharpe/Sortino
//   and election share (a trial count) weight positions, not fills.
// - A closed position's `timestamp` is its close time and an unredeemed
//   one's is the market's scheduled endDate, so drawdown order and the
//   weekly consistency windows use those instead of entry times.
// - The window is "the newest N*50 closed positions" plus unredeemed
//   positions whose market ended inside that window, not "the newest 2000
//   activity rows". Both are non-reproducible newest-first screens.

import { getActivity, getClosedPositions, getRedeemablePositions, type Activity, type ClosedPosition, type OpenPosition } from "../api/client";
import { defaultBacktestConfig, resolveMarkets } from "../backtesting/engine";
import { computeStrategyResult } from "../backtesting/statistics";
import { categorize } from "../research/categorize";
import type { BacktestTrial, WalletScore } from "../domain/types";
import type { TrackedWallet } from "../wallets";
import { computeWalletScore } from "./walletScore";

export const POSITIONS_SCREEN_CLOSED_PAGES = 4;
export const CLOSED_PAGE_SIZE = 50; // the API's max
export const REDEEMABLE_PAGE_SIZE = 500;
export const MAX_REDEEMABLE_PAGES = 4;
export const ACTIVITY_PAGE_SIZE = 500;
const DAY_SECONDS = 86400;
// A market can close well after its scheduled endDate (slow resolution),
// so unredeemed positions are looked up on gamma if their endDate is
// within this slack of the window start.
export const REDEEMABLE_ENDDATE_SLACK_SECONDS = 14 * DAY_SECONDS;

type PositionFields = Pick<ClosedPosition, "conditionId" | "outcome" | "avgPrice" | "totalBought" | "curPrice" | "title" | "slug" | "eventSlug">;

// 1 or 0 once the market has settled; null for a live price.
export function settlementOf(curPrice: number): 0 | 1 | null {
  if (curPrice === 1) return 1;
  if (curPrice === 0) return 0;
  return null;
}

// A position as one hold-to-resolution trial, or null if its market hasn't
// settled or it has no cost basis.
export function positionToTrial(walletAddress: string, p: PositionFields, timestamp: number): BacktestTrial | null {
  const settle = settlementOf(p.curPrice);
  if (settle === null) return null;
  const usdcStaked = p.totalBought * p.avgPrice;
  if (!(usdcStaked > 0)) return null;
  return {
    walletAddress,
    conditionId: p.conditionId,
    outcome: p.outcome,
    eventKey: p.eventSlug && p.eventSlug.length > 0 ? p.eventSlug : p.slug,
    category: categorize(p.title),
    entryTimestamp: timestamp,
    entryPrice: p.avgPrice,
    usdcStaked,
    shares: p.totalBought,
    resolved: true,
    won: settle === 1,
    netReturn: p.totalBought * (settle - p.avgPrice),
  };
}

// "2026-09-24" or an ISO timestamp -> unix seconds; null if missing/unparseable.
export function endDateTs(endDate: string | null | undefined): number | null {
  if (!endDate) return null;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// gamma's closedTime ("2026-09-25 04:43:35+00", not ISO) -> unix seconds.
export function gammaTimeTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.trim().replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export interface PositionTrialsResult {
  trials: BacktestTrial[];
  unsettledSkipped: number;
  redeemableIncluded: number;
}

// `windowStart`: the oldest closed position's timestamp when the closed
// pages ran out before the wallet's history did, else 0 (whole history).
// Unredeemed positions are kept only if their market closed inside the
// window: by `closeTimes` (gamma closedTime, per conditionId) when known,
// else by endDate with one day of slack.
export function buildPositionTrials(
  walletAddress: string,
  closed: ClosedPosition[],
  redeemable: OpenPosition[],
  windowStart: number,
  closeTimes: ReadonlyMap<string, number> = new Map()
): PositionTrialsResult {
  const trials: BacktestTrial[] = [];
  const seen = new Set<string>();
  let unsettledSkipped = 0;
  let redeemableIncluded = 0;
  for (const p of closed) {
    const key = `${p.conditionId}:${p.outcome}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const trial = positionToTrial(walletAddress, p, p.timestamp);
    if (trial) trials.push(trial);
    else if (settlementOf(p.curPrice) === null) unsettledSkipped++;
  }
  for (const p of redeemable) {
    const key = `${p.conditionId}:${p.outcome}`;
    if (seen.has(key)) continue;
    const endTs = endDateTs(p.endDate);
    const closeTs = closeTimes.get(p.conditionId) ?? null;
    if (windowStart > 0) {
      const inWindow = closeTs !== null ? closeTs >= windowStart : endTs !== null && endTs + DAY_SECONDS >= windowStart;
      if (!inWindow) continue;
    }
    seen.add(key);
    const trial = positionToTrial(walletAddress, p, closeTs ?? endTs ?? windowStart);
    if (trial) {
      trials.push(trial);
      redeemableIncluded++;
    } else if (settlementOf(p.curPrice) === null) unsettledSkipped++;
  }
  return { trials, unsettledSkipped, redeemableIncluded };
}

export function windowStartOf(closed: ClosedPosition[], closedExhausted: boolean): number {
  if (closedExhausted || closed.length === 0) return 0;
  return Math.min(...closed.map((p) => p.timestamp));
}

// Pure: everything computeWalletScore needs, from already-fetched pages.
export function scoreFromPositions(
  wallet: { address: string; label: string },
  activity: Activity[],
  closed: ClosedPosition[],
  redeemable: OpenPosition[],
  closedExhausted: boolean,
  closeTimes: ReadonlyMap<string, number> = new Map(),
  nowSeconds = Math.floor(Date.now() / 1000)
): { score: WalletScore; trials: BacktestTrial[]; windowStart: number; unsettledSkipped: number; redeemableIncluded: number } {
  const windowStart = windowStartOf(closed, closedExhausted);
  const { trials, unsettledSkipped, redeemableIncluded } = buildPositionTrials(wallet.address, closed, redeemable, windowStart, closeTimes);
  const config = defaultBacktestConfig({
    strategyName: "wallet-copy-positions-screen",
    walletAddresses: [wallet.address],
    datasetCutoff: nowSeconds,
    entryRule: "one trial per settled position at the wallet's average buy price (data-api closed + unredeemed positions)",
  });
  const strategyResult = computeStrategyResult(trials, config);
  const score = computeWalletScore(wallet, activity, trials, strategyResult);
  return { score, trials, windowStart, unsettledSkipped, redeemableIncluded };
}

export interface PositionsScreenResult {
  score: WalletScore;
  activity: Activity[];
  trials: BacktestTrial[];
  closedCount: number;
  redeemableCount: number;
  redeemableIncluded: number;
  unsettledSkipped: number;
  windowStart: number;
  dataApiRequests: number;
  gammaLookups: number; // markets asked about (most are K1-cache hits on a re-screen)
  redeemableCapped: boolean; // hit MAX_REDEEMABLE_PAGES while still inside the window
}

export async function scoreWalletPositions(wallet: TrackedWallet, closedPages = POSITIONS_SCREEN_CLOSED_PAGES): Promise<PositionsScreenResult> {
  let requests = 0;
  const activity = await getActivity(wallet.address, { limit: ACTIVITY_PAGE_SIZE });
  requests++;

  const closed: ClosedPosition[] = [];
  let closedExhausted = false;
  for (let page = 0; page < closedPages; page++) {
    const batch = await getClosedPositions(wallet.address, { limit: CLOSED_PAGE_SIZE, offset: page * CLOSED_PAGE_SIZE });
    requests++;
    closed.push(...batch);
    if (batch.length < CLOSED_PAGE_SIZE) {
      closedExhausted = true;
      break;
    }
  }
  const windowStart = windowStartOf(closed, closedExhausted);

  const redeemable: OpenPosition[] = [];
  let redeemableCapped = false;
  for (let page = 0; page < MAX_REDEEMABLE_PAGES; page++) {
    const batch = await getRedeemablePositions(wallet.address, { limit: REDEEMABLE_PAGE_SIZE, offset: page * REDEEMABLE_PAGE_SIZE });
    requests++;
    redeemable.push(...batch);
    if (batch.length < REDEEMABLE_PAGE_SIZE) break;
    const oldestEnd = endDateTs(batch[batch.length - 1].endDate);
    if (windowStart > 0 && oldestEnd !== null && oldestEnd + REDEEMABLE_ENDDATE_SLACK_SECONDS < windowStart) break;
    if (page === MAX_REDEEMABLE_PAGES - 1) redeemableCapped = true;
  }

  // Close times only matter when there's a window to place them in.
  const closeTimes = new Map<string, number>();
  const lookupIds =
    windowStart > 0
      ? redeemable
          .filter((p) => settlementOf(p.curPrice) !== null)
          .filter((p) => {
            const endTs = endDateTs(p.endDate);
            return endTs === null || endTs + REDEEMABLE_ENDDATE_SLACK_SECONDS >= windowStart;
          })
          .map((p) => p.conditionId)
      : [];
  const uniqueLookupIds = [...new Set(lookupIds)];
  if (uniqueLookupIds.length) {
    const markets = await resolveMarkets(uniqueLookupIds);
    for (const [id, market] of markets) {
      const ts = gammaTimeTs(market?.closedTime);
      if (ts !== null) closeTimes.set(id, ts);
    }
  }

  const scored = scoreFromPositions(wallet, activity, closed, redeemable, closedExhausted, closeTimes);
  return {
    score: scored.score,
    activity,
    trials: scored.trials,
    closedCount: closed.length,
    redeemableCount: redeemable.length,
    redeemableIncluded: scored.redeemableIncluded,
    unsettledSkipped: scored.unsettledSkipped,
    windowStart,
    dataApiRequests: requests,
    gammaLookups: uniqueLookupIds.length,
    redeemableCapped,
  };
}
