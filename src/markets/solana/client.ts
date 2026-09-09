// Solana wallet-activity API client scaffold — Phase C of the multi-market
// expansion (see docs/MULTI_MARKET_ARCHITECTURE.md). Mirrors
// src/api/client.ts's reliability pattern (per-host rate limiting, bounded
// exponential-backoff-with-jitter retries that never retry forever, a
// request timeout, zod runtime response validation, a structured error
// type, secret-redacting URL logging, and a mockable fetch seam for tests)
// as closely as two genuinely different provider APIs allow, so this starts
// from the same reliability discipline the Polymarket client has already
// earned rather than a from-scratch design.
//
// ============================================================================
// READ THIS BEFORE WIRING ANYTHING ELSE UP TO THIS FILE
// ============================================================================
// No Solana API key (Helius or Birdeye) is available in this environment.
// Every endpoint path, header name, and response shape here is sourced from
// each provider's PUBLISHED DOCUMENTATION (fetched 2026-09-07 via WebFetch/
// WebSearch), not confirmed by a real authenticated call. This is a
// deliberate, explicit exception to this project's own stated bar for every
// existing Polymarket integration (docs/AUDIT.md, src/api/client.ts/
// schemas.ts — every claim there is confirmed by testing against the real
// live API). It is safe to commit as SCAFFOLDING — the shape and
// conventions are right, and it compiles/typechecks/lints clean with no
// live wiring anywhere — but nothing in src/scoring/ or src/backtesting/
// should be pointed at this file's output until Phase D runs it against a
// real key and fixes whatever the docs got wrong or omitted. Docs visibly
// drifted even during this single research pass — see the two
// provider-specific caveats below (schemas.ts's Birdeye path discrepancy,
// and this file's Helius base-URL uncertainty) for concrete examples of why
// "looks right from the docs" is not the same bar this project normally
// holds itself to.
//
// This file deliberately does NOT import anything from src/api/client.ts
// (off-limits for this task, and its PolymarketApiError/zod schemas are
// specific enough to Polymarket that copying the *structure* locally was
// the safer call under the time available) or src/config/env.ts (avoids
// adding a new consumer to the config module the live tracking daemon also
// depends on, for a code path nothing yet calls). It DOES import
// src/utils/rateLimiter.ts, src/utils/retry.ts, src/utils/redactUrl.ts, and
// src/utils/validateSchema.ts directly, unmodified — none of those four are
// Polymarket-specific, none are in this task's off-limits list, and
// re-deriving the same backoff/redaction/validation logic a second time
// would be exactly the kind of duplication docs/AUDIT.md calls out
// elsewhere as a real risk (code-review pass, 2026-09-08, extracted
// redactUrl/validateSchema out of src/api/client.ts into src/utils/ for
// exactly this reason — requestJson's retry-loop CONTROL FLOW is the one
// piece still deliberately left duplicated below, since unifying it would
// mean restructuring src/api/client.ts's live, production request path for
// a currently-unused consumer; see the note at requestJson).

import { RateLimiter } from "../../utils/rateLimiter";
import { backoffDelayMs, sleep } from "../../utils/retry";
import { redactUrl } from "../../utils/redactUrl";
import { validateSchema as validate } from "../../utils/validateSchema";
import {
  HeliusTransactionsResponseSchema,
  BirdeyeWalletPnlSummarySchema,
  type HeliusTransaction,
  type BirdeyeWalletPnlSummary,
} from "./schemas";

export type { HeliusTransaction, BirdeyeWalletPnlSummary };
export { toNumber } from "./schemas";

type Provider = "helius" | "birdeye";

// Helius's own docs are internally inconsistent about which host the
// Enhanced Transactions REST API (as opposed to the JSON-RPC endpoint used
// for calls like getAsset) lives on: one fetched page listed
// "mainnet.helius-rpc.com"/"devnet.helius-rpc.com" as "Base URLs" directly
// above a GET /v0/addresses/{address}/transactions path, but that host is
// documented elsewhere (and in this project's general Solana-tooling
// knowledge) as the JSON-RPC endpoint, not the v0 REST API's home. The v0
// REST path style (GET with a resource path, not a POST JSON-RPC envelope)
// strongly suggests the historical `api.helius.xyz` REST host is still
// correct here, so that's what's used below — but this is flagged, not
// asserted, precisely because it's the kind of thing a docs page can get
// subtly wrong in a way that only a real call would catch (a wrong host
// fails obviously — DNS/connection error — so this is lower-risk than the
// Birdeye path ambiguity in schemas.ts, which would 404 just as silently as
// a real "no activity" response might look).
const HELIUS_ENHANCED_TX_BASE = "https://api.helius.xyz";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
// See schemas.ts's file header for the slash-vs-underscore path
// discrepancy this project found between Birdeye's two own doc pages.
const BIRDEYE_PNL_SUMMARY_PATH = "/wallet/v2/pnl/summary";

