// K1 (2026-09-24): the ONLY place that decides whether an API response may
// be written to the persistent cache (src/api/responseCache.ts). The rule
// is "provably can never change", not "probably stable": a wrong cache
// entry silently corrupts every later backtest that reads it, while a
// missed caching opportunity only costs one extra rate-limited request.
// So each predicate here errs toward NOT caching, and any request type not
// covered by a predicate in this file is never cached at all -- /activity,
// leaderboards, holders, order books, search and every event listing
// included (all of them describe "now", and their answer shifts as new
// trades/markets arrive).

// Structural, not GammaMarket, so research scripts with their own local
// market schema (e.g. weatherFavorites.ts's WxMarket) can pass theirs.
export interface SettlementFields {
  closed: boolean;
  outcomePrices?: string;
  clobTokenIds?: string;
  umaResolutionStatus?: string | null;
}

function parseJsonArray(raw: string | undefined): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// A market whose settlement is final. Stricter than engine.ts's historical
// `market.closed` rule on purpose:
//   - closed === true alone isn't enough: gamma can flag a market closed
//     while its UMA resolution is still only proposed/disputed.
//   - outcomePrices must be a clean payout vector -- exactly one "1", every
//     other outcome exactly "0". That's what a settled binary/categorical
//     market reports (confirmed live 2026-09-24 on freshly-closed markets:
//     ["0", "1"] / ["1", "0"]); anything fractional (a 50-50 split, or a
//     closing mid like 0.9995 before the payout is written) is left
//     uncached -- rare, and refetching it is cheap and safe.
//   - umaResolutionStatus, when gamma includes it, must be "resolved"
//     (seen live 2026-09-24 alongside the clean payout vector). Older
//     markets may omit it; for those the payout vector is the evidence.
// Once all three hold, the on-chain payout has been reported, which the
// CTF contract only allows once -- the outcome can't be revised after.
export function isFinalizedMarket(market: SettlementFields | null | undefined): boolean {
  if (!market || market.closed !== true) return false;
  if (market.umaResolutionStatus != null && market.umaResolutionStatus !== "resolved") return false;
  const prices = parseJsonArray(market.outcomePrices);
  if (!prices || prices.length < 2) return false;
  let ones = 0;
  for (const p of prices) {
    if (typeof p !== "string" && typeof p !== "number") return false;
    const n = Number(p);
    if (n === 1) ones++;
    else if (n !== 0) return false;
  }
  return ones === 1;
}

// getMarketByConditionId(conditionId, closed=true): cacheable only when the
// lookup found exactly the requested market and it is finalized. Never the
// closed=false lookup (an open market's state changes every trade), and
// never an empty result ("not found as closed" just means "not closed
// YET" for a live market).
export function isCacheableMarketLookup(
  conditionId: string,
  closedParam: boolean,
  response: readonly (SettlementFields & { conditionId: string })[]
): boolean {
  if (!closedParam || response.length !== 1) return false;
  const m = response[0];
  return m.conditionId.toLowerCase() === conditionId.toLowerCase() && isFinalizedMarket(m);
}

// How long after a price-history window ends before its contents are
// treated as settled. The market also has to be finalized (below), which
// already means trading stopped; this margin additionally covers CLOB
// indexing lag for the last candles before the window's end. A day is far
// beyond any lag this project has seen, and the cost of the margin is only
// that windows ending in the last 24h get refetched -- backtests look at
// fills weeks old.
export const PRICE_HISTORY_SETTLE_MARGIN_SECONDS = 24 * 3600;

// CLOB /prices-history for one token and a fixed [startTs, endTs] window.
// A past window alone is NOT enough: the CLOB is known to thin out
// fine-fidelity history for markets once they resolve, so a window fetched
// while the market was still open can come back different afterwards.
// Caching only after the market is finalized means every cached response
// is already the post-resolution form. Required, all of:
//   - the caller vouched for the market (passed it in), it's finalized,
//     and the requested token is actually one of its clobTokenIds (so a
//     caller bug pairing the wrong market with a token can't make an open
//     market's history cacheable);
//   - the window ended at least PRICE_HISTORY_SETTLE_MARGIN_SECONDS ago;
//   - the history is non-empty -- an empty answer is indistinguishable
//     from a transient CLOB gap, so it's refetched rather than pinned.
// Residual, documented risk: if Polymarket ever re-downsamples an
// already-resolved market's history later, the cache keeps the (finer)
// copy fetched first -- a re-run then reproduces the original run's data
// exactly, which is what a reproducible backtest wants anyway.
export function isCacheablePriceHistory(
  req: { tokenId: string; endTs: number },
  market: SettlementFields | null | undefined,
  response: { history?: readonly unknown[] },
  nowSec: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!isFinalizedMarket(market)) return false;
  const tokenIds = parseJsonArray(market!.clobTokenIds);
  if (!tokenIds || !tokenIds.includes(req.tokenId)) return false;
  if (req.endTs > nowSec - PRICE_HISTORY_SETTLE_MARGIN_SECONDS) return false;
  return (response.history?.length ?? 0) > 0;
}
