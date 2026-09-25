// K1 (2026-09-24): persistent API cache -- the immutability rule
// (src/api/cachePolicy.ts), key normalization and storage
// (src/api/responseCache.ts), and client.ts's cache-first wiring. All
// in-memory or in a temp dir; the real data/api-cache.db is never touched.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isFinalizedMarket,
  isCacheableMarketLookup,
  isCacheablePriceHistory,
  PRICE_HISTORY_SETTLE_MARGIN_SECONDS,
} from "../src/api/cachePolicy";
import { ApiResponseCache, normalizeCacheKey } from "../src/api/responseCache";
import {
  getMarketByConditionId,
  getMarketsByConditionIds,
  getPricesHistory,
  getApiCacheStats,
  __setFetchImplForTests,
  __resetFetchImplForTests,
  __setApiCacheForTests,
  __setSlotReserverForTests,
} from "../src/api/client";

const settled = {
  id: "1",
  conditionId: "0xABC",
  question: "q",
  slug: "s",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0", "1"]',
  clobTokenIds: '["tok-yes","tok-no"]',
  closed: true,
  umaResolutionStatus: "resolved",
};

// --- immutability rule ---------------------------------------------------

test("isFinalizedMarket: only closed markets with a clean 0/1 payout vector and no unresolved UMA status", () => {
  assert.equal(isFinalizedMarket(settled), true);
  assert.equal(isFinalizedMarket({ ...settled, umaResolutionStatus: undefined }), true, "older markets omit the status");
  assert.equal(isFinalizedMarket({ ...settled, outcomePrices: "[1, 0, 0]" }), true, "categorical, numeric JSON");
  assert.equal(isFinalizedMarket({ ...settled, closed: false }), false);
  assert.equal(isFinalizedMarket({ ...settled, umaResolutionStatus: "proposed" }), false);
  assert.equal(isFinalizedMarket({ ...settled, umaResolutionStatus: "disputed" }), false);
  assert.equal(isFinalizedMarket({ ...settled, outcomePrices: '["0.9995", "0.0005"]' }), false, "closing mid, not a payout");
  assert.equal(isFinalizedMarket({ ...settled, outcomePrices: '["0.5", "0.5"]' }), false, "50-50 split left uncached");
  assert.equal(isFinalizedMarket({ ...settled, outcomePrices: '["1", "1"]' }), false);
  assert.equal(isFinalizedMarket({ ...settled, outcomePrices: '["0", "0"]' }), false);
  assert.equal(isFinalizedMarket({ ...settled, outcomePrices: '["1"]' }), false);
  assert.equal(isFinalizedMarket({ ...settled, outcomePrices: undefined }), false);
  assert.equal(isFinalizedMarket({ ...settled, outcomePrices: "not json" }), false);
  assert.equal(isFinalizedMarket(null), false);
});

test("isCacheableMarketLookup: only the closed=true lookup that found exactly the requested, finalized market", () => {
  assert.equal(isCacheableMarketLookup("0xabc", true, [settled]), true, "conditionId compared case-insensitively");
  assert.equal(isCacheableMarketLookup("0xabc", false, [settled]), false, "closed=false lookup never cached");
  assert.equal(isCacheableMarketLookup("0xabc", true, []), false, "not-found-as-closed can become found later");
  assert.equal(isCacheableMarketLookup("0xabc", true, [settled, settled]), false);
  assert.equal(isCacheableMarketLookup("0xdef", true, [settled]), false, "wrong market returned");
  assert.equal(isCacheableMarketLookup("0xabc", true, [{ ...settled, outcomePrices: '["0.6","0.4"]' }]), false);
});

