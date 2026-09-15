// Etherscan API V2 client (Polygon PoS via chainid=137) — Track G.20,
// funding-source clustering (docs/IMPROVEMENT_PLAN.md). Mirrors
// src/api/client.ts's reliability pattern (per-host rate limiting, bounded
// exponential-backoff-with-jitter retries, a request timeout, zod runtime
// validation, a structured error type, a mockable fetch seam) the same way
// src/markets/solana/client.ts does — see that file's header for why the
// retry-loop control flow is deliberately duplicated rather than shared
// (still true here: this has no live callers in the tracking daemon, and
// unifying it would mean restructuring src/api/client.ts's live production
// path for a currently-separate consumer).
//
// CONFIRMED LIVE 2026-09-15: unlike src/markets/solana/client.ts (docs-only,
// unconfirmed), every endpoint/param/response shape below was verified
// against a real ETHERSCAN_API_KEY and a real tracked wallet
// (0x1b20a00709dfe648afd26b326394b5e031f83ab0) before being written —
// tokentx and eth_getTransactionReceipt both matched schemas.ts exactly.
//
// Polygonscan's own standalone API (a separate key, a separate host) was
// deprecated 2025-08-15. Polygon PoS data now comes from the unified
// Etherscan API V2 — one API key covers 60+ chains, selected via a
// `chainid` query param. Confirmed rate limit (Etherscan's own published
// free-tier number, not independently load-tested): 5 req/s, 100k req/day.

import { RateLimiter } from "../../utils/rateLimiter";
import { backoffDelayMs, sleep } from "../../utils/retry";
import { redactUrl } from "../../utils/redactUrl";
import { validateSchema as validate } from "../../utils/validateSchema";
import { TokenTxResponseSchema, TransactionReceiptEnvelopeSchema, EthCallEnvelopeSchema, type TokenTransfer } from "./schemas";
import { findUserOperationSender } from "./logDecoding";
import { decodeAddressArrayResult } from "./abiDecoding";

export type { TokenTransfer };

const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";
const POLYGON_CHAIN_ID = 137;

// Confirmed current addresses (web-search + public PolygonScan pages,
// 2026-09-15 — not from stale docs): Polymarket's trading collateral is
// pUSD, minted from incoming USDC/USDC.e via a Collateral Onramp contract.
// USDC.e (bridged, not Circle-issued) is the token that flows INTO that
// onramp — see logDecoding.ts's file header for the confirmed real
// transaction this was traced through.
export const PUSD_CONTRACT = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
export const USDC_E_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const COLLATERAL_ONRAMP_CONTRACT = "0x93070a847efEf7F70739046A929D47a521F5B8ee";

// 5 req/s documented free-tier limit -> 200ms minimum gap; 220ms kept as a
// small safety margin, the same conservative-over-optimistic call
// src/markets/solana/client.ts makes for its own (unconfirmed) limits.
const ETHERSCAN_MIN_GAP_MS = 220;
const rateLimiter = new RateLimiter(ETHERSCAN_MIN_GAP_MS);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 5;

export class EtherscanApiError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode: number | null,
    public readonly attempt: number
  ) {
    super(message);
    this.name = "EtherscanApiError";
  }
}

