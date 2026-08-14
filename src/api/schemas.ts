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

export const PositionSchema = z.object({
  proxyWallet: z.string(),
  asset: z.string(),
  conditionId: z.string(),
  size: z.number(),
  avgPrice: z.number(),
  curPrice: z.number(),
  currentValue: z.number(),
  cashPnl: z.number(),
  percentPnl: z.number(),
  realizedPnl: z.number(),
  title: z.string(),
  slug: z.string(),
  outcome: z.string(),
  endDate: z.string(),
});
export type Position = z.infer<typeof PositionSchema>;
export const PositionsResponseSchema = z.array(PositionSchema);

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
  endDate: z.string(),
  closed: z.boolean(),
  volume: z.string().optional(),
  liquidity: z.string().optional(),
});
export type GammaMarket = z.infer<typeof GammaMarketSchema>;
export const MarketsLookupResponseSchema = z.array(GammaMarketSchema);

export const GammaEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  endDate: z.string(),
  volume: z.number(),
  liquidity: z.number(),
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

export const PricesHistoryResponseSchema = z.object({
  history: z.array(z.object({ t: z.number(), p: z.number() })).optional(),
});
