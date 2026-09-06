// Regression tests for walletStats.ts's clusterFills(), flagged as an
// untested edge case in docs/AUDIT.md §9 ("has real edge cases -- fills
// exactly 120s apart, fills across a clustering boundary -- with no test").
// /activity returns one row per FILL, not per decision; clusterFills groups
// same-market/outcome/side fills within a 120s gap into synthetic orders so
// downstream stats report real order counts/sizes, not inflated fill counts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterFills } from "../src/research/walletStats";
import type { Activity } from "../src/api/client";

let seq = 0;
function fill(overrides: Partial<Activity> = {}): Activity {
  seq += 1;
  return {
    timestamp: 1_000_000,
    conditionId: "0xcond",
    type: "TRADE",
    size: 10,
    usdcSize: 5,
    price: 0.5,
    side: "BUY",
    outcome: "Yes",
    title: "Some market",
    slug: "some-market",
    proxyWallet: "0xwallet",
    transactionHash: `0xtx${seq}`,
    ...overrides,
  };
}

test("two fills exactly 120s apart in the same market/outcome/side merge into one order", () => {
  const orders = clusterFills([fill({ timestamp: 1000 }), fill({ timestamp: 1120 })]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].fillCount, 2);
  assert.equal(orders[0].firstTs, 1000);
  assert.equal(orders[0].lastTs, 1120);
});

test("two fills 121s apart in the same market/outcome/side stay separate orders", () => {
  const orders = clusterFills([fill({ timestamp: 1000 }), fill({ timestamp: 1121 })]);
  assert.equal(orders.length, 2);
  assert.equal(orders[0].fillCount, 1);
  assert.equal(orders[1].fillCount, 1);
});

test("a chain of fills each <=120s from the previous one all merge into a single order", () => {
  const orders = clusterFills([
    fill({ timestamp: 1000 }),
    fill({ timestamp: 1100 }),
    fill({ timestamp: 1200 }),
    fill({ timestamp: 1300 }),
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].fillCount, 4);
  assert.equal(orders[0].firstTs, 1000);
  assert.equal(orders[0].lastTs, 1300);
});

test("the 120s gap resets from the last fill in the cluster, not the first", () => {
  // 1000 -> 1120 (gap 120, merges) -> 1240 (gap from 1120 is 120, merges) --
  // total span is 240s, well past 120, but each consecutive gap is exactly
  // at the boundary, so this must still be one order.
  const orders = clusterFills([fill({ timestamp: 1000 }), fill({ timestamp: 1120 }), fill({ timestamp: 1240 })]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].fillCount, 3);
});

test("fills on different outcomes never merge, even at the same timestamp", () => {
  const orders = clusterFills([fill({ timestamp: 1000, outcome: "Yes" }), fill({ timestamp: 1000, outcome: "No" })]);
  assert.equal(orders.length, 2);
});

test("fills on different sides never merge, even at the same timestamp", () => {
  const orders = clusterFills([fill({ timestamp: 1000, side: "BUY" }), fill({ timestamp: 1000, side: "SELL" })]);
  assert.equal(orders.length, 2);
});

test("fills on different markets never merge, even at the same timestamp", () => {
  const orders = clusterFills([fill({ timestamp: 1000, conditionId: "0xa" }), fill({ timestamp: 1000, conditionId: "0xb" })]);
  assert.equal(orders.length, 2);
});

test("usdcSize and size accumulate across a merged cluster", () => {
  const orders = clusterFills([
    fill({ timestamp: 1000, usdcSize: 5, size: 10 }),
    fill({ timestamp: 1050, usdcSize: 3, size: 6 }),
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].usdcSize, 8);
  assert.equal(orders[0].size, 16);
});

test("clustering is order-independent -- unsorted input produces the same orders as sorted input", () => {
  const unsorted = [
    fill({ timestamp: 5000, conditionId: "0xb" }),
    fill({ timestamp: 1000, conditionId: "0xa" }),
    fill({ timestamp: 1050, conditionId: "0xa" }),
  ];
  const orders = clusterFills(unsorted);
  assert.equal(orders.length, 2);
  const a = orders.find((o) => o.conditionId === "0xa")!;
  const b = orders.find((o) => o.conditionId === "0xb")!;
  assert.equal(a.fillCount, 2);
  assert.equal(b.fillCount, 1);
});
