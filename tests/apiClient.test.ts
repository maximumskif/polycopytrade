// Tests the reliability behavior added in Phase 1 (docs/AUDIT.md §2/§10):
// bounded retries (never forever), fast-fail on a non-429 error status, and
// the getActivityFromStart offset-cap-workaround/dedup logic — all against
// a mocked fetch (src/api/client.ts's __setFetchImplForTests), no network.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config/env";
import {
  getActivity,
  getActivityFromStart,
  PolymarketApiError,
  __setFetchImplForTests,
  __resetFetchImplForTests,
  type Activity,
} from "../src/api/client";

const originalMaxRetries = config.apiMaxRetries;

beforeEach(() => {
  config.apiMaxRetries = 2; // keep retry tests fast
});

afterEach(() => {
  __resetFetchImplForTests();
  config.apiMaxRetries = originalMaxRetries;
});

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 400 ? "Bad Request" : status === 429 ? "Too Many Requests" : "OK",
    json: async () => body,
  } as unknown as Response;
}

function makeRow(i: number, ts: number): Activity {
  return {
    timestamp: ts,
    conditionId: "c",
    type: "TRADE",
    size: 1,
    usdcSize: 0.5,
    price: 0.5,
    side: "BUY",
    outcome: "Yes",
    title: "t",
    slug: "s",
    proxyWallet: "w",
    transactionHash: `tx-${i}`,
  };
}

test("retries on 429 up to the configured bound, then throws — never retries forever", async () => {
  let calls = 0;
  __setFetchImplForTests(async () => {
    calls++;
    return fakeResponse(429, {});
  });

  await assert.rejects(() => getActivity("0xabc"), (err: unknown) => {
    assert.ok(err instanceof PolymarketApiError);
    assert.equal(err.statusCode, 429);
    return true;
  });
  assert.equal(calls, config.apiMaxRetries, `expected exactly ${config.apiMaxRetries} attempts, got ${calls}`);
});

test("a non-429 error status fails immediately without burning the retry budget", async () => {
  let calls = 0;
  __setFetchImplForTests(async () => {
    calls++;
    return fakeResponse(400, { error: "bad request" });
  });

  await assert.rejects(() => getActivity("0xabc"), (err: unknown) => {
    assert.ok(err instanceof PolymarketApiError);
    assert.equal((err as PolymarketApiError).statusCode, 400);
    return true;
  });
  assert.equal(calls, 1, "a 400 should not be retried");
});

test("a successful response is validated and returned", async () => {
  __setFetchImplForTests(async () => fakeResponse(200, [makeRow(1, 1000)]));
  const rows = await getActivity("0xabc");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transactionHash, "tx-1");
});

test("getActivityFromStart re-opens the pagination window on the API's offset cap, deduping the boundary fill", async () => {
  let calls = 0;
  __setFetchImplForTests(async () => {
    calls++;
    if (calls === 1) {
      // First window, offset=0: a full 500-row page (not a short page, so
      // the loop doesn't think this is the end of the wallet's history).
      const rows = Array.from({ length: 500 }, (_, i) => makeRow(i, 1000 + i));
      return fakeResponse(200, rows);
    }
    if (calls === 2) {
      // First window, offset=500: simulates the real API's offset cap.
      return fakeResponse(400, { error: "offset too large" });
    }
    if (calls === 3) {
      // Window re-opened (start advanced to the last-seen timestamp,
      // offset reset to 0). Row 0 duplicates the boundary fill from call 1
      // (same identity key) — must be deduped, not double-counted. Row 1
      // is genuinely new. Short page (<500) signals end of history.
      return fakeResponse(200, [makeRow(499, 1499), makeRow(500, 1500)]);
    }
    throw new Error(`unexpected 4th call to the API in this test`);
  });

  const rows = await getActivityFromStart("0xabc", 2);

  assert.equal(calls, 3, "expected exactly 3 HTTP calls: full page, cap-hit, reopened window");
  assert.equal(rows.length, 501, "500 from the first window + 1 genuinely new row, boundary duplicate dropped");
  const uniqueKeys = new Set(rows.map((r) => r.transactionHash));
  assert.equal(uniqueKeys.size, 501, "no duplicate transactionHash made it into the result");
});
