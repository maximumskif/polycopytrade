// Hardened wrapper around Polymarket's public, unauthenticated REST APIs.
// Rebuilt for Phase 1 (see docs/AUDIT.md §2/§10) on top of the original
// single-throttle client: adds a per-request timeout, bounded exponential
// backoff with jitter (never retries forever), per-host rate limiting,
// runtime response validation (src/api/schemas.ts), structured errors, and
// URL logging that redacts anything secret-shaped before it's printed.

import { config } from "../config/env";
import { RateLimiter } from "../utils/rateLimiter";
import { backoffDelayMs, sleep } from "../utils/retry";
import {
  ActivityResponseSchema,
  PublicSearchResponseSchema,
  MarketsLookupResponseSchema,
  PricesHistoryResponseSchema,
  GammaEventsResponseSchema,
  OrderBookSchema,
  type Activity,
  type GammaMarket,
  type GammaEvent,
  type OrderBook,
} from "./schemas";

export type { Activity, GammaMarket, GammaEvent };

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

const rateLimiter = new RateLimiter(1100);

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

// None of today's endpoints take a secret query param (positions/activity/
// gamma/CLOB are all public reads) — this is a default-safe guard for the
// day an authenticated endpoint (e.g. CLOB order placement, see
// docs/AUDIT.md §10) gets added and someone logs its URL without thinking
// about it.
function redactUrl(url: string): string {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (/key|secret|passphrase|token|password/i.test(key)) u.searchParams.set(key, "***");
  }
  return u.toString();
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

function validate<T>(schema: { parse: (data: unknown) => T }, data: unknown, context: string): T {
  try {
    return schema.parse(data);
  } catch (err) {
    throw new Error(`Response validation failed for ${context}: ${(err as Error).message}`);
  }
}

// Escape hatch for endpoints (e.g. clob.polymarket.com) not covered by a
// typed helper below, still going through the same rate-limit/timeout/retry
// path. Unvalidated (no fixed schema owns this path — backtestLadder.ts
// validates the one shape it needs itself via PricesHistoryResponseSchema).
export const fetchRaw = requestJson;

export async function getPricesHistory(clobTokenId: string, startTs: number, endTs: number, fidelity: number) {
  const url = `https://clob.polymarket.com/prices-history?market=${clobTokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`;
  return validate(PricesHistoryResponseSchema, await requestJson(url), "GET clob/prices-history");
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
export async function getActivityFromStart(address: string, pages = 10): Promise<Activity[]> {
  const out: Activity[] = [];
  const seen = new Set<string>();
  const addFresh = (batch: Activity[]) => {
    for (const a of batch) {
      const key = `${a.transactionHash}:${a.conditionId}:${a.outcome}:${a.side}:${a.size}:${a.price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  };

  let startTs = 1;
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
  const res = validate(PublicSearchResponseSchema, await requestJson(`${GAMMA_API}/public-search?${qs.toString()}`), "GET /public-search (events)");
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
  const res = validate(MarketsLookupResponseSchema, await requestJson(`${GAMMA_API}/markets?${qs.toString()}`), "GET /markets");
  return res[0] ?? null;
}

// Resolves a username or profile-slug fragment to the proxyWallet address
// that actually holds funds/positions (NOT the same as what shows in a
// polymarket.com/@... profile URL — see wallets.ts for why that matters).
export async function resolveProxyWallet(usernameOrSlug: string): Promise<string | null> {
  const qs = new URLSearchParams({ q: usernameOrSlug, search_profiles: "true", limit_per_type: "5" });
  const res = validate(PublicSearchResponseSchema, await requestJson(`${GAMMA_API}/public-search?${qs.toString()}`), "GET /public-search (profiles)");
  return res.profiles?.[0]?.proxyWallet ?? null;
}