let fetchImpl: typeof fetch = fetch;
export function __setFetchImplForTests(fn: typeof fetch): void {
  fetchImpl = fn;
}
export function __resetFetchImplForTests(): void {
  fetchImpl = fetch;
}
export function __resetRateLimiterForTests(): void {
  rateLimiter.resetForTests();
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Same bounded-retry shape as src/api/client.ts / src/markets/solana/client.ts.
async function requestJson(url: string, opts: { timeoutMs?: number; maxRetries?: number } = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const redacted = redactUrl(url);
  let lastError: EtherscanApiError | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await rateLimiter.wait("etherscan");

    let res: Response;
    try {
      res = await fetchWithTimeout(url, timeoutMs);
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      lastError = new EtherscanApiError(timedOut ? "request timed out" : (err as Error).message, redacted, null, attempt);
      console.error(`[polygon/etherscan] network error (attempt ${attempt}): ${lastError.message}`);
      if (attempt < maxRetries) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      throw lastError;
    }

    if (res.status === 429) {
      lastError = new EtherscanApiError("rate limited", redacted, 429, attempt);
      console.error(`[polygon/etherscan] 429 (attempt ${attempt})`);
      if (attempt < maxRetries) {
        await sleep(backoffDelayMs(attempt, { baseDelayMs: 2000, maxDelayMs: 20_000 }));
        continue;
      }
      throw lastError;
    }

    if (!res.ok) {
      throw new EtherscanApiError(`${res.status} ${res.statusText}`, redacted, res.status, attempt);
    }

    const body = await res.json();
    // Etherscan signals rate-limiting as HTTP 200 with status="0",
    // message="NOTOK" (confirmed live 2026-09-15 -- this project's own
    // rapid test calls triggered it) -- NOT an HTTP 429, so it's invisible
    // to the check above unless handled here. Treated as retryable, same
    // backoff as a real 429; a non-rate-limit status="0" (e.g. a bad
    // address) is left for the caller to interpret, since only this
    // specific message is confirmed to mean "try again," not "this request
    // is wrong."
    if (isEtherscanRateLimitBody(body)) {
      lastError = new EtherscanApiError("rate limited (status=0/NOTOK)", redacted, 200, attempt);
      console.error(`[polygon/etherscan] NOTOK rate limit (attempt ${attempt})`);
      if (attempt < maxRetries) {
        await sleep(backoffDelayMs(attempt, { baseDelayMs: 2000, maxDelayMs: 20_000 }));
        continue;
      }
      throw lastError;
    }

    return body;
  }

  throw lastError ?? new EtherscanApiError("exhausted retries", redacted, null, maxRetries);
}

// Etherscan's account/proxy-module rate-limit response shape, confirmed
// live 2026-09-15: {status:"0", message:"NOTOK", result:"Max rate limit
// reached..."} on a 200 OK. Deliberately checks `message==="NOTOK"` rather
// than sniffing `result` for "rate limit" text, since NOTOK is the one
// confirmed-observed value — a broader string match risks silently
// swallowing a real, non-retryable error under the same generic wording.
function isEtherscanRateLimitBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && "status" in body && "message" in body && (body as { status: unknown }).status === "0" && (body as { message: unknown }).message === "NOTOK";
}

function requireApiKey(explicit: string | undefined): string {
  const key = explicit ?? process.env.ETHERSCAN_API_KEY;
  if (!key) {
    throw new Error("ETHERSCAN_API_KEY not configured. Set it in .env (see .env.example) or pass { apiKey } explicitly.");
  }
  return key;
}

export interface TokenTransfersOptions {
  apiKey?: string;
  sort?: "asc" | "desc";
  page?: number;
  offset?: number;
}

// module=account&action=tokentx — ERC-20 transfer events for `address`,
// optionally filtered to one token contract. Confirmed live 2026-09-15
// (see file header).
export async function getTokenTransfers(address: string, contractAddress: string, opts: TokenTransfersOptions = {}): Promise<TokenTransfer[]> {
  const apiKey = requireApiKey(opts.apiKey);
  const qs = new URLSearchParams({
    chainid: String(POLYGON_CHAIN_ID),
    module: "account",
    action: "tokentx",
    address,
    contractaddress: contractAddress,
    sort: opts.sort ?? "asc",
    page: String(opts.page ?? 1),
    offset: String(opts.offset ?? 20),
    apikey: apiKey,
  });
  const url = `${ETHERSCAN_BASE}?${qs.toString()}`;
  const body = await requestJson(url);

  // Etherscan's account-module endpoints return status="0" for a real "no
  // transactions found" case (not an HTTP error) — confirmed live
  // 2026-09-15 that `result` is then the message STRING again, not an
  // empty array (see schemas.ts). That's an empty result, not a failure,
  // so it's normalized to [] here. Any other status="0" message is a real
  // problem (bad address, rate-limit-as-200, etc.) and does throw.
  const parsed = validate(TokenTxResponseSchema, body, "GET Etherscan tokentx");
  if (parsed.status === "0") {
    if (parsed.message.toLowerCase() === "no transactions found") return [];
    throw new EtherscanApiError(`tokentx returned status=0: ${parsed.message}`, redactUrl(url), null, 1);
  }
  return parsed.result as TokenTransfer[];
}

