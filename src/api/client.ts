// Hardened wrapper around Polymarket's public, unauthenticated REST APIs.
// Rebuilt for Phase 1 (see docs/AUDIT.md §2/§10) on top of the original
// single-throttle client: adds a per-request timeout, bounded exponential
// backoff with jitter (never retries forever), per-host rate limiting,
// runtime response validation (src/api/schemas.ts), structured errors, and
// URL logging that redacts anything secret-shaped before it's printed.

import { config } from "../config/env";
import { RateLimiter } from "../utils/rateLimiter";
import { backoffDelayMs, sleep } from "../utils/retry";
// None of today's endpoints take a secret query param (positions/activity/
// gamma/CLOB are all public reads) — redactUrl is a default-safe guard for
// the day an authenticated endpoint (e.g. CLOB order placement, see
// docs/AUDIT.md §10) gets added and someone logs its URL without thinking
// about it. Shared with src/markets/solana/client.ts (src/utils/redactUrl.ts)
// rather than each copying the regex, since a missed secret-shaped param
// name is a real credential-leak risk either way.
import { redactUrl } from "../utils/redactUrl";
import { validateSchema as validate } from "../utils/validateSchema";
import { SharedSlotStore, type SlotReserver } from "../utils/sharedSlots";
import { ApiResponseCache } from "./responseCache";
import { isCacheableMarketLookup, isCacheablePriceHistory, type SettlementFields } from "./cachePolicy";
import {
  ActivityResponseSchema,
  PublicSearchResponseSchema,
  MarketsLookupResponseSchema,
  PricesHistoryResponseSchema,
  GammaEventsResponseSchema,
  OrderBookSchema,
  LeaderboardResponseSchema,
  HoldersResponseSchema,
  ClosedPositionsResponseSchema,
  OpenPositionsResponseSchema,
  type ClosedPosition,
  type OpenPosition,
  type Activity,
  type GammaMarket,
  type GammaEvent,
  type OrderBook,
  type LeaderboardEntry,
  type HoldersGroup,
} from "./schemas";

export type { Activity, GammaMarket, GammaEvent, LeaderboardEntry, HoldersGroup, ClosedPosition, OpenPosition };

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

// K1/K2 (2026-09-24) hermeticity guard: a stubbed fetch means fixture
// responses, which must never be written into (or served from) the real
// cache file, and tests must never touch the real shared slot file either.
// NODE_TEST_CONTEXT is set by node's test runner for every test file's
// process, covering tests that forget to stub. Tests that exercise the
// cache/slots inject in-memory instances via the __set*ForTests seams.
function underTest(): boolean {
  return fetchImpl !== fetch || process.env.NODE_TEST_CONTEXT !== undefined;
}

let slotStoreOverride: SlotReserver | null | undefined;
let defaultSlotStore: SharedSlotStore | null = null;
let slotStoreRetryAt = 0;
let warnedSlotStoreOpen = false;
// A failed open (e.g. a lock held past busy_timeout) is retried after 30s
// rather than giving up for the process's lifetime -- the daemon runs for
// days, and one bad moment at startup shouldn't cost it coordination.
function sharedSlots(): SlotReserver | null {
  if (slotStoreOverride !== undefined) return slotStoreOverride;
  if (!config.sharedRateLimitEnabled || underTest()) return null;
  if (!defaultSlotStore && Date.now() >= slotStoreRetryAt) {
    try {
      defaultSlotStore = new SharedSlotStore(config.sharedRateLimitPath);
    } catch (err) {
      if (!warnedSlotStoreOpen) {
        console.error(`[rate-limit] can't open ${config.sharedRateLimitPath} (${(err as Error).message}); using in-process limiter`);
        warnedSlotStoreOpen = true;
      }
      slotStoreRetryAt = Date.now() + 30_000;
    }
  }
  return defaultSlotStore;
}

