// Phase 3 paper-trading engine tests. Runs against a throwaway in-memory
// SQLite database (same pattern as tests/storage.test.ts) with a mocked
// fetch (same pattern as tests/followerExecution.test.ts) -- no live
// network, no real data touched.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __setDbForTests, __resetDbForTests } from "../src/storage/db";
import { __setFetchImplForTests, __resetFetchImplForTests } from "../src/api/client";
import { runMigrations } from "../src/storage/migrate";
import { upsertWallet, insertActivity, listPaperOrders } from "../src/storage/repository";
import { processNewFills, resolveOpenOrders } from "../src/paperTrading/engine";
import type { PaperTradeTarget } from "../src/paperTrading/config";
import type { Activity } from "../src/api/schemas";
import type { TrackedWallet } from "../src/wallets";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  __setDbForTests(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  __resetDbForTests();
  __resetFetchImplForTests();
});

const wallet: TrackedWallet = { address: "0xabc", label: "test wallet", archetype: "unclassified", source: "test" };

const target: PaperTradeTarget = {
  address: wallet.address,
  label: "test target",
  categoryFilter: "sports",
  stakeUsdc: 100,
  delaySeconds: 30,
};

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    timestamp: 1000,
    conditionId: "c1",
    type: "TRADE",
    size: 10,
    usdcSize: 5,
    price: 0.5,
    side: "BUY",
    outcome: "Yes",
    title: "Lakers vs Celtics", // categorize() -> "sports"
    slug: "s",
    proxyWallet: wallet.address,
    transactionHash: "tx-1",
    ...overrides,
  };
}

function fakeResponse(body: unknown): Response {
  return { status: 200, ok: true, statusText: "OK", json: async () => body } as unknown as Response;
}

function fakeMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    conditionId: "c1",
    question: "q",
    slug: "s",
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["1", "0"]),
    clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
    endDate: "2026-01-01T00:00:00Z",
    closed: true,
    ...overrides,
  };
}

test("a fill matching excludeTitleKeywords is never turned into a paper order, even if the category matches", async () => {
  upsertWallet(wallet);
  insertActivity(wallet.address, [makeActivity({ title: "UFC Fight Night: A vs. B" })]); // categorize() -> "sports"
  __setFetchImplForTests(async () => {
    throw new Error("should never call the API for an excluded fill");
  });

  const result = await processNewFills({ ...target, excludeTitleKeywords: ["UFC"] });
  assert.deepEqual(result, { examined: 0, filled: 0, unresolvable: 0 });
  assert.equal(listPaperOrders(wallet.address).length, 0);
});

test("a fill below minLeaderStakeUsdc is never turned into a paper order, even if category/keywords pass", async () => {
  upsertWallet(wallet);
  insertActivity(wallet.address, [makeActivity({ usdcSize: 100 })]); // categorize() -> "sports", below the $5000 threshold
  __setFetchImplForTests(async () => {
    throw new Error("should never call the API for a below-threshold fill");
  });

  const result = await processNewFills({ ...target, minLeaderStakeUsdc: 5000 });
  assert.deepEqual(result, { examined: 0, filled: 0, unresolvable: 0 });
  assert.equal(listPaperOrders(wallet.address).length, 0);
});

test("a fill at or above minLeaderStakeUsdc is still copied normally", async () => {
  upsertWallet(wallet);
  insertActivity(wallet.address, [makeActivity({ usdcSize: 5000 })]);
  __setFetchImplForTests(async (url) => {
    const s = url.toString();
    if (s.includes("/markets")) return fakeResponse([fakeMarket({ closed: false })]);
    if (s.includes("prices-history")) return fakeResponse({ history: [{ t: 1035, p: 0.55 }] });
    throw new Error(`unexpected URL: ${s}`);
  });

  const result = await processNewFills({ ...target, minLeaderStakeUsdc: 5000 });
  assert.equal(result.filled, 1);
  assert.equal(listPaperOrders(wallet.address).length, 1);
});

test("a fill outside the category filter is never turned into a paper order", async () => {
  upsertWallet(wallet);
  insertActivity(wallet.address, [makeActivity({ title: "Will X happen?" })]); // categorize() -> "other", not "sports"
  __setFetchImplForTests(async () => {
    throw new Error("should never call the API for a filtered-out fill");
  });

  const result = await processNewFills(target);
  assert.deepEqual(result, { examined: 0, filled: 0, unresolvable: 0 });
  assert.equal(listPaperOrders(wallet.address).length, 0);
});

