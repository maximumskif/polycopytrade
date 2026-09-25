// Runtime validation for every Polymarket API response this project
// consumes. Previously (see docs/AUDIT.md §2) every response was cast
// straight from `res.json()` to a TypeScript type with zero runtime check —
// a renamed/retyped field would either crash deep in unrelated code or,
// worse, silently produce wrong numbers. Types are inferred from these
// schemas (`z.infer`) so validation and typing can't drift apart.
//
// Some fields are intentionally optional even though they look like they
// should always be present — confirmed by prior testing (see
// ladderScanner.ts) that certain market shapes returned by search (e.g.
// negRisk/grouped sub-markets) omit outcomes/outcomePrices/volume entirely.
// Making those required here would make otherwise-valid responses fail
// validation.

import { z } from "zod";

// `side` and `type` are loosely typed on purpose: confirmed against real
// data that non-trade activity rows (e.g. type "REWARD" for a liquidity
// reward payout) carry side="" and empty conditionId/outcome/title —
// structurally valid, just not a trade. Every caller that cares about
// BUY/SELL semantics already filters on `type === "TRADE"` first (that
// filtering was implicit/untested before; see tests/activity.test.ts).
// Constraining `side` to an enum here would reject real API responses.
export const ActivitySchema = z.object({
  timestamp: z.number(),
  conditionId: z.string(),
  type: z.string(),
  size: z.number(),
  usdcSize: z.number(),
  price: z.number(),
  side: z.string(),
  outcome: z.string(),
  title: z.string(),
  slug: z.string(),
  // The event a market belongs to (e.g. every WTI-ladder rung market for
  // one month shares one eventSlug) — not in the original interface, found
  // by inspecting a real payload while building Phase 2's event-level
  // grouping (docs/AUDIT.md §7: fill/market counts overstate independent
  // sample size when many markets move together as one real-world event).
  // Optional: not confirmed present on every activity type (e.g. REWARD
  // rows), so a missing field shouldn't fail validation.
  eventSlug: z.string().optional(),
  proxyWallet: z.string(),
  transactionHash: z.string(),
});
export type Activity = z.infer<typeof ActivitySchema>;
export const ActivityResponseSchema = z.array(ActivitySchema);

export const GammaMarketSchema = z.object({
  id: z.string(),
  conditionId: z.string(),
  question: z.string(),
  slug: z.string(),
  outcomes: z.string().optional(),
  outcomePrices: z.string().optional(),
  clobTokenIds: z.string().optional(),
  startDate: z.string().optional(),
  // Optional, like the other fields above: confirmed against real /markets
  // responses (Phase 2 follow-up, 2026-08-14) that some markets — seen on
  // wallets sourced from the monthly leaderboard — omit endDate entirely.
  // Nothing in src/backtesting/ reads GammaMarket.endDate (resolution uses
  // outcomePrices), so making it required here only broke validation for
  // no downstream benefit.
  endDate: z.string().optional(),
  closed: z.boolean(),
  // "resolved" once UMA settlement is final (seen live 2026-09-24; other
  // values include "proposed"/"disputed"). Read only by
  // src/api/cachePolicy.ts's isFinalizedMarket -- nullable/optional since
  // older markets may not carry it.
  umaResolutionStatus: z.string().nullable().optional(),
  // When the market actually closed (seen live 2026-09-25 as
  // "2026-09-25 04:43:35+00" -- not ISO), which can be a week before its
  // scheduled endDate (tennis). Read only by the K5 positions screen
  // (src/scoring/positionsScreen.ts) to window unredeemed positions.
  closedTime: z.string().nullable().optional(),
  volume: z.string().optional(),
  liquidity: z.string().optional(),
});
export type GammaMarket = z.infer<typeof GammaMarketSchema>;
export const MarketsLookupResponseSchema = z.array(GammaMarketSchema);

export const GammaEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  // Optional for the same reason as GammaMarket.endDate above: confirmed
  // against real /public-search responses (strategy-fork sourcing round,
  // 2026-08-17) that some events omit endDate/liquidity entirely.
  endDate: z.string().optional(),
  volume: z.number().optional(),
  liquidity: z.number().optional(),
  // Confirmed present on a real /events?order=volume24hr response
  // (2026-09-15, wallet-sourcing track) — optional since only relevant to
  // that one active-markets-by-recent-volume query, not every /events call.
  volume24hr: z.number().optional(),
  markets: z.array(GammaMarketSchema).nullable().optional(),
});
export type GammaEvent = z.infer<typeof GammaEventSchema>;

const ProfileSchema = z.object({
  name: z.string(),
  proxyWallet: z.string(),
});

export const PublicSearchResponseSchema = z.object({
  events: z.array(GammaEventSchema).nullable().optional(),
  profiles: z.array(ProfileSchema).nullable().optional(),
});

export const GammaEventsResponseSchema = z.array(GammaEventSchema);

export const PricesHistoryResponseSchema = z.object({
  history: z.array(z.object({ t: z.number(), p: z.number() })).optional(),
});

const OrderBookLevelSchema = z.object({ price: z.string(), size: z.string() });
export const OrderBookSchema = z.object({
  market: z.string(),
  asset_id: z.string(),
  bids: z.array(OrderBookLevelSchema).optional(),
  asks: z.array(OrderBookLevelSchema).optional(),
});
export type OrderBook = z.infer<typeof OrderBookSchema>;

