// Passive order-book snapshot collector for the depth-shift strategy
// scoping work (docs/DEPTH_SHIFT_STRATEGY_SCOPE.md). Pure data capture --
// no entry/exit rule, no execution. Polls the currently-open BTC/ETH
// "Up or Down" 15-minute market's "Up" outcome token's order book on a
// fast cadence and stores raw snapshots, so a future session has real
// data to backtest a depth-shift rule against (Polymarket exposes no
// historical order-book endpoint -- this is the only way to ever get any).
//
// Deliberately its own small loop, not folded into trackDaemon.ts: this
// polls every few seconds, three orders of magnitude faster than
// trackDaemon's 60s wallet-tracking cadence, and would blow through that
// daemon's per-host rate-limit budget if merged in.

import { getOrderBook, fetchRaw } from "../api/client";
import { insertOrderbookSnapshot } from "../storage/repository";
import { sleep } from "../utils/retry";
import type { GammaMarket } from "../api/schemas";

const ASSETS = ["btc", "eth"] as const;
type Asset = (typeof ASSETS)[number];
const SLOT_SECONDS = 900; // markets run in back-to-back 15-minute windows
const POLL_INTERVAL_MS = 5000;

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

interface AssetState {
  slug: string;
  conditionId: string;
  upTokenId: string;
}

async function resolveUpToken(market: GammaMarket): Promise<string | null> {
  const outcomes = parseJsonArray(market.outcomes);
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const upIdx = outcomes.indexOf("Up");
  if (upIdx === -1 || tokenIds.length !== outcomes.length) return null;
  return tokenIds[upIdx];
}

async function captureOnce(asset: Asset, cached: AssetState | null): Promise<AssetState | null> {
  const slug = currentSlotSlug(asset, Math.floor(Date.now() / 1000));

  let state = cached?.slug === slug ? cached : null;
  if (!state) {
    const market = await findMarketBySlug(slug);
    if (!market) {
      console.warn(`[depth-collector] no market found for slug ${slug} yet -- skipping this cycle`);
      return null;
    }
    const upTokenId = await resolveUpToken(market);
    if (!upTokenId) {
      console.warn(`[depth-collector] ${slug}: couldn't resolve the "Up" outcome token -- skipping`);
      return null;
    }
    state = { slug, conditionId: market.conditionId, upTokenId };
  }

  const book = await getOrderBook(state.upTokenId);
  const bids = (book.bids ?? []).map((l) => ({ price: Number(l.price), size: Number(l.size) }));
  const asks = (book.asks ?? []).map((l) => ({ price: Number(l.price), size: Number(l.size) }));
  const bestBid = bids.length ? bids.reduce((a, b) => (b.price > a.price ? b : a)) : null;
  const bestAsk = asks.length ? asks.reduce((a, b) => (b.price < a.price ? b : a)) : null;

  insertOrderbookSnapshot({
    marketSlug: state.slug,
    conditionId: state.conditionId,
    tokenId: state.upTokenId,
    capturedAt: Math.floor(Date.now() / 1000),
    bestBidPrice: bestBid?.price ?? null,
    bestBidSize: bestBid?.size ?? null,
    bestAskPrice: bestAsk?.price ?? null,
    bestAskSize: bestAsk?.size ?? null,
    bidsJson: JSON.stringify(bids),
    asksJson: JSON.stringify(asks),
  });

  return state;
}

export async function runCollectorLoop(): Promise<never> {
  console.log(`[depth-collector] starting -- poll interval ${POLL_INTERVAL_MS}ms, assets: ${ASSETS.join(", ")}`);
  const cache: Partial<Record<Asset, AssetState>> = {};
  for (;;) {
    for (const asset of ASSETS) {
      try {
        const state = await captureOnce(asset, cache[asset] ?? null);
        if (state) cache[asset] = state;
      } catch (err) {
        console.warn(`[depth-collector] ${asset}: cycle failed: ${(err as Error).message}`);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

if (require.main === module) {
  runCollectorLoop();
}