test("isCacheablePriceHistory: finalized market owning the token, window past the settle margin, non-empty", () => {
  const now = 2_000_000_000;
  const oldEnd = now - PRICE_HISTORY_SETTLE_MARGIN_SECONDS - 1;
  const res = { history: [{ t: 1, p: 0.5 }] };
  assert.equal(isCacheablePriceHistory({ tokenId: "tok-no", endTs: oldEnd }, settled, res, now), true);
  assert.equal(
    isCacheablePriceHistory({ tokenId: "tok-no", endTs: now - PRICE_HISTORY_SETTLE_MARGIN_SECONDS }, settled, res, now),
    true,
    "exactly at the margin"
  );
  assert.equal(isCacheablePriceHistory({ tokenId: "tok-no", endTs: now - 3600 }, settled, res, now), false, "window too recent");
  assert.equal(isCacheablePriceHistory({ tokenId: "tok-no", endTs: oldEnd }, undefined, res, now), false, "no market vouched");
  assert.equal(isCacheablePriceHistory({ tokenId: "tok-no", endTs: oldEnd }, { ...settled, closed: false }, res, now), false);
  assert.equal(isCacheablePriceHistory({ tokenId: "tok-other", endTs: oldEnd }, settled, res, now), false, "token not in market");
  assert.equal(isCacheablePriceHistory({ tokenId: "tok-no", endTs: oldEnd }, settled, { history: [] }, now), false, "empty");
  assert.equal(isCacheablePriceHistory({ tokenId: "tok-no", endTs: oldEnd }, settled, {}, now), false, "missing history");
});

// --- key normalization + storage -----------------------------------------

test("normalizeCacheKey: param order, host case and default port don't matter; values and paths do", () => {
  const a = normalizeCacheKey("https://gamma-api.polymarket.com/markets?condition_ids=0xA&closed=true");
  assert.equal(a, normalizeCacheKey("https://GAMMA-API.polymarket.com:443/markets?closed=true&condition_ids=0xA#frag"));
  assert.equal(a, "https://gamma-api.polymarket.com/markets?closed=true&condition_ids=0xA");
  assert.notEqual(a, normalizeCacheKey("https://gamma-api.polymarket.com/markets?condition_ids=0xa&closed=true"));
  assert.notEqual(a, normalizeCacheKey("https://gamma-api.polymarket.com/markets?condition_ids=0xA&closed=false"));
  assert.notEqual(a, normalizeCacheKey("https://gamma-api.polymarket.com/events?condition_ids=0xA&closed=true"));
  assert.equal(normalizeCacheKey("https://x.test/p?b=2&a=1&a=0"), "https://x.test/p?a=0&a=1&b=2", "repeated params sorted by value");
  assert.equal(normalizeCacheKey("https://x.test/p"), "https://x.test/p");
});

test("ApiResponseCache: miss, then hit under any equivalent URL, with fetched-at timestamp", () => {
  const cache = new ApiResponseCache(":memory:");
  assert.equal(cache.get("https://x.test/p?a=1&b=2"), null);
  cache.set("https://x.test/p?a=1&b=2", { hello: ["world"] }, 1234);
  assert.deepEqual(cache.get("https://x.test/p?b=2&a=1"), { body: { hello: ["world"] }, fetchedAt: 1234 });
  assert.equal(cache.count(), 1);
  cache.close();
});

// --- client wiring --------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return { status: 200, ok: true, statusText: "OK", json: async () => body } as unknown as Response;
}

// Counts reservations so tests can prove a cache hit never takes a
// rate-limit slot, and hands out "now" so nothing actually sleeps.
function countingReserver() {
  const r = { reservations: 0, reserve: () => (r.reservations++, Date.now()) };
  return r;
}

afterEach(() => {
  __resetFetchImplForTests();
  __setApiCacheForTests(undefined);
  __setSlotReserverForTests(undefined);
});

test("getMarketByConditionId: a finalized market is fetched once, then served from cache without a rate-limit slot", async () => {
  const cache = new ApiResponseCache(":memory:");
  __setApiCacheForTests(cache);
  const slots = countingReserver();
  __setSlotReserverForTests(slots);
  const urls: string[] = [];
  __setFetchImplForTests(async (url) => {
    urls.push(String(url));
    return jsonResponse([{ ...settled, extraField: "kept" }]);
  });

  const first = await getMarketByConditionId("0xABC", true);
  const second = await getMarketByConditionId("0xABC", true);
  assert.equal(urls.length, 1);
  assert.equal(slots.reservations, 1, "the hit didn't reserve a slot");
  assert.deepEqual(second, first);
  assert.deepEqual(getApiCacheStats(), { hits: 1, misses: 1, stored: 1 });
  // Raw response stored, including fields the zod schema strips.
  assert.equal((cache.get(urls[0])!.body as { extraField: string }[])[0].extraField, "kept");
});

