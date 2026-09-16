// Polymarket CLOB market WebSocket — Track E.15's confirmed-viable
// replacement for snapshotCollector.ts's REST polling (see
// docs/DEPTH_SHIFT_STRATEGY_SCOPE.md §6). Every shape below is confirmed
// live 2026-09-15 against the real production endpoint for a real,
// currently-open BTC Up-or-Down market — not transcribed from docs alone
// (docs.polymarket.com's own examples omit `event_type`, `tick_size`, and
// `last_trade_price` on the `book` message, all present on the real
// payload). Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
// — public, unauthenticated, same posture as every REST endpoint this
// project already calls.
//
// CONFIRMED LIVE, THIS PASS:
// - `book` (initial + on re-subscribe): full bid/ask ladder for one asset.
// - `price_change`: one message's `price_changes` array can carry entries
//   for BOTH outcome tokens of a market (Up and Down), even when only one
//   was subscribed — this file only applies entries for asset_ids the
//   caller is actually tracking, matching the old REST collector's
//   Up-token-only scope; Down-token entries are silently dropped, a
//   real, cheap-to-lift scope choice, not a bug.
// - Each `price_changes` entry is the ABSOLUTE new size at (price, side),
//   not a delta to add/subtract — `side:"BUY"` is a bid-side level,
//   `side:"SELL"` is an ask-side level (matches `book`'s bids/asks split).
//   size="0" means the level emptied out (remove it) — confirmed live by
//   capturing a real size="0" entry and observing it always paired with a
//   real best_bid/best_ask that no longer reflects that price level.
// - Sending `{"operation":"subscribe","assets_ids":[...],...}` on an
//   ALREADY-OPEN connection adds an asset and triggers a fresh `book`
//   snapshot for it, confirmed live — no reconnect needed for the
//   15-minute market rollover this collector has to handle continuously.
// - 10s client-driven `"PING"` text frame, server replies literal
//   `"PONG"` text (not JSON) — confirmed live.

import { z } from "zod";

const BookLevelSchema = z.object({ price: z.string(), size: z.string() });

export const BookMessageSchema = z
  .object({
    event_type: z.literal("book"),
    market: z.string(),
    asset_id: z.string(),
    bids: z.array(BookLevelSchema),
    asks: z.array(BookLevelSchema),
  })
  .passthrough();
export type BookMessage = z.infer<typeof BookMessageSchema>;

const PriceChangeEntrySchema = z
  .object({
    asset_id: z.string(),
    price: z.string(),
    size: z.string(),
    side: z.enum(["BUY", "SELL"]),
    best_bid: z.string().optional(),
    best_ask: z.string().optional(),
  })
  .passthrough();

export const PriceChangeMessageSchema = z
  .object({
    event_type: z.literal("price_change"),
    market: z.string(),
    price_changes: z.array(PriceChangeEntrySchema),
  })
  .passthrough();
export type PriceChangeMessage = z.infer<typeof PriceChangeMessageSchema>;

// Every other event_type this project has seen (`last_trade_price`, and,
// docs-only/not seen live, `tick_size_change`/`best_bid_ask`/`new_market`/
// `market_resolved`) is irrelevant to order-book state and deliberately
// not modeled here — parseMarketMessages returns null for anything that
// isn't `book` or `price_change`, and callers skip nulls.
export type MarketMessage = { type: "book"; message: BookMessage } | { type: "price_change"; message: PriceChangeMessage };

// A raw WS text frame can be "PONG" (the heartbeat reply, not JSON) or a
// JSON message — never both, and PONG is checked for before this is
// called. Defensively unwraps a top-level array in case Polymarket ever
// batches messages that way (not confirmed to happen live this pass, but
// cheap to handle either shape).
export function parseMarketMessages(raw: string): MarketMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: MarketMessage[] = [];
  for (const item of arr) {
    const book = BookMessageSchema.safeParse(item);
    if (book.success) {
      out.push({ type: "book", message: book.data });
      continue;
    }
    const priceChange = PriceChangeMessageSchema.safeParse(item);
    if (priceChange.success) out.push({ type: "price_change", message: priceChange.data });
  }
  return out;
}

// ---------------------------------------------------------------------
// Pure in-memory book state — no network here, fully unit-testable.
// ---------------------------------------------------------------------

export interface BookState {
  assetId: string;
  bids: Map<string, number>; // price (as the server's own string key, avoids float rounding making two prices collide or fail to) -> size
  asks: Map<string, number>;
}

export function createBookState(msg: BookMessage): BookState {
  const bids = new Map<string, number>();
  const asks = new Map<string, number>();
  for (const level of msg.bids) bids.set(level.price, Number(level.size));
  for (const level of msg.asks) asks.set(level.price, Number(level.size));
  return { assetId: msg.asset_id, bids, asks };
}

// Applies one price_changes entry IN PLACE if it belongs to this state's
// asset — callers filter by asset_id before calling, matching this file's
// "only track subscribed assets" scope (see file header).
export function applyPriceChangeEntry(state: BookState, entry: z.infer<typeof PriceChangeEntrySchema>): void {
  const book = entry.side === "BUY" ? state.bids : state.asks;
  const size = Number(entry.size);
  if (size === 0) book.delete(entry.price);
  else book.set(entry.price, size);
}

export interface BookLevels {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bestBid: { price: number; size: number } | null;
  bestAsk: { price: number; size: number } | null;
}

// Bids sorted highest-first, asks lowest-first — the natural "best price
// first" ladder order, not required by any downstream consumer today (see
// the rewrite's commit for what was checked) but the more useful default
// for a future strategy reading this JSON back.
export function toBookLevels(state: BookState): BookLevels {
  const bids = [...state.bids.entries()].map(([price, size]) => ({ price: Number(price), size })).sort((a, b) => b.price - a.price);
  const asks = [...state.asks.entries()].map(([price, size]) => ({ price: Number(price), size })).sort((a, b) => a.price - b.price);
  return { bids, asks, bestBid: bids[0] ?? null, bestAsk: asks[0] ?? null };
}