// data-api's /v1/leaderboard — confirmed against docs.polymarket.com's
// published reference (2026-09-13), not tested against a live call before
// first use (same doc-sourced-not-tested caveat as src/markets/solana/*).
// userName/xUsername optional: a wallet can rank with display fields unset.
export const LeaderboardEntrySchema = z.object({
  rank: z.string(),
  proxyWallet: z.string(),
  userName: z.string().nullable().optional(),
  vol: z.number(),
  pnl: z.number(),
  xUsername: z.string().nullable().optional(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;
export const LeaderboardResponseSchema = z.array(LeaderboardEntrySchema);

// data-api's /holders — confirmed by a real live call, 2026-09-15 (see
// docs/IMPROVEMENT_PLAN.md's wallet-sourcing track): `market=<conditionId>`
// is required (a bare `user`-only /positions-style query 400s asking for
// `market`); returns one group per outcome token, each pre-sorted
// descending by `amount` (outcome-token share count, NOT USD — a holder's
// real dollar stake is amount*price, not reported directly here).
export const HolderSchema = z.object({
  proxyWallet: z.string(),
  amount: z.number(),
  name: z.string().nullable().optional(),
  pseudonym: z.string().nullable().optional(),
  outcomeIndex: z.number().optional(),
});
export type Holder = z.infer<typeof HolderSchema>;
export const HoldersGroupSchema = z.object({
  token: z.string(),
  holders: z.array(HolderSchema),
});
export type HoldersGroup = z.infer<typeof HoldersGroupSchema>;
// Confirmed live 2026-09-15 (wallet-sourcing track): a market close to
// resolution (all outcome tokens already fully settled/redeemed) returns a
// bare `null` body instead of `[]` -- normalized to an empty array here so
// callers don't need their own null check for what's really just "no
// holders left to report."
export const HoldersResponseSchema = z
  .array(HoldersGroupSchema)
  .nullable()
  .transform((v) => v ?? []);

// data-api's /closed-positions (K5, 2026-09-25; checked live that day):
// max 50 rows per page, offset paging, sortBy=TIMESTAMP newest first.
// `totalBought` is SHARES bought (not USD) and `avgPrice` the buy-weighted
// average price -- both matched a wallet's own BUY fills exactly -- so the
// cost basis is totalBought*avgPrice. `curPrice` is the market's current
// price: 1/0 once settled, a live price for a position closed by
// selling/merging on a still-open market. `timestamp` is when the position
// closed (after its last fill), not when it opened. Only fields the
// positions screen reads are required.
export const ClosedPositionSchema = z.object({
  conditionId: z.string(),
  asset: z.string().optional(),
  avgPrice: z.number(),
  totalBought: z.number(),
  realizedPnl: z.number(),
  curPrice: z.number(),
  timestamp: z.number(),
  title: z.string(),
  slug: z.string(),
  eventSlug: z.string().nullable().optional(),
  outcome: z.string(),
  outcomeIndex: z.number().optional(),
  endDate: z.string().nullable().optional(),
});
export type ClosedPosition = z.infer<typeof ClosedPositionSchema>;
export const ClosedPositionsResponseSchema = z.array(ClosedPositionSchema);

// data-api's /positions (K5): the wallet's CURRENT holdings. The positions
// screen needs it because /closed-positions is survivorship-biased (found
// live 2026-09-25): a resolved position the wallet never redeemed stays
// here (redeemable=true), and losers are rarely redeemed -- one wallet had
// 0 "lone" losers among 200 closed positions but 1000+ unredeemed curPrice=0
// positions here. No timestamp field; `endDate` is the market's scheduled
// end, and sortBy=RESOLVING orders by it.
export const OpenPositionSchema = z.object({
  conditionId: z.string(),
  asset: z.string().optional(),
  avgPrice: z.number(),
  totalBought: z.number(),
  size: z.number(),
  realizedPnl: z.number().optional(),
  curPrice: z.number(),
  redeemable: z.boolean().optional(),
  title: z.string(),
  slug: z.string(),
  eventSlug: z.string().nullable().optional(),
  outcome: z.string(),
  outcomeIndex: z.number().optional(),
  endDate: z.string().nullable().optional(),
});
export type OpenPosition = z.infer<typeof OpenPositionSchema>;
export const OpenPositionsResponseSchema = z.array(OpenPositionSchema);

// data-api /trades?market=<conditionId> rows (checked live 2026-09-25):
// newest first, offset paging (works past 10K), start/end honored, taker
// fills only by default. Used by the early-movers sourcing channel.
export const MarketTradeSchema = z.looseObject({
  proxyWallet: z.string(),
  side: z.enum(["BUY", "SELL"]),
  asset: z.string(),
  conditionId: z.string(),
  size: z.number(),
  price: z.number(),
  timestamp: z.number(),
  outcome: z.string().optional(),
  outcomeIndex: z.number().optional(),
  slug: z.string().optional(),
  eventSlug: z.string().optional(),
  title: z.string().optional(),
  name: z.string().nullable().optional(),
  pseudonym: z.string().nullable().optional(),
});
export type MarketTrade = z.infer<typeof MarketTradeSchema>;
export const MarketTradesResponseSchema = z.array(MarketTradeSchema);