test("getMarketByConditionId: open and not-found lookups are never cached", async () => {
  __setApiCacheForTests(new ApiResponseCache(":memory:"));
  __setSlotReserverForTests(countingReserver());
  let fetches = 0;
  __setFetchImplForTests(async (url) => {
    fetches++;
    return jsonResponse(String(url).includes("closed=true") ? [] : [{ ...settled, closed: false, outcomePrices: '["0.4","0.6"]' }]);
  });
  for (let i = 0; i < 2; i++) {
    assert.equal(await getMarketByConditionId("0xABC", true), null);
    assert.equal((await getMarketByConditionId("0xABC", false))?.closed, false);
  }
  assert.equal(fetches, 4);
  assert.equal(getApiCacheStats().stored, 0);
});

test("getPricesHistory: cached only when the caller vouches with a finalized market and the window is old", async () => {
  __setApiCacheForTests(new ApiResponseCache(":memory:"));
  __setSlotReserverForTests(countingReserver());
  let fetches = 0;
  __setFetchImplForTests(async () => {
    fetches++;
    return jsonResponse({ history: [{ t: 100, p: 0.42 }] });
  });
  const oldEnd = Math.floor(Date.now() / 1000) - PRICE_HISTORY_SETTLE_MARGIN_SECONDS - 60;

  await getPricesHistory("tok-yes", oldEnd - 600, oldEnd, 1); // no market -> never cached
  await getPricesHistory("tok-yes", oldEnd - 600, oldEnd, 1);
  assert.equal(fetches, 2);

  const recentEnd = Math.floor(Date.now() / 1000) - 60;
  await getPricesHistory("tok-yes", recentEnd - 600, recentEnd, 1, { market: settled });
  await getPricesHistory("tok-yes", recentEnd - 600, recentEnd, 1, { market: settled });
  assert.equal(fetches, 4, "window inside the settle margin");

  const a = await getPricesHistory("tok-yes", oldEnd - 600, oldEnd, 1, { market: settled });
  const b = await getPricesHistory("tok-yes", oldEnd - 600, oldEnd, 1, { market: settled });
  assert.equal(fetches, 5, "second call was a hit");
  assert.deepEqual(b, a);
  await getPricesHistory("tok-yes", oldEnd - 600, oldEnd, 5, { market: settled });
  assert.equal(fetches, 6, "fidelity is part of the key");
});

test("a cached body that no longer fits the schema is treated as a miss and refetched", async () => {
  const cache = new ApiResponseCache(":memory:");
  __setApiCacheForTests(cache);
  __setSlotReserverForTests(countingReserver());
  cache.set("https://gamma-api.polymarket.com/markets?condition_ids=0xABC&closed=true", [{ nonsense: true }]);
  let fetches = 0;
  __setFetchImplForTests(async () => {
    fetches++;
    return jsonResponse([settled]);
  });
  assert.equal((await getMarketByConditionId("0xABC", true))?.conditionId, "0xABC");
  assert.equal(fetches, 1);
  assert.deepEqual(getApiCacheStats(), { hits: 0, misses: 1, stored: 1 });
});

test("with no cache injected, a stubbed-fetch test never reads or writes a cache", async () => {
  __setSlotReserverForTests(countingReserver());
  let fetches = 0;
  __setFetchImplForTests(async () => {
    fetches++;
    return jsonResponse([settled]);
  });
  await getMarketByConditionId("0xABC", true);
  await getMarketByConditionId("0xABC", true);
  assert.equal(fetches, 2);
});

// --- real client wiring in child processes (env vars, persistence) --------

function runCacheWorker(env: Record<string, string>): { fetches: number; stats: { hits: number } } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, POLYCOPY_SHARED_RATELIMIT: "0" };
  delete childEnv.NODE_TEST_CONTEXT; // the worker must look like a normal run, not a test file
  const out = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "helpers", "apiCacheWorker.ts"), "2"], {
    env: childEnv,
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split("\n").pop()!);
}

