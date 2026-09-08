// Zod schemas for Helius / Birdeye response shapes.
//
// READ THIS BEFORE TRUSTING ANY FIELD BELOW: every schema here is
// transcribed from published documentation fetched 2026-09-07 (WebFetch
// against helius.dev/docs and data.birdeye.so/docs), NOT confirmed against a
// real authenticated payload. That is the opposite of this project's own
// stated bar for src/api/schemas.ts, where every optional-vs-required call
// cites a specific real response that shaped it (see that file's comments —
// GammaMarket.endDate, GammaEvent.endDate/liquidity/volume were all
// tightened-then-loosened after a REAL response broke an overly-strict
// first draft). No Solana API key is available in this environment, so
// that same "audit against real payloads" pass has not happened yet.
// Every field below is deliberately as loose/optional as plausible given
// that uncertainty, on purpose, learning from the Polymarket lesson above
// rather than repeating it blind: better to accept a response this schema
// doesn't fully anticipate than to throw on a real payload just because a
// docs page didn't mention some field. Phase D (real wallet-scoring
// integration) MUST re-run this against a real key and tighten/fix
// whatever's wrong before anything downstream depends on these shapes.

import { z } from "zod";

// ---------------------------------------------------------------------
// Helius: GET /v0/addresses/{address}/transactions ("Enhanced Transactions")
// ---------------------------------------------------------------------
// Source: helius.dev/docs/enhanced-transactions/overview +
// helius.dev/docs/api-reference/enhanced-transactions/llms.txt (fetched
// 2026-09-07). Helius's own docs flag this whole API family as "a legacy
// product in maintenance mode ... not receiving new parser types or feature
// work" as of this research pass — it still works today, but Helius points
// new integrations at a newer `getTransactionsForAddress` call / "Wallet
// API" instead, neither of which had a public response-schema page found
// during this research pass. Scaffolded against Enhanced Transactions
// anyway because it's the one shape with an actually-documented response at
// the time of writing. Phase D should re-check whether the newer API has
// public docs by then and prefer it if so — don't just assume this file is
// still the right target.

const HeliusTokenTransferSchema = z
  .object({
    fromUserAccount: z.string().optional(),
    toUserAccount: z.string().optional(),
    fromTokenAccount: z.string().optional(),
    toTokenAccount: z.string().optional(),
    tokenAmount: z.number().optional(),
    mint: z.string().optional(),
  })
  .passthrough();

const HeliusNativeTransferSchema = z
  .object({
    fromUserAccount: z.string().optional(),
    toUserAccount: z.string().optional(),
    amount: z.number().optional(),
  })
  .passthrough();

// events.swap is the single most load-bearing piece for future wallet
// scoring — the closest analog to Polymarket's Activity.price/size, i.e.
// "what did this wallet actually buy/sell, at what implied price" — and the
// LEAST confirmed of anything in this file: docs describe field NAMES
// (nativeInput, tokenInputs, tokenOutputs, tokenFees) but the fetched pages
// never showed a full concrete example of this nested object's shape.
// Modeled maximally loosely on purpose; treat every field here as a
// placeholder to verify, not a confirmed contract.
const HeliusSwapTokenAmountSchema = z
  .object({
    userAccount: z.string().optional(),
    tokenAccount: z.string().optional(),
    mint: z.string().optional(),
    rawTokenAmount: z.unknown().optional(),
    tokenAmount: z.number().optional(),
  })
  .passthrough();

