// Passive order-book snapshot collector for the depth-shift strategy
// scoping work (docs/DEPTH_SHIFT_STRATEGY_SCOPE.md). Pure data capture --
// no entry/exit rule, no execution. Tracks the currently-open BTC/ETH
// "Up or Down" 15-minute market's "Up" outcome token's order book and
// stores periodic snapshots, so a future session has real data to
// backtest a depth-shift rule against (Polymarket exposes no historical
// order-book endpoint -- this is the only way to ever get any).
//
// REWRITTEN 2026-09-15 (Track E.15, resolving the open question in
// docs/DEPTH_SHIFT_STRATEGY_SCOPE.md §6): was REST-polling `getOrderBook`
// every 5s; now consumes Polymarket's confirmed-live CLOB market
// WebSocket (src/depthShift/clobWebSocket.ts) instead -- push-based,
// sub-second latency, no per-cycle rate-limit cost. Concretely: maintains
// one always-current in-memory book per asset (seeded by the `book`
// snapshot, kept live by `price_change` deltas), and persists a snapshot
// of that live state on a fixed timer, DECOUPLED from message volume --
// live-tested throughput for one token was 5,000-7,000 messages in 20
// seconds during a fast-moving market, so persisting per-message would
// grow the DB roughly 1,000x faster than the old REST cadence for zero
// analytical benefit (a future depth-shift rule reads snapshots taken a
// few seconds apart, not a full tick-by-tick replay). SNAPSHOT_INTERVAL_MS
// below is 2.5x faster than the old 5s poll while keeping DB growth
// bounded and predictable -- a documented engineering choice, not a
// strategy decision, and easy to tighten later since the in-memory state
// is already fully live at sub-second granularity if a future rule needs
// finer sampling.
//
// Deliberately its own small process, not folded into trackDaemon.ts: see
// the original comment below, still true -- this needs its own connection
// and its own concerns (WS reconnect/backoff) entirely distinct from that
// daemon's REST-polling cadence.

import { fetchRaw } from "../api/client";
import { insertOrderbookSnapshot } from "../storage/repository";
import { runMigrations } from "../storage/migrate";
import { sleep, backoffDelayMs } from "../utils/retry";
import { parseMarketMessages, createBookState, applyPriceChangeEntry, toBookLevels, type BookState } from "./clobWebSocket";
import type { GammaMarket } from "../api/schemas";

const ASSETS = ["btc", "eth"] as const;
type Asset = (typeof ASSETS)[number];
const SLOT_SECONDS = 900; // markets run in back-to-back 15-minute windows
const SNAPSHOT_INTERVAL_MS = 2000; // see file header for why this isn't per-message
const ROLLOVER_CHECK_INTERVAL_MS = 5000; // how often to notice a new 15-minute market has opened
const PING_INTERVAL_MS = 10_000; // confirmed live: server expects a literal "PING" text frame every ~10s
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// Pure and deterministic -- these markets run on a fixed schedule, no API
// call needed to find "the current one." Exported for direct testing.
export function currentSlotSlug(asset: Asset, nowSeconds: number): string {
  const slotStart = Math.floor(nowSeconds / SLOT_SECONDS) * SLOT_SECONDS;
  return `${asset}-updown-15m-${slotStart}`;
}

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// gamma-api has no typed slug-lookup helper in api/client.ts yet (every
// existing caller looks markets up by conditionId) -- goes through the
// shared rate-limited/retried fetchRaw escape hatch instead of adding a
// single-use typed wrapper for one caller.
async function findMarketBySlug(slug: string): Promise<GammaMarket | null> {
  const res = (await fetchRaw(`https://gamma-api.polymarket.com/markets?slug=${slug}`)) as unknown[];
  return (res[0] as GammaMarket) ?? null;
}

function resolveUpToken(market: GammaMarket): string | null {
  const outcomes = parseJsonArray(market.outcomes);
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const upIdx = outcomes.indexOf("Up");
  if (upIdx === -1 || tokenIds.length !== outcomes.length) return null;
  return tokenIds[upIdx];
}

interface AssetTracking {
  asset: Asset;
  slug: string;
  conditionId: string;
  tokenId: string;
  book: BookState | null; // null until the WS delivers this token's initial `book` snapshot
}

async function resolveAsset(asset: Asset, slug: string): Promise<AssetTracking | null> {
  const market = await findMarketBySlug(slug);
  if (!market) {
    console.warn(`[depth-collector] no market found for slug ${slug} yet`);
    return null;
  }
  const tokenId = resolveUpToken(market);
  if (!tokenId) {
    console.warn(`[depth-collector] ${slug}: couldn't resolve the "Up" outcome token`);
    return null;
  }
  return { asset, slug, conditionId: market.conditionId, tokenId, book: null };
}

function persistSnapshot(tracking: AssetTracking): void {
  if (!tracking.book) return; // no book snapshot received yet for this asset -- nothing to persist
  const levels = toBookLevels(tracking.book);
  insertOrderbookSnapshot({
    marketSlug: tracking.slug,
    conditionId: tracking.conditionId,
    tokenId: tracking.tokenId,
    capturedAt: Math.floor(Date.now() / 1000),
    bestBidPrice: levels.bestBid?.price ?? null,
    bestBidSize: levels.bestBid?.size ?? null,
    bestAskPrice: levels.bestAsk?.price ?? null,
    bestAskSize: levels.bestAsk?.size ?? null,
    bidsJson: JSON.stringify(levels.bids),
    asksJson: JSON.stringify(levels.asks),
  });
}