// Per-host minimum gap between requests (shared across processes via K2).
// Was a flat 1100ms (~0.9 req/s) everywhere -- 20-100x under Polymarket's
// documented limits, checked 2026-09-25 at docs.polymarket.com/quickstart/
// introduction/rate-limits (per IP, per 10s): data-api general 1000,
// /trades 200, /positions 150; gamma general 4000, /markets 300, /events
// 500; CLOB /prices-history 1000, /book 1500. Over-limit requests are
// throttled by Cloudflare, and a 429 still gets requestJson's backoff.
// 100ms (10 req/s per host) stays under the tightest of those (/positions,
// 15/s) with margin. POLYCOPY_MIN_GAP_MS overrides every host (e.g. 1100
// to restore the old pacing).
const HOST_MIN_GAP_MS: Record<string, number> = {
  "data-api.polymarket.com": 100,
  "gamma-api.polymarket.com": 100,
  "clob.polymarket.com": 100,
};
const DEFAULT_MIN_GAP_MS = 1100;
function minGapFor(host: string): number {
  const override = Number(process.env.POLYCOPY_MIN_GAP_MS);
  if (Number.isFinite(override) && override >= 0 && process.env.POLYCOPY_MIN_GAP_MS !== "") return override;
  return HOST_MIN_GAP_MS[host] ?? DEFAULT_MIN_GAP_MS;
}

const rateLimiter = new RateLimiter(minGapFor, sharedSlots);

let cacheOverride: ApiResponseCache | null | undefined;
let defaultCache: ApiResponseCache | null | undefined;
const cacheStats = { hits: 0, misses: 0, stored: 0 };
function apiCache(): ApiResponseCache | null {
  if (cacheOverride !== undefined) return cacheOverride;
  if (!config.apiCacheEnabled || underTest()) return null;
  if (defaultCache === undefined) {
    try {
      defaultCache = new ApiResponseCache(config.apiCachePath);
      // One stderr line per process so a re-run shows what the cache saved.
      process.once("exit", () => {
        if (cacheStats.hits + cacheStats.misses > 0) {
          console.error(`[api-cache] ${cacheStats.hits} hits, ${cacheStats.misses} misses, ${cacheStats.stored} stored`);
        }
      });
    } catch (err) {
      console.error(`[api-cache] can't open ${config.apiCachePath} (${(err as Error).message}); continuing uncached`);
      defaultCache = null;
    }
  }
  return defaultCache;
}

export function getApiCacheStats(): Readonly<typeof cacheStats> {
  return { ...cacheStats };
}
export function __setApiCacheForTests(cache: ApiResponseCache | null | undefined): void {
  cacheOverride = cache;
  cacheStats.hits = cacheStats.misses = cacheStats.stored = 0;
}
export function __setSlotReserverForTests(reserver: SlotReserver | null | undefined): void {
  slotStoreOverride = reserver;
  rateLimiter.resetForTests();
}

export class PolymarketApiError extends Error {
  constructor(
    message: string,
    public readonly host: string,
    public readonly url: string,
    public readonly statusCode: number | null,
    public readonly attempt: number
  ) {
    super(message);
    this.name = "PolymarketApiError";
  }
}

// Lets a caller (the tracking daemon) persist failures without api/ having
// to depend on storage/ — keeps the layers separate per docs/AUDIT.md §11.
// Defaults to logging so scripts that never call onApiError still see
// failures.
export type ApiErrorListener = (err: PolymarketApiError) => void;
let errorListener: ApiErrorListener = (err) => {
  console.error(`[api] ${err.host} ${err.statusCode ?? "network"} (attempt ${err.attempt}): ${err.message}`);
};
export function onApiError(listener: ApiErrorListener) {
  errorListener = listener;
}

function hostOf(url: string): string {
  return new URL(url).host;
}

