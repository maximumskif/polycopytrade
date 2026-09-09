// Tests for src/markets/solana/client.ts scaffolding — see that file's
// header for the crucial caveat: no real Solana API key exists in this
// environment, so these tests exercise only what's actually testable
// without one: zod schema validation against synthetic fixtures shaped like
// the documented (not confirmed-by-testing) response shapes, and the
// reliability mechanics (bounded retry, fast-fail on non-429, missing-key
// error) against a mocked fetch — the exact same pattern
// tests/apiClient.test.ts uses for the Polymarket client, no network.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getHeliusWalletTransactionHistory,
  getBirdeyeWalletPnlSummary,
  SolanaApiError,
  __setFetchImplForTests,
  __resetFetchImplForTests,
  __setMaxRetriesForTests,
  __resetMaxRetriesForTests,
  __resetRateLimitersForTests,
} from "../src/markets/solana/client";
import { HeliusTransactionsResponseSchema, BirdeyeWalletPnlSummarySchema, toNumber } from "../src/markets/solana/schemas";

beforeEach(() => {
  __setMaxRetriesForTests(2); // keep retry tests fast, same reasoning as tests/apiClient.test.ts
  // Without this, the module-level rate limiters accumulate lastCallAt
  // across every test() in this file, so later tests pay a real setTimeout
  // wait once enough calls stack up against the same provider key --
  // confirmed live: this file's 13 tests took 6.2s before this existed
  // (code-review finding, 2026-09-09).
  __resetRateLimitersForTests();
});

afterEach(() => {
  __resetFetchImplForTests();
  __resetMaxRetriesForTests();
  delete process.env.HELIUS_API_KEY;
  delete process.env.BIRDEYE_API_KEY;
});

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 400 ? "Bad Request" : status === 429 ? "Too Many Requests" : status === 401 ? "Unauthorized" : "OK",
    json: async () => body,
  } as unknown as Response;
}

function makeHeliusTx(signature: string, timestamp: number) {
  return {
    signature,
    timestamp,
    type: "SWAP",
    source: "JUPITER",
    description: `swapped for ${signature}`,
    fee: 5000,
    feePayer: "feePayerAddress",
    tokenTransfers: [
      {
        fromUserAccount: "walletAddress",
        toUserAccount: "poolAddress",
        mint: "So11111111111111111111111111111111111111112",
        tokenAmount: 1.5,
      },
    ],
    nativeTransfers: [],
  };
}

// ---------------------------------------------------------------------
// Schema validation (the part of this file that doesn't need a live key)
// ---------------------------------------------------------------------

test("HeliusTransactionsResponseSchema accepts a well-formed synthetic transaction", () => {
  const rows = HeliusTransactionsResponseSchema.parse([makeHeliusTx("sig1", 1_700_000_000)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signature, "sig1");
  assert.equal(rows[0].type, "SWAP");
});

test("HeliusTransactionsResponseSchema accepts a transaction with unknown extra fields (passthrough, not strict)", () => {
  // Deliberately mirrors src/api/schemas.ts's own lesson (REWARD activity
  // rows almost broke an overly-strict first draft): this schema is
  // unconfirmed against a real payload, so it must not throw just because
  // a real response includes a field this file's authors didn't know about.
  const rows = HeliusTransactionsResponseSchema.parse([
    { ...makeHeliusTx("sig2", 1_700_000_001), someFieldNoDocPageMentioned: { nested: true } },
  ]);
  assert.equal(rows.length, 1);
});

test("HeliusTransactionsResponseSchema accepts a transaction with every field missing (all optional)", () => {
  // The documented shape is unconfirmed enough that this file's schema
  // makes nearly everything optional on purpose — confirm that holds.
  const rows = HeliusTransactionsResponseSchema.parse([{}]);
  assert.equal(rows.length, 1);
});

test("BirdeyeWalletPnlSummarySchema accepts the documented example shape", () => {
  const parsed = BirdeyeWalletPnlSummarySchema.parse({
    success: true,
    data: {
      summary: {
        unique_tokens: 12,
        counts: {
          total_buy: 40,
          total_sell: 38,
          total_trade: 78,
          total_win: 22,
          total_loss: 16,
          win_rate: "57.9", // documented as number|string -- exercise the string form
        },
        cashflow_usd: {
          total_invested: "10000.50",
          total_sold: 12500,
          current_value: 500.25,
        },
        pnl: {
          realized_profit_usd: 2500.75,
          realized_profit_percent: "25.0",
          unrealized_usd: 0,
          total_usd: 2500.75,
          avg_profit_per_trade_usd: 32.06,
        },
      },
    },
  });
  assert.equal(parsed.success, true);
  assert.equal(toNumber(parsed.data?.summary?.counts?.win_rate), 57.9);
  assert.equal(toNumber(parsed.data?.summary?.cashflow_usd?.total_invested), 10000.5);
});

test("BirdeyeWalletPnlSummarySchema accepts a minimal/degenerate response (e.g. a wallet with zero trades)", () => {
  const parsed = BirdeyeWalletPnlSummarySchema.parse({ success: true, data: {} });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.summary, undefined);
});