test("POLYCOPY_API_CACHE=0 disables reads and writes; otherwise the cache persists across processes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polycopy-cache-"));
  const file = path.join(dir, "api-cache.db");
  try {
    const disabled = runCacheWorker({ POLYCOPY_API_CACHE: "0", POLYCOPY_API_CACHE_PATH: file });
    assert.equal(disabled.fetches, 2);
    assert.equal(fs.existsSync(file), false, "disabled cache never creates its file");

    const cold = runCacheWorker({ POLYCOPY_API_CACHE_PATH: file });
    assert.equal(cold.fetches, 1, "second in-process call hit");
    const warm = runCacheWorker({ POLYCOPY_API_CACHE_PATH: file });
    assert.equal(warm.fetches, 0, "a fresh process is served entirely from the persisted cache");
    assert.equal(warm.stats.hits, 2);

    const disabledAgain = runCacheWorker({ POLYCOPY_API_CACHE: "false", POLYCOPY_API_CACHE_PATH: file });
    assert.equal(disabledAgain.fetches, 2, "disabled also means no reads from an existing cache");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- K4 batch market lookup ----------------------------------------------

// A fake gamma /markets honoring repeated condition_ids, `closed`, and a
// default cap of 20 without `limit` (the live behavior checked 2026-09-25).
function fakeGamma(markets: Record<string, { closed: boolean; outcomePrices: string }>) {
  const urls: string[] = [];
  const impl = async (url: string | URL | Request) => {
    const u = new URL(String(url));
    urls.push(u.toString());
    const ids = u.searchParams.getAll("condition_ids");
    const closed = u.searchParams.get("closed") === "true";
    const limit = Number(u.searchParams.get("limit") ?? 20);
    const found = ids
      .filter((id) => markets[id] && markets[id].closed === closed)
      .map((id) => ({ ...settled, conditionId: id, ...markets[id] }))
      .slice(0, limit);
    return jsonResponse(found);
  };
  return { urls, impl };
}

test("getMarketsByConditionIds: batches of 50, closed then open, missing ids absent -- same answers as single lookups", async () => {
  __setApiCacheForTests(undefined);
  __setSlotReserverForTests(countingReserver());
  const markets: Record<string, { closed: boolean; outcomePrices: string }> = {};
  const ids: string[] = [];
  for (let i = 0; i < 120; i++) {
    const id = `0x${i.toString(16).padStart(4, "0")}`;
    ids.push(id);
    if (i % 10 === 9) continue; // gamma doesn't know this one
    markets[id] = i % 3 === 0 ? { closed: false, outcomePrices: '["0.4","0.6"]' } : { closed: true, outcomePrices: '["1","0"]' };
  }
  const gamma = fakeGamma(markets);
  __setFetchImplForTests(gamma.impl);

  const batch = await getMarketsByConditionIds(ids);
  assert.equal(gamma.urls.length, 3 + 1, "3 closed=true chunks of <=50, then 1 closed=false chunk for the leftovers");
  for (const id of ids) {
    const single = (await getMarketByConditionId(id, true)) ?? (await getMarketByConditionId(id, false));
    assert.deepEqual(batch.get(id) ?? null, single, id);
  }
});

test("getMarketsByConditionIds: finalized markets go into the single-lookup cache key, and are read back from it", async () => {
  const cache = new ApiResponseCache(":memory:");
  __setApiCacheForTests(cache);
  __setSlotReserverForTests(countingReserver());
  const gamma = fakeGamma({
    "0xAA": { closed: true, outcomePrices: '["1","0"]' },
    "0xBB": { closed: false, outcomePrices: '["0.5","0.5"]' },
  });
  __setFetchImplForTests(gamma.impl);

  await getMarketsByConditionIds(["0xAA", "0xBB"]);
  assert.equal(getApiCacheStats().stored, 1, "only the finalized market is stored");
  const before = gamma.urls.length;
  assert.equal((await getMarketByConditionId("0xAA", true))?.conditionId, "0xAA");
  assert.equal(gamma.urls.length, before, "single lookup served from the batch-written cache entry");
  const again = await getMarketsByConditionIds(["0xAA"]);
  assert.equal(again.get("0xAA")?.closed, true);
  assert.equal(gamma.urls.length, before, "batch lookup also served from cache");
});
