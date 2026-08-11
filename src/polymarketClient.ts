// Thin wrapper around Polymarket's public, unauthenticated REST APIs.
// data-api.polymarket.com rate-limits aggressively (429s within seconds of a
// handful of calls in testing) — every call goes through this queue so
// callers never have to think about backoff.

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

const MIN_GAP_MS = 1100;
let lastCallAt = 0;

async function throttledFetch(url: string): Promise<any> {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();

  const res = await fetch(url);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 5000));
    return throttledFetch(url);
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

// Escape hatch for endpoints (e.g. clob.polymarket.com) not covered by a
// typed helper below, still going through the same throttle/backoff.
export const throttledFetchRaw = throttledFetch;

export interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  title: string;
  slug: string;
  outcome: string;
  endDate: string;
}

export interface Activity {
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  price: number;
  side: "BUY" | "SELL";
  outcome: string;
  title: string;
  slug: string;
  proxyWallet: string;
  transactionHash: string;
}

export async function getPositions(address: string): Promise<Position[]> {
  const url = `${DATA_API}/positions?user=${address}&sizeThreshold=0&limit=500&sortBy=CASHPNL&sortDirection=DESC`;
  return throttledFetch(url);
}

export async function getActivity(
  address: string,
  opts: { limit?: number; start?: number } = {}
): Promise<Activity[]> {
  const limit = opts.limit ?? 500;
  const start = opts.start ?? 1;
  const url = `${DATA_API}/activity?user=${address}&limit=${limit}&start=${start}&sortBy=TIMESTAMP&sortDirection=DESC`;
  return throttledFetch(url);
}

export interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  outcomes: string; // JSON-encoded string array, e.g. '["Yes","No"]'
  outcomePrices: string; // JSON-encoded string array, e.g. '["0.12","0.88"]'
  clobTokenIds?: string; // JSON-encoded string array, one CLOB token id per outcome
  startDate?: string;
  endDate: string;
  closed: boolean;
  volume: string;
  liquidity: string;
}

export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  endDate: string;
  volume: number;
  liquidity: number;
  markets: GammaMarket[];
}

interface PublicSearchResponse {
  events: GammaEvent[] | null;
}

// gamma-api's /markets?search= param is silently ignored (confirmed by
// testing — it just returns unrelated recent markets). The real full-text
// search lives at /public-search and groups results by event, which is
// also exactly the shape we want: one event ("Bitcoin price on August 12?")
// bundling the whole price-ladder of sub-markets ("$56k-58k", "$58k-60k", ...).
export async function searchEvents(
  query: string,
  limitPerType = 20,
  status: "active" | "closed" = "active"
): Promise<GammaEvent[]> {
  const qs = new URLSearchParams({
    q: query,
    events_status: status,
    limit_per_type: String(limitPerType),
  });
  const res: PublicSearchResponse = await throttledFetch(`${GAMMA_API}/public-search?${qs.toString()}`);
  return res.events ?? [];
}

interface Profile {
  name: string;
  proxyWallet: string;
}

// Resolves a username or profile-slug fragment to the proxyWallet address
// that actually holds funds/positions (NOT the same as what shows in a
// polymarket.com/@... profile URL — see wallets.ts for why that matters).
export async function resolveProxyWallet(usernameOrSlug: string): Promise<string | null> {
  const qs = new URLSearchParams({ q: usernameOrSlug, search_profiles: "true", limit_per_type: "5" });
  const res: { profiles: Profile[] | null } = await throttledFetch(`${GAMMA_API}/public-search?${qs.toString()}`);
  return res.profiles?.[0]?.proxyWallet ?? null;
}