// Earliest INCOMING transfer of `contractAddress` to `address` — the
// signal fundingHop.ts needs (the mint/deposit event that started this
// wallet's real activity), not just the earliest transfer of any direction.
// Returns undefined if the wallet has never received this token.
export async function getEarliestIncomingTokenTransfer(address: string, contractAddress: string, opts: TokenTransfersOptions = {}): Promise<TokenTransfer | undefined> {
  const transfers = await getTokenTransfers(address, contractAddress, { ...opts, sort: "asc", offset: opts.offset ?? 25 });
  return transfers.find((t) => t.to.toLowerCase() === address.toLowerCase());
}

// module=proxy&action=eth_getTransactionReceipt. Returns the raw logs array
// findUserOperationSender (logDecoding.ts) decodes. Confirmed live
// 2026-09-15 (see file header).
export async function getTransactionReceiptSender(txHash: string, apiKey?: string): Promise<string | null> {
  const key = requireApiKey(apiKey);
  const qs = new URLSearchParams({
    chainid: String(POLYGON_CHAIN_ID),
    module: "proxy",
    action: "eth_getTransactionReceipt",
    txhash: txHash,
    apikey: key,
  });
  const url = `${ETHERSCAN_BASE}?${qs.toString()}`;
  const body = await requestJson(url);
  const parsed = validate(TransactionReceiptEnvelopeSchema, body, "GET Etherscan eth_getTransactionReceipt");
  if (!parsed.result) return null; // hash not found/not yet mined — a real, expected case, not an error
  return findUserOperationSender(parsed.result.logs);
}

// keccak256("getOwners()") -- standard Gnosis Safe interface function.
const SAFE_GET_OWNERS_SELECTOR = "0xa0e67e2b";

// Reads a Gnosis Safe's current owner set directly via eth_call, rather
// than decoding execTransaction's signature bytes -- confirmed live
// 2026-09-15 against a real tracked wallet that's a Safe
// (0x16bb9951a36fce71e2ef57890b786145e0ba8492, returned exactly one owner)
// and against a real non-Safe wallet (an ERC-4337 account, which reverts
// calling a function its contract doesn't implement -- a real, expected
// "not a Safe" signal, not a bug). Returns null for a revert (not a Safe,
// or some other contract shape this project hasn't seen), never throws for
// that case -- callers use null to fall back to the ERC-4337 trace.
//
// CAVEAT (documented, not tested): this reads owners as of NOW, not as of
// the wallet's original funding — a Safe whose ownership changed since
// would fingerprint its current controller, not necessarily whoever funded
// it originally. Not expected to matter for a one-off personal trading
// wallet, but not verified either way.
export async function getSafeOwners(address: string, apiKey?: string): Promise<string[] | null> {
  const key = requireApiKey(apiKey);
  const qs = new URLSearchParams({
    chainid: String(POLYGON_CHAIN_ID),
    module: "proxy",
    action: "eth_call",
    to: address,
    data: SAFE_GET_OWNERS_SELECTOR,
    tag: "latest",
    apikey: key,
  });
  const url = `${ETHERSCAN_BASE}?${qs.toString()}`;
  const body = await requestJson(url);
  const parsed = validate(EthCallEnvelopeSchema, body, "GET Etherscan eth_call getOwners");
  if ("error" in parsed) return null;
  const owners = decodeAddressArrayResult(parsed.result);
  return owners.length > 0 ? owners : null;
}