test("a fill already copied is not re-processed on the next cycle", async () => {
  upsertWallet(wallet);
  insertActivity(wallet.address, [makeActivity()]);
  __setFetchImplForTests(async (url) => {
    const s = url.toString();
    if (s.includes("/markets")) return fakeResponse([fakeMarket({ closed: false })]);
    if (s.includes("prices-history")) return fakeResponse({ history: [{ t: 1035, p: 0.55 }] });
    throw new Error(`unexpected URL: ${s}`);
  });

  const first = await processNewFills(target);
  assert.equal(first.filled, 1);
  const second = await processNewFills(target);
  assert.deepEqual(second, { examined: 0, filled: 0, unresolvable: 0 });
  assert.equal(listPaperOrders(wallet.address).length, 1);
});

test("an order with no observable follower price is marked unresolvable, not dropped or retried", async () => {
  upsertWallet(wallet);
  insertActivity(wallet.address, [makeActivity()]);
  __setFetchImplForTests(async (url) => {
    const s = url.toString();
    if (s.includes("/markets")) return fakeResponse([fakeMarket({ closed: false })]);
    if (s.includes("prices-history")) return fakeResponse({ history: [{ t: 990, p: 0.5 }] }); // only a pre-fill tick
    throw new Error(`unexpected URL: ${s}`);
  });

  const result = await processNewFills(target);
  assert.deepEqual(result, { examined: 1, filled: 0, unresolvable: 1 });

  const orders = listPaperOrders(wallet.address);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "unresolvable");
  assert.equal(orders[0].followerEntryPrice, null);

  // Re-running must not re-examine it -- it's already got a paper_orders row.
  const second = await processNewFills(target);
  assert.deepEqual(second, { examined: 0, filled: 0, unresolvable: 0 });
});

test("resolveOpenOrders books correct P&L for a win (payout = stake / entryPrice) and a loss (payout = 0)", async () => {
  upsertWallet(wallet);
  insertActivity(wallet.address, [
    makeActivity({ transactionHash: "tx-win", conditionId: "c-win", outcome: "Yes" }),
    makeActivity({ transactionHash: "tx-loss", conditionId: "c-loss", outcome: "Yes" }),
  ]);

  __setFetchImplForTests(async (url) => {
    const s = url.toString();
    if (s.includes("condition_ids=c-win")) return fakeResponse([fakeMarket({ conditionId: "c-win", closed: false })]);
    if (s.includes("condition_ids=c-loss")) return fakeResponse([fakeMarket({ conditionId: "c-loss", closed: false })]);
    if (s.includes("prices-history")) return fakeResponse({ history: [{ t: 1035, p: 0.4 }] }); // followerEntryPrice = 0.4 for both
    throw new Error(`unexpected URL: ${s}`);
  });
  await processNewFills(target);

  // Now the markets have settled: c-win resolves Yes, c-loss resolves No.
  __setFetchImplForTests(async (url) => {
    const s = url.toString();
    if (s.includes("condition_ids=c-win"))
      return fakeResponse([fakeMarket({ conditionId: "c-win", closed: true, outcomePrices: JSON.stringify(["1", "0"]) })]);
    if (s.includes("condition_ids=c-loss"))
      return fakeResponse([fakeMarket({ conditionId: "c-loss", closed: true, outcomePrices: JSON.stringify(["0", "1"]) })]);
    throw new Error(`unexpected URL: ${s}`);
  });
  const { resolved } = await resolveOpenOrders();
  assert.equal(resolved, 2);

  const orders = listPaperOrders(wallet.address);
  const win = orders.find((o) => o.conditionId === "c-win")!;
  const loss = orders.find((o) => o.conditionId === "c-loss")!;

  assert.equal(win.status, "won");
  assert.ok(Math.abs(win.payoutUsdc! - 100 / 0.4) < 1e-9); // stake / followerEntryPrice
  assert.ok(Math.abs(win.pnlUsdc! - (100 / 0.4 - 100)) < 1e-9);

  assert.equal(loss.status, "lost");
  assert.equal(loss.payoutUsdc, 0);
  assert.equal(loss.pnlUsdc, -100);
});