// Overridable so tests can exercise pagination/retry/backoff logic against
// fixture responses instead of the live API (docs/AUDIT.md §9 — "create
// adapters so API behavior can be mocked during tests").
let fetchImpl: typeof fetch = fetch;
export function __setFetchImplForTests(fn: typeof fetch): void {
  fetchImpl = fn;
}
export function __resetFetchImplForTests(): void {
  fetchImpl = fetch;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Every outbound call — typed helper or the CLOB escape hatch — goes
// through this: per-host rate limiting, a request timeout, and a bounded
// retry budget (config.apiMaxRetries) with exponential backoff + jitter on
// 429s and transient network errors. A non-429 4xx/5xx fails immediately
// without burning retries — callers rely on this for control flow (e.g.
// getActivityFromStart detects the /activity offset cap via a 400).
async function requestJson(url: string): Promise<unknown> {
  const host = hostOf(url);
  const redacted = redactUrl(url);
  let lastError: PolymarketApiError | null = null;

  for (let attempt = 1; attempt <= config.apiMaxRetries; attempt++) {
    await rateLimiter.wait(host);

    let res: Response;
    try {
      res = await fetchWithTimeout(url);
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      lastError = new PolymarketApiError(timedOut ? "request timed out" : (err as Error).message, host, redacted, null, attempt);
      errorListener(lastError);
      if (attempt < config.apiMaxRetries) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      throw lastError;
    }

    if (res.status === 429) {
      lastError = new PolymarketApiError("rate limited", host, redacted, 429, attempt);
      errorListener(lastError);
      if (attempt < config.apiMaxRetries) {
        await sleep(backoffDelayMs(attempt, { baseDelayMs: 2000, maxDelayMs: 20_000 }));
        continue;
      }
      throw lastError;
    }

    if (!res.ok) {
      throw new PolymarketApiError(`${res.status} ${res.statusText}`, host, redacted, res.status, attempt);
    }

    return res.json();
  }

  throw lastError ?? new PolymarketApiError("exhausted retries", host, redacted, null, config.apiMaxRetries);
}

// Escape hatch for endpoints (e.g. clob.polymarket.com) not covered by a
// typed helper below, still going through the same rate-limit/timeout/retry
// path. Unvalidated (no fixed schema owns this path — backtestLadder.ts
// validates the one shape it needs itself via PricesHistoryResponseSchema).
// Never cached: fetchRaw has no idea what it's fetching, so nothing can be
// proven immutable about its responses (src/api/cachePolicy.ts).
export const fetchRaw = requestJson;

// K1 (2026-09-24): cache-first fetch for the request types cachePolicy.ts
// can prove immutable. A hit never reaches requestJson, so it never spends
// a rate-limit slot. The RAW response (pre-zod, so fields the schema
// strips survive) is what's stored, and only after it validated; a hit is
// re-validated against today's schema and treated as a miss if it no
// longer fits (e.g. a field became required since it was cached).
async function cachedRequest<T>(
  url: string,
  schema: { parse: (data: unknown) => T; safeParse: (data: unknown) => { success: boolean; data?: T } },
  context: string,
  isImmutable: (parsed: T) => boolean
): Promise<T> {
  const cache = apiCache();
  if (cache) {
    const hit = cache.get(url);
    const parsed = hit ? schema.safeParse(hit.body) : null;
    if (parsed?.success) {
      cacheStats.hits++;
      return parsed.data as T;
    }
    cacheStats.misses++;
  }
  const raw = await requestJson(url);
  const parsed = validate(schema, raw, context);
  if (cache && isImmutable(parsed)) {
    cache.set(url, raw);
    cacheStats.stored++;
  }
  return parsed;
}

// `opts.market`: the market `clobTokenId` belongs to, if the caller has it.
// Only with it can the response be cached (a settled market + a window
// safely in the past -- see isCacheablePriceHistory for the exact rule);
// without it every call goes to the network as before.
export async function getPricesHistory(
  clobTokenId: string,
  startTs: number,
  endTs: number,
  fidelity: number,
  opts: { market?: SettlementFields | null } = {}
) {
  const url = `https://clob.polymarket.com/prices-history?market=${clobTokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`;
  return cachedRequest(url, PricesHistoryResponseSchema, "GET clob/prices-history", (res) =>
    isCacheablePriceHistory({ tokenId: clobTokenId, endTs }, opts.market, res)
  );
}

// Live order-book depth for one outcome token -- current state only, no
// history (see docs/DEPTH_SHIFT_STRATEGY_SCOPE.md: this is the whole
// reason a depth-shift strategy can only be evaluated by collecting
// snapshots forward in time, never backtested).
export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const url = `https://clob.polymarket.com/book?token_id=${tokenId}`;
  return validate(OrderBookSchema, await requestJson(url), "GET clob/book");
}

export async function getActivity(
  address: string,
  opts: { limit?: number; start?: number; offset?: number; sortDirection?: "ASC" | "DESC" } = {}
): Promise<Activity[]> {
  const limit = opts.limit ?? 500;
  const start = opts.start ?? 1;
  const offset = opts.offset ?? 0;
  const sortDirection = opts.sortDirection ?? "DESC";
  const url = `${DATA_API}/activity?user=${address}&limit=${limit}&offset=${offset}&start=${start}&sortBy=TIMESTAMP&sortDirection=${sortDirection}`;
  return validate(ActivityResponseSchema, await requestJson(url), "GET /activity");
}