const DEFAULT_TIMEOUT_MS = 15_000; // matches src/config/env.ts's API_TIMEOUT_MS default — same sane default, not shared code (see file header on why this doesn't import that module)
const DEFAULT_MAX_RETRIES = 5; // matches src/config/env.ts's API_MAX_RETRIES default

// Rate limits below are deliberately conservative defaults, not confirmed
// account limits — adjust once a real account's dashboard/docs confirm the
// actual number, the same way src/api/client.ts's 1100ms gap was arrived at
// for Polymarket by observing real 429s (docs/AUDIT.md), not guessed.
//
// Helius: found TWO conflicting free-tier numbers across two separate
// searches during this research pass — one source said "2 req/s" (a
// pricing-comparison table), another said "10 requests/sec, 1M credits/
// month" (attributed to Helius's own docs.helius.dev/docs/billing/plans
// page). Defaulted to the more conservative reading (2 req/s = 500ms gap)
// since this project's own convention (docs/AUDIT.md §10) is to prefer a
// safe default over an optimistic one when a rate limit isn't independently
// confirmed by testing — being wrong in the conservative direction costs
// throughput, being wrong in the optimistic direction gets the key
// rate-limited or suspended.
const HELIUS_MIN_GAP_MS = 500;
// Birdeye: a search-result summary of Birdeye's own support docs stated
// "the free tier has a rate limit of 1 request/sec" — the primary pricing
// page itself returned HTTP 403 to this session's fetch attempts (couldn't
// verify directly), so this is second-hand, not a primary-source
// confirmation. 1100ms mirrors the exact conservative gap
// src/api/client.ts already uses for Polymarket, for the same reason: a
// wallet-intelligence workload doesn't need to move fast, only reliably.
const BIRDEYE_MIN_GAP_MS = 1100;

const rateLimiters: Record<Provider, RateLimiter> = {
  helius: new RateLimiter(HELIUS_MIN_GAP_MS),
  birdeye: new RateLimiter(BIRDEYE_MIN_GAP_MS),
};

export class SolanaApiError extends Error {
  constructor(
    message: string,
    public readonly provider: Provider,
    public readonly url: string,
    public readonly statusCode: number | null,
    public readonly attempt: number
  ) {
    super(message);
    this.name = "SolanaApiError";
  }
}

let fetchImpl: typeof fetch = fetch;
export function __setFetchImplForTests(fn: typeof fetch): void {
  fetchImpl = fn;
}
export function __resetFetchImplForTests(): void {
  fetchImpl = fetch;
}

// Polymarket's client (src/api/client.ts) gets this for free from
// src/config/env.ts, which tests mutate directly (see
// tests/apiClient.test.ts's `config.apiMaxRetries = 2` in beforeEach) —
// this file deliberately doesn't import that shared config module (see the
// file header), so it needs its own small test seam to keep a
// bounded-retries test from actually sleeping through several real
// exponential-backoff delays.
let maxRetriesOverride: number | undefined;
export function __setMaxRetriesForTests(n: number): void {
  maxRetriesOverride = n;
}
export function __resetMaxRetriesForTests(): void {
  maxRetriesOverride = undefined;
}

async function fetchWithTimeout(url: string, headers: Record<string, string> | undefined, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timeout);
  }
}

// Same shape as src/api/client.ts's requestJson: bounded retry budget,
// exponential backoff + jitter on 429s and transient network errors, fast
// fail (no retry burned) on any other non-2xx status. Deliberately NOT
// unified with that file's copy (code-review finding, 2026-09-08, flagged
// not fixed): the two differ in error type (SolanaApiError vs
// PolymarketApiError) and error reporting (console.error here vs an
// injectable errorListener there), and src/api/client.ts's version is the
// live tracking daemon's actual request path today, while this file has no
// live callers yet (see the file header). Generalizing it now would mean
// restructuring tested, working production code to serve a consumer
// nothing calls yet — worth doing once Phase D actually exercises this
// file against a real key and the two implementations' real behavior
// (not just their current source text) can be compared, not before.
async function requestJson(
  provider: Provider,
  url: string,
  headers?: Record<string, string>,
  opts: { timeoutMs?: number; maxRetries?: number } = {}
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? maxRetriesOverride ?? DEFAULT_MAX_RETRIES;
  const redacted = redactUrl(url);
  let lastError: SolanaApiError | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await rateLimiters[provider].wait(provider);

    let res: Response;
    try {
      res = await fetchWithTimeout(url, headers, timeoutMs);
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      lastError = new SolanaApiError(timedOut ? "request timed out" : (err as Error).message, provider, redacted, null, attempt);
      console.error(`[solana/${provider}] network error (attempt ${attempt}): ${lastError.message}`);
      if (attempt < maxRetries) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      throw lastError;
    }

    if (res.status === 429) {
      lastError = new SolanaApiError("rate limited", provider, redacted, 429, attempt);
      console.error(`[solana/${provider}] 429 (attempt ${attempt})`);
      if (attempt < maxRetries) {
        await sleep(backoffDelayMs(attempt, { baseDelayMs: 2000, maxDelayMs: 20_000 }));
        continue;
      }
      throw lastError;
    }

    if (!res.ok) {
      throw new SolanaApiError(`${res.status} ${res.statusText}`, provider, redacted, res.status, attempt);
    }

    return res.json();
  }

  throw lastError ?? new SolanaApiError("exhausted retries", provider, redacted, null, maxRetries);
}