test("toNumber returns null for undefined and for a genuinely non-numeric string, not a silently coerced 0", () => {
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber("not-a-number"), null);
  assert.equal(toNumber(42), 42);
  assert.equal(toNumber("42.5"), 42.5);
});

// ---------------------------------------------------------------------
// Reliability mechanics against a mocked fetch (no network)
// ---------------------------------------------------------------------

test("getHeliusWalletTransactionHistory throws a clear, actionable error when no API key is configured", async () => {
  await assert.rejects(
    () => getHeliusWalletTransactionHistory("someAddress"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /HELIUS_API_KEY/);
      return true;
    }
  );
});

test("getBirdeyeWalletPnlSummary throws a clear, actionable error when no API key is configured", async () => {
  await assert.rejects(
    () => getBirdeyeWalletPnlSummary("someWallet"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /BIRDEYE_API_KEY/);
      return true;
    }
  );
});

test("getHeliusWalletTransactionHistory retries on 429 up to the bound, then throws — never retries forever", async () => {
  let calls = 0;
  __setFetchImplForTests(async () => {
    calls++;
    return fakeResponse(429, {});
  });

  await assert.rejects(
    () => getHeliusWalletTransactionHistory("someAddress", { apiKey: "test-key", maxPages: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof SolanaApiError);
      assert.equal((err as SolanaApiError).statusCode, 429);
      assert.equal((err as SolanaApiError).provider, "helius");
      return true;
    }
  );
  // beforeEach set the max-retries test seam to 2 -- the point of this test
  // is confirming the bound is actually respected, the same way
  // tests/apiClient.test.ts confirms it for the Polymarket client, not just
  // that it eventually throws.
  assert.equal(calls, 2, `expected exactly 2 attempts (the test override), got ${calls}`);
});

test("a non-429 error status (e.g. 401 from a bad key) fails immediately without burning the retry budget", async () => {
  let calls = 0;
  __setFetchImplForTests(async () => {
    calls++;
    return fakeResponse(401, { error: "unauthorized" });
  });

  await assert.rejects(
    () => getBirdeyeWalletPnlSummary("someWallet", { apiKey: "bad-key" }),
    (err: unknown) => {
      assert.ok(err instanceof SolanaApiError);
      assert.equal((err as SolanaApiError).statusCode, 401);
      assert.equal((err as SolanaApiError).provider, "birdeye");
      return true;
    }
  );
  assert.equal(calls, 1, "a 401 should not be retried");
});

test("getHeliusWalletTransactionHistory paginates via the before-signature cursor and stops on a short page", async () => {
  let calls = 0;
  __setFetchImplForTests(async (input) => {
    calls++;
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (calls === 1) {
      assert.equal(url.searchParams.has("before"), false, "first page should not send a before cursor");
      const full = Array.from({ length: 3 }, (_, i) => makeHeliusTx(`sig-${i}`, 1000 + i));
      return fakeResponse(200, full);
    }
    if (calls === 2) {
      assert.equal(url.searchParams.get("before"), "sig-2", "second page should cursor from the last signature of page 1");
      return fakeResponse(200, [makeHeliusTx("sig-3", 1003)]); // shorter than limit -> end of history
    }
    throw new Error("unexpected 3rd call");
  });

  const rows = await getHeliusWalletTransactionHistory("someAddress", { apiKey: "test-key", limit: 3, maxPages: 5 });

  assert.equal(calls, 2, "should stop after the short second page, not keep paging to maxPages");
  assert.equal(rows.length, 4);
  assert.equal(rows[rows.length - 1].signature, "sig-3");
});

test("getBirdeyeWalletPnlSummary sends the documented X-API-KEY and x-chain headers", async () => {
  let capturedHeaders: Record<string, string> | undefined;
  __setFetchImplForTests(async (_input, init) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return fakeResponse(200, { success: true, data: {} });
  });

  await getBirdeyeWalletPnlSummary("someWallet", { apiKey: "test-birdeye-key" });

  assert.equal(capturedHeaders?.["X-API-KEY"], "test-birdeye-key");
  assert.equal(capturedHeaders?.["x-chain"], "solana");
});

test("the Helius API key is redacted from a thrown error's URL, matching src/api/client.ts's redaction convention", async () => {
  __setFetchImplForTests(async () => fakeResponse(500, { error: "server error" }));

  await assert.rejects(
    () => getHeliusWalletTransactionHistory("someAddress", { apiKey: "super-secret-key", maxPages: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof SolanaApiError);
      assert.doesNotMatch((err as SolanaApiError).url, /super-secret-key/);
      assert.match((err as SolanaApiError).url, /api-key=\*\*\*/);
      return true;
    }
  );
});