// Pages back through /activity (offset capped at 5000 by the API) until
// `pages` batches are collected or a short page signals we've hit the end.
// Window shifts every call for high-frequency wallets — "most recent 500"
// means something different every time it's fetched (confirmed: re-running
// this a day apart pulled entirely different fills for Djdjdjekekek/RN1,
// see README Phase 1c). Fine for walletStats.ts's "how does this wallet
// currently behave" question; NOT fine for a reproducible backtest — use
// getActivityFromStart for that.
export async function getActivityDeep(address: string, pages = 4): Promise<Activity[]> {
  const out: Activity[] = [];
  for (let page = 0; page < pages; page++) {
    const batch = await getActivity(address, { limit: 500, offset: page * 500 });
    out.push(...batch);
    if (batch.length < 500) break;
  }
  return out;
}

// Pages FORWARD from the wallet's oldest activity (sortDirection=ASC,
// offset=0 first) instead of backward from "now" — see the original
// docstring in the pre-Phase-1 client for why this matters for
// reproducibility (README Phase 1d).
//
// `offset` is hard-capped by the API — confirmed by testing, offset=5000
// (page 10) succeeds but offset=5500 (page 11) 400s, for every wallet,
// regardless of `start`. To pull deeper than that single window, once a 400
// is hit (or `pages` successful pages have been used up within the current
// window) the window is re-opened by setting `start` to the last fill's own
// timestamp and resetting `offset` back to 0. Fills are deduped
// (transactionHash + outcome + side + size + price) because the boundary
// fill at the old window's last timestamp is re-fetched as the first row of
// the next window.
//
// `fromTs` (unix seconds) anchors the pull at a fixed point instead of the
// wallet's very first fill -- still reproducible (same anchor, same fills),
// but reaches a high-volume wallet's recent trades within a sane page
// budget, where paging from its origin would cap out years early.
// The identity getActivityFromStart dedupes on. Exported (K3, 2026-09-24)
// so src/scoring/activitySource.ts's replay of this pull drops exactly the
// same rows.
export function activityKey(a: Activity): string {
  return `${a.transactionHash}:${a.conditionId}:${a.outcome}:${a.side}:${a.size}:${a.price}`;
}