const HeliusSwapEventSchema = z
  .object({
    nativeInput: z
      .object({ account: z.string().optional(), amount: z.union([z.string(), z.number()]).optional() })
      .nullable()
      .optional(),
    nativeOutput: z
      .object({ account: z.string().optional(), amount: z.union([z.string(), z.number()]).optional() })
      .nullable()
      .optional(),
    tokenInputs: z.array(HeliusSwapTokenAmountSchema).optional(),
    tokenOutputs: z.array(HeliusSwapTokenAmountSchema).optional(),
    tokenFees: z.array(z.unknown()).optional(),
    nativeFees: z.array(z.unknown()).optional(),
    innerSwaps: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const HeliusTransactionSchema = z
  .object({
    signature: z.string().optional(),
    timestamp: z.number().optional(), // unix seconds, per docs — unconfirmed unit (could be ms; verify against a real payload before trusting math on this)
    type: z.string().optional(), // Helius's own category (e.g. "SWAP", "TRANSFER") — NOT this project's categorize() taxonomy, a different classification problem, see docs/MULTI_MARKET_ARCHITECTURE.md Part 2
    source: z.string().optional(), // e.g. "JUPITER", "RAYDIUM" — which program executed it
    description: z.string().optional(),
    fee: z.number().optional(),
    feePayer: z.string().optional(),
    nativeTransfers: z.array(HeliusNativeTransferSchema).optional(),
    tokenTransfers: z.array(HeliusTokenTransferSchema).optional(),
    events: z
      .object({
        swap: HeliusSwapEventSchema.optional(),
      })
      .partial()
      .optional(),
  })
  // .passthrough(), deliberately not .strict() — see the file header:
  // rejecting unknown fields on a schema this unconfirmed would be actively
  // harmful (this is exactly the mistake src/api/schemas.ts's own comments
  // describe almost happening with Polymarket's REWARD activity rows).
  .passthrough();
export type HeliusTransaction = z.infer<typeof HeliusTransactionSchema>;
export const HeliusTransactionsResponseSchema = z.array(HeliusTransactionSchema);

// ---------------------------------------------------------------------
// Birdeye: GET /wallet/v2/pnl/summary
// ---------------------------------------------------------------------
// Source: the dedicated endpoint-reference page fetched at
// data.birdeye.so/docs/data-api/wallet-networth-pnl/get-wallet-v2-pnl-summary
// (2026-09-07). NOT confirmed against a real payload.
//
// Real, caught-mid-research discrepancy, recorded rather than silently
// resolved: Birdeye's own auto-generated docs index (llms.txt) lists this
// endpoint's path as `/wallet/v2/pnl_summary` (underscore), while the
// dedicated single-endpoint reference page states `/wallet/v2/pnl/summary`
// (slash). client.ts uses the slash form (from the more specific page,
// presumably more authoritative than an auto-generated index) — but this
// is exactly the kind of claim that MUST be checked against a real key
// before anything depends on it. A wrong path here just 404s; it doesn't
// fail loudly in a way a docs read alone would catch.
//
// Numeric fields are typed as `number | string` because the reference
// page's own example schema showed both forms for the same field names —
// mirrors this project's existing tolerance for Polymarket fields that are
// sometimes strings (GammaMarket.volume/liquidity, src/api/schemas.ts)
// rather than assuming one shape and having a real response break it.
const numericField = z.union([z.number(), z.string()]);

export const BirdeyeWalletPnlSummarySchema = z
  .object({
    success: z.boolean(),
    data: z
      .object({
        summary: z
          .object({
            unique_tokens: z.number().optional(),
            counts: z
              .object({
                total_buy: numericField.optional(),
                total_sell: numericField.optional(),
                total_trade: numericField.optional(),
                total_win: numericField.optional(),
                total_loss: numericField.optional(),
                win_rate: numericField.optional(),
              })
              .partial()
              .optional(),
            cashflow_usd: z
              .object({
                total_invested: numericField.optional(),
                total_sold: numericField.optional(),
                current_value: numericField.optional(),
              })
              .partial()
              .optional(),
            pnl: z
              .object({
                realized_profit_usd: numericField.optional(),
                realized_profit_percent: numericField.optional(),
                unrealized_usd: numericField.optional(),
                total_usd: numericField.optional(),
                avg_profit_per_trade_usd: numericField.optional(),
              })
              .partial()
              .optional(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();
export type BirdeyeWalletPnlSummary = z.infer<typeof BirdeyeWalletPnlSummarySchema>;

// Converts a numericField (number|string, possibly absent) to a real JS
// number, mirroring the same JSON.parse(...).map(Number) pattern
// src/backtesting/engine.ts uses for Polymarket's outcomePrices: the schema
// deliberately preserves the raw wire shape rather than coercing inside
// zod, so a caller that needs a real number converts explicitly and a
// genuinely non-numeric string (a real "this API surprised us" bug) shows
// up as `null` here instead of being silently swallowed by a coercion
// schema that always "succeeds."
export function toNumber(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