// Reads an API key from an explicit override (mainly for tests) or the
// environment, throwing a clear, actionable error rather than letting a
// missing key surface as a confusing downstream failure (an unauthenticated
// request to either provider would otherwise just come back as some
// generic 401/403 the retry loop would burn its whole budget on).
function requireApiKey(explicit: string | undefined, envVar: string, provider: string): string {
  const key = explicit ?? process.env[envVar];
  if (!key) {
    throw new Error(
      `${provider} API key not configured. Set ${envVar} in .env (see .env.example) or pass { apiKey } explicitly. ` +
        `No key is available in this project's environment yet — src/markets/solana/client.ts is scaffolding, not wired to a live account (see docs/MULTI_MARKET_ARCHITECTURE.md).`
    );
  }
  return key;
}

// ---------------------------------------------------------------------
// Helius: wallet transaction history
// ---------------------------------------------------------------------

export interface HeliusWalletHistoryOptions {
  apiKey?: string;
  // Enhanced Transactions caps a single page at 100 (per docs) — unconfirmed
  // against a real account, kept as the documented ceiling rather than a
  // guessed higher number.
  limit?: number;
  // Docs describe pagination as "loop with `before` set to the last
  // returned transaction's signature, stop when the response is empty" —
  // NOT confirmed by testing (no key). This is a materially different
  // pagination model than Polymarket's offset-based one
  // (getActivityFromStart, src/api/client.ts) — a signature cursor can't be
  // resumed from an arbitrary offset, only walked forward one page at a
  // time from wherever the last pull stopped. Any future caller that wants
  // Polymarket's "reproducible pull from genesis" property
  // (docs/AUDIT.md/README Phase 1d) will need to persist the last-seen
  // signature itself; this scaffold does not attempt that yet.
  maxPages?: number;
  type?: string; // Helius's own transaction-type filter, e.g. "SWAP"
}

// Pages backward from a wallet's most recent transactions using the
// documented `before`-signature cursor, stopping when a page comes back
// shorter than `limit` (interpreted as "reached the end of history") or
// `maxPages` is hit. See the maxPages field's comment above for why this is
// NOT the same reproducibility guarantee getActivityFromStart provides for
// Polymarket — flagged as an open gap for Phase D, not silently assumed
// equivalent.
export async function getHeliusWalletTransactionHistory(
  address: string,
  opts: HeliusWalletHistoryOptions = {}
): Promise<HeliusTransaction[]> {
  const apiKey = requireApiKey(opts.apiKey, "HELIUS_API_KEY", "Helius");
  const limit = opts.limit ?? 100;
  const maxPages = opts.maxPages ?? 4;

  const out: HeliusTransaction[] = [];
  let before: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ "api-key": apiKey, limit: String(limit) });
    if (opts.type) qs.set("type", opts.type);
    if (before) qs.set("before", before);
    const url = `${HELIUS_ENHANCED_TX_BASE}/v0/addresses/${address}/transactions?${qs.toString()}`;

    const batch = validate(
      HeliusTransactionsResponseSchema,
      await requestJson("helius", url),
      "GET Helius /v0/addresses/{address}/transactions"
    );
    if (batch.length === 0) break;
    out.push(...batch);

    const lastSignature = batch[batch.length - 1]?.signature;
    if (!lastSignature || batch.length < limit) break; // short page (or no cursor to advance with) => end of history
    before = lastSignature;
  }

  return out;
}

// ---------------------------------------------------------------------
// Birdeye: wallet-level realized/unrealized PnL summary
// ---------------------------------------------------------------------

export type BirdeyePnlDuration = "all" | "90d" | "30d" | "7d" | "24h";

export interface BirdeyeWalletPnlOptions {
  apiKey?: string;
  duration?: BirdeyePnlDuration;
  chain?: string; // defaults to "solana" per docs
}

export async function getBirdeyeWalletPnlSummary(wallet: string, opts: BirdeyeWalletPnlOptions = {}): Promise<BirdeyeWalletPnlSummary> {
  const apiKey = requireApiKey(opts.apiKey, "BIRDEYE_API_KEY", "Birdeye");
  const qs = new URLSearchParams({ wallet, duration: opts.duration ?? "all" });
  const url = `${BIRDEYE_BASE}${BIRDEYE_PNL_SUMMARY_PATH}?${qs.toString()}`;

  return validate(
    BirdeyeWalletPnlSummarySchema,
    await requestJson("birdeye", url, { "X-API-KEY": apiKey, "x-chain": opts.chain ?? "solana" }),
    "GET Birdeye /wallet/v2/pnl/summary"
  );
}