export async function getActivityFromStart(address: string, pages = 10, fromTs = 1): Promise<Activity[]> {
  const out: Activity[] = [];
  const seen = new Set<string>();
  const addFresh = (batch: Activity[]) => {
    for (const a of batch) {
      const key = activityKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  };

  let startTs = fromTs;
  let pagesUsed = 0;
  while (pagesUsed < pages) {
    let offset = 0;
    let reachedEndOfHistory = false;
    while (pagesUsed < pages) {
      let batch: Activity[];
      try {
        batch = await getActivity(address, { limit: 500, offset, start: startTs, sortDirection: "ASC" });
      } catch (err) {
        if (err instanceof PolymarketApiError && err.statusCode === 400) break; // hit the offset cap for this window
        throw err;
      }
      pagesUsed++;
      addFresh(batch);
      if (batch.length < 500) {
        reachedEndOfHistory = true;
        break;
      }
      offset += 500;
    }
    if (reachedEndOfHistory || out.length === 0) break;
    startTs = Math.max(...out.map((a) => a.timestamp));
  }
  return out;
}

// gamma-api's /markets?search= param is silently ignored (confirmed by
// testing — it just returns unrelated recent markets). The real full-text
// search lives at /public-search and groups results by event, which is
// also exactly the shape we want: one event ("Bitcoin price on August 12?")
// bundling the whole price-ladder of sub-markets ("$56k-58k", "$58k-60k", ...).
export async function searchEvents(query: string, limitPerType = 20, status: "active" | "closed" = "active"): Promise<GammaEvent[]> {
  const qs = new URLSearchParams({ q: query, events_status: status, limit_per_type: String(limitPerType) });
  const res = validate(
    PublicSearchResponseSchema,
    await requestJson(`${GAMMA_API}/public-search?${qs.toString()}`),
    "GET /public-search (events)"
  );
  return res.events ?? [];
}

// Lists events for a sport/category tag directly (gamma-api's /events
// endpoint), unlike searchEvents' /public-search which is full-text and
// biases toward whatever's "popular" — a tag listing is what lets us pull
// a broad, independent sample of e.g. every individual MLB game event
// rather than only the ones a search ranker surfaces (confirmed by
// testing: searching "MLB" via /public-search returns season-long prop
// events like "MLB: Home Runs Leader", never individual games).
export async function getEventsByTag(
  tagSlug: string,
  opts: { closed?: boolean; limit?: number; offset?: number } = {}
): Promise<GammaEvent[]> {
  const qs = new URLSearchParams({
    tag_slug: tagSlug,
    limit: String(opts.limit ?? 100),
    offset: String(opts.offset ?? 0),
    order: "endDate",
    ascending: "false",
  });
  if (opts.closed !== undefined) qs.set("closed", String(opts.closed));
  const res = await requestJson(`${GAMMA_API}/events?${qs.toString()}`);
  return validate(GammaEventsResponseSchema, res, "GET /events");
}

// Direct market lookup by conditionId — needed to resolve what a historical
// trade's market actually settled to. `closed` isn't a tri-state filter
// (omit-to-get-both); a closed market only shows up when closed=true is
// passed explicitly, confirmed by testing.
export async function getMarketByConditionId(conditionId: string, closed: boolean): Promise<GammaMarket | null> {
  const qs = new URLSearchParams({ condition_ids: conditionId, closed: String(closed) });
  const res = await cachedRequest(`${GAMMA_API}/markets?${qs.toString()}`, MarketsLookupResponseSchema, "GET /markets", (r) =>
    isCacheableMarketLookup(conditionId, closed, r)
  );
  return res[0] ?? null;
}

// K4 (2026-09-25): batch form of getMarketByConditionId. gamma's /markets
// accepts repeated `condition_ids=` params (a comma list silently returns
// nothing) but caps the response at 20 unless `limit` is passed -- both
// confirmed live. Checked for equivalence the same day: of 100 real
// conditionIds, the batch returned 97; the other 3 were also absent from
// single closed=true AND closed=false lookups. So resolving N markets
// costs ~2*ceil(N/50) requests instead of up to 2N (a candidate wallet
// with 400 markets: ~16 requests instead of ~400-800, at ~1.1s each).
// Cache semantics are unchanged: each finalized market is stored under
// the SAME key a single closed=true lookup would use (and read back from
// it), so the single and batch paths share one cache.
const MARKET_BATCH_SIZE = 50; // ~4KB of query string per request

function singleMarketLookupUrl(conditionId: string, closed: boolean): string {
  return `${GAMMA_API}/markets?${new URLSearchParams({ condition_ids: conditionId, closed: String(closed) }).toString()}`;
}

export async function getMarketsByConditionIds(conditionIds: string[]): Promise<Map<string, GammaMarket>> {
  const out = new Map<string, GammaMarket>();
  const cache = apiCache();
  let pending: string[] = [];
  for (const id of new Set(conditionIds)) {
    if (cache) {
      const hit = cache.get(singleMarketLookupUrl(id, true));
      const parsed = hit ? MarketsLookupResponseSchema.safeParse(hit.body) : null;
      if (parsed?.success && parsed.data[0]) {
        cacheStats.hits++;
        out.set(id, parsed.data[0]);
        continue;
      }
      cacheStats.misses++;
    }
    pending.push(id);
  }
  for (const closed of [true, false]) {
    const notFound: string[] = [];
    for (let i = 0; i < pending.length; i += MARKET_BATCH_SIZE) {
      const chunk = pending.slice(i, i + MARKET_BATCH_SIZE);
      const qs = new URLSearchParams({ closed: String(closed), limit: String(MARKET_BATCH_SIZE * 2) });
      for (const id of chunk) qs.append("condition_ids", id);
      const raw = await requestJson(`${GAMMA_API}/markets?${qs.toString()}`);
      const parsed = validate(MarketsLookupResponseSchema, raw, "GET /markets (batch)");
      const rawList = raw as unknown[];
      const byId = new Map<string, { market: GammaMarket; raw: unknown }>();
      parsed.forEach((m, j) => byId.set(m.conditionId.toLowerCase(), { market: m, raw: rawList[j] }));
      for (const id of chunk) {
        const found = byId.get(id.toLowerCase());
        if (!found) {
          notFound.push(id);
          continue;
        }
        out.set(id, found.market);
        if (closed && cache && isCacheableMarketLookup(id, true, [found.market])) {
          cache.set(singleMarketLookupUrl(id, true), [found.raw]);
          cacheStats.stored++;
        }
      }
    }
    pending = notFound;
  }
  return out;
}

// Resolves a username or profile-slug fragment to the proxyWallet address
// that actually holds funds/positions (NOT the same as what shows in a
// polymarket.com/@... profile URL — see wallets.ts for why that matters).
export async function resolveProxyWallet(usernameOrSlug: string): Promise<string | null> {
  const qs = new URLSearchParams({ q: usernameOrSlug, search_profiles: "true", limit_per_type: "5" });
  const res = validate(
    PublicSearchResponseSchema,
    await requestJson(`${GAMMA_API}/public-search?${qs.toString()}`),
    "GET /public-search (profiles)"
  );
  return res.profiles?.[0]?.proxyWallet ?? null;
}

// data-api's /v1/leaderboard, category/timePeriod/orderBy params confirmed
// against docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings
// on 2026-09-13 -- source-wallets.ts's first real use of a `category` other
// than the implicit OVERALL this project's manually-scraped wallets.ts
// sources have always used, and the first WEEK/MONTH/ALL beyond what those
// scrapes covered by hand.
export async function getLeaderboard(
  category:
    "OVERALL" | "POLITICS" | "SPORTS" | "ESPORTS" | "CRYPTO" | "CULTURE" | "MENTIONS" | "WEATHER" | "ECONOMICS" | "TECH" | "FINANCE",
  timePeriod: "WEEK" | "MONTH" | "ALL",
  orderBy: "PNL" | "VOL" = "PNL",
  opts: { limit?: number; offset?: number } = {}
): Promise<LeaderboardEntry[]> {
  const qs = new URLSearchParams({
    category,
    timePeriod,
    orderBy,
    limit: String(opts.limit ?? 25),
    offset: String(opts.offset ?? 0),
  });
  return validate(LeaderboardResponseSchema, await requestJson(`${DATA_API}/v1/leaderboard?${qs.toString()}`), "GET /v1/leaderboard");
}

// data-api's /holders — a genuinely different wallet-sourcing signal from
// getLeaderboard's historical PNL rank: who currently holds a large
// position in a market that's trading RIGHT NOW. Confirmed live 2026-09-15
// (docs/IMPROVEMENT_PLAN.md's wallet-sourcing track): `market` (the
// conditionId) is required -- `/positions`-style user-only or bare
// condition_id/conditionId/token param names all 400. Returns one group per
// outcome token, holders pre-sorted descending by `amount` (share count,
// not USD).
export async function getTopHolders(conditionId: string, limit = 20): Promise<HoldersGroup[]> {
  const qs = new URLSearchParams({ market: conditionId, limit: String(limit) });
  return validate(HoldersResponseSchema, await requestJson(`${DATA_API}/holders?${qs.toString()}`), "GET /holders");
}

// gamma-api's /events ordered by recent (24h) volume -- "what's actually
// trading heavily right now," independent of any wallet's historical PNL.
// The natural feed for getTopHolders() above: pairs a currently-hot market
// with who's currently sized into it, rather than who made money in the
// past. `order=volume24hr` confirmed live 2026-09-15.
export async function getActiveEventsByVolume(limit = 20, tagSlug?: string): Promise<GammaEvent[]> {
  const qs = new URLSearchParams({ closed: "false", order: "volume24hr", ascending: "false", limit: String(limit) });
  if (tagSlug) qs.set("tag_slug", tagSlug);
  return validate(GammaEventsResponseSchema, await requestJson(`${GAMMA_API}/events?${qs.toString()}`), "GET /events (by volume24hr)");
}

// K5 (2026-09-25): one page of a wallet's closed positions, newest first
// (API max 50 per page). Never cached: a wallet's closed set grows, and a
// merged position's curPrice keeps moving until its market settles.
export async function getClosedPositions(address: string, opts: { limit?: number; offset?: number } = {}): Promise<ClosedPosition[]> {
  const qs = new URLSearchParams({
    user: address,
    limit: String(opts.limit ?? 50),
    offset: String(opts.offset ?? 0),
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });
  return validate(ClosedPositionsResponseSchema, await requestJson(`${DATA_API}/closed-positions?${qs.toString()}`), "GET /closed-positions");
}

// K5: one page of a wallet's resolved-but-unredeemed positions, latest
// market endDate first (sortBy=RESOLVING). Not cached, for the same reason.
export async function getRedeemablePositions(address: string, opts: { limit?: number; offset?: number } = {}): Promise<OpenPosition[]> {
  const qs = new URLSearchParams({
    user: address,
    redeemable: "true",
    limit: String(opts.limit ?? 500),
    offset: String(opts.offset ?? 0),
    sortBy: "RESOLVING",
    sortDirection: "DESC",
  });
  return validate(OpenPositionsResponseSchema, await requestJson(`${DATA_API}/positions?${qs.toString()}`), "GET /positions (redeemable)");
}