function applyMessage(tracking: Map<Asset, AssetTracking>, data: string): void {
  for (const parsed of parseMarketMessages(data)) {
    if (parsed.type === "book") {
      const tracked = [...tracking.values()].find((t) => t.tokenId === parsed.message.asset_id);
      if (tracked) tracked.book = createBookState(parsed.message);
    } else {
      for (const entry of parsed.message.price_changes) {
        const tracked = [...tracking.values()].find((t) => t.tokenId === entry.asset_id);
        if (tracked?.book) applyPriceChangeEntry(tracked.book, entry);
      }
    }
  }
}

// Adds a newly-rolled-over asset's token to an OPEN connection and removes
// the previous one -- confirmed live that `operation:"subscribe"` on an
// existing connection triggers a fresh `book` snapshot for the added
// asset, no reconnect needed (see clobWebSocket.ts's file header).
// `unsubscribe`'s exact effect was not independently live-tested (lower
// risk if wrong: a stale subscription just means ignored extra messages
// for a token no tracking entry references any more, not a correctness
// bug).
function swapSubscription(ws: WebSocket, oldTokenId: string, newTokenId: string): void {
  if (ws.readyState !== WebSocket.OPEN) return; // a reconnect is already in flight; the next full connect picks up the new token via resolveAsset
  ws.send(JSON.stringify({ operation: "subscribe", assets_ids: [newTokenId], type: "market", initial_dump: true, level: 2 }));
  ws.send(JSON.stringify({ operation: "unsubscribe", assets_ids: [oldTokenId], type: "market" }));
}

// Runs one WebSocket connection's full lifetime: subscribes to every
// currently-tracked asset's token, applies book/price_change messages onto
// `tracking`'s shared in-memory state (the rollover timer mutates the same
// map, so a token swap takes effect on the very next message), and
// resolves when the connection ends for any reason so the caller can
// reconnect. `onOpen` lets the caller reset its own reconnect-backoff
// counter without this function needing to know that concept exists.
function runConnection(ws: WebSocket, tracking: Map<Asset, AssetTracking>, onOpen: () => void): Promise<void> {
  return new Promise((resolve) => {
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    ws.addEventListener("open", () => {
      const assetsIds = [...tracking.values()].map((t) => t.tokenId);
      console.log(`[depth-collector] connected, subscribing to ${assetsIds.length} token(s)`);
      ws.send(JSON.stringify({ assets_ids: assetsIds, type: "market", initial_dump: true, level: 2 }));
      onOpen();
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string" && ev.data !== "PONG") applyMessage(tracking, ev.data);
    });

    const onEnd = (label: string) => () => {
      if (pingTimer) clearInterval(pingTimer);
      console.warn(`[depth-collector] connection ${label}`);
      resolve();
    };
    ws.addEventListener("close", onEnd("closed"));
    ws.addEventListener("error", onEnd("errored"));
  });
}

export async function runCollectorLoop(): Promise<never> {
  // Found 2026-09-25: the collector never ran migrations, so against a
  // fresh DB it crashed on its first snapshot write ("no such table").
  runMigrations();
  console.log(`[depth-collector] starting -- WebSocket mode, snapshot interval ${SNAPSHOT_INTERVAL_MS}ms, assets: ${ASSETS.join(", ")}`);

  const tracking = new Map<Asset, AssetTracking>();
  for (const asset of ASSETS) {
    const resolved = await resolveAsset(asset, currentSlotSlug(asset, Math.floor(Date.now() / 1000)));
    if (resolved) tracking.set(asset, resolved);
  }

  let currentWs: WebSocket | null = null;

  // Snapshot + rollover timer -- runs independently of connection state (a
  // snapshot just no-ops per-asset if that asset's book is still null).
  setInterval(async () => {
    for (const asset of ASSETS) {
      const slug = currentSlotSlug(asset, Math.floor(Date.now() / 1000));
      const existing = tracking.get(asset);
      if (existing && existing.slug !== slug) {
        const next = await resolveAsset(asset, slug);
        if (next) {
          if (currentWs) swapSubscription(currentWs, existing.tokenId, next.tokenId);
          tracking.set(asset, next);
        }
      }
    }
  }, ROLLOVER_CHECK_INTERVAL_MS);

  setInterval(() => {
    for (const t of tracking.values()) persistSnapshot(t);
  }, SNAPSHOT_INTERVAL_MS);

  // Reconnect loop -- unlike a bounded per-request retry (docs/AUDIT.md
  // §10's "never retry forever" is about a single logical API call), this
  // is a long-running daemon's connection loop: the same "runs forever,
  // backs off, never gives up" character as its own systemd
  // `Restart=always` wrapper -- capped DELAY (backoffDelayMs's maxDelayMs),
  // not capped attempts.
  let reconnectAttempt = 0;
  for (;;) {
    currentWs = new WebSocket(WS_URL);
    await runConnection(currentWs, tracking, () => {
      reconnectAttempt = 0;
    });
    currentWs = null;
    reconnectAttempt++;
    const delay = backoffDelayMs(reconnectAttempt, { maxDelayMs: 30_000 });
    console.warn(`[depth-collector] reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
    await sleep(delay);
  }
}

if (require.main === module) {
  runCollectorLoop();
}
