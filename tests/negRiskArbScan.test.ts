import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annualized,
  classifyEvent,
  daysToEnd,
  feeRateFor,
  persistence,
  priceBaskets,
  takeCost,
  type ArbEvent,
  type ArbMarket,
  type Leg,
} from "../src/research/negRiskArbScan";
import type { OrderBook } from "../src/api/schemas";

function mkt(id: string, over: Partial<ArbMarket> = {}): ArbMarket {
  return { conditionId: id, clobTokenIds: `["y${id}","n${id}"]`, acceptingOrders: true, closed: false, ...over };
}

test("feeRateFor: first matching tag wins, default 5%", () => {
  assert.equal(feeRateFor(["crypto", "politics"]), 0.07);
  assert.equal(feeRateFor(["geopolitics", "politics"]), 0);
  assert.equal(feeRateFor(["weird"]), 0.05);
});

test("classifyEvent: closed set, augmented needs Other, resolved-Yes leg = decided", () => {
  const base: ArbEvent = {
    slug: "e",
    negRisk: true,
    markets: [mkt("a"), mkt("b"), mkt("c", { closed: true, outcomePrices: '["0","1"]' })],
  };
  const c = classifyEvent(base);
  assert.equal(c.completeness, "closed-set");
  assert.deepEqual(
    c.legs.map((l) => l.conditionId),
    ["a", "b"]
  );
  assert.equal(classifyEvent({ ...base, markets: [mkt("a"), mkt("b", { acceptingOrders: false })] }).completeness, "incomplete");
  assert.equal(classifyEvent({ ...base, negRiskAugmented: true }).completeness, "incomplete");
  assert.equal(
    classifyEvent({ ...base, negRiskAugmented: true, markets: [mkt("a"), mkt("o", { negRiskOther: true })] }).completeness,
    "augmented-with-other"
  );
  assert.equal(
    classifyEvent({ ...base, markets: [mkt("a"), mkt("w", { closed: true, outcomePrices: '["1","0"]' })] }).completeness,
    "decided"
  );
  assert.equal(classifyEvent({ ...base, markets: [mkt("a", { feesEnabled: false })] }).legs[0].feeRate, 0);
});

test("takeCost walks depth and adds rate*q*(1-q) per share", () => {
  const asks = [
    { price: 0.3, size: 10 },
    { price: 0.4, size: 10 },
  ];
  assert.ok(Math.abs(takeCost(asks, 15, 0)! - (10 * 0.3 + 5 * 0.4)) < 1e-9);
  assert.ok(Math.abs(takeCost(asks, 10, 0.05)! - 10 * (0.3 + 0.05 * 0.3 * 0.7)) < 1e-9);
  assert.equal(takeCost(asks, 25, 0), null);
  // NO side from YES bids: bid 0.7 -> NO at 0.3
  assert.ok(Math.abs(takeCost([{ price: 0.7, size: 10 }], 10, 0, true)! - 3) < 1e-9);
});

function book(id: string, asks: [number, number][], bids: [number, number][]): [string, OrderBook] {
  const lv = (xs: [number, number][]) => xs.map(([p, s]) => ({ price: String(p), size: String(s) }));
  return [id, { market: "m", asset_id: id, asks: lv(asks), bids: lv(bids) }];
}
const legs: Leg[] = ["a", "b", "c"].map((x) => ({ conditionId: x, label: x, yesToken: `y${x}`, feeRate: 0 }));

test("priceBaskets: YES basket when asks sum < 1, capped by depth", () => {
  const books = new Map([
    book("ya", [[0.3, 100]], [[0.29, 100]]),
    book("yb", [[0.3, 100]], [[0.29, 100]]),
    book("yc", [[0.35, 20]], [[0.34, 100]]),
  ]);
  const opps = priceBaskets(legs, books, [10, 50]);
  assert.equal(opps.length, 1);
  assert.equal(opps[0].kind, "yes");
  assert.equal(opps[0].shares, 10); // leg c only has 20 at the ask -> 50 doesn't fit
  assert.ok(Math.abs(opps[0].profit - 10 * 0.05) < 1e-9);
});

test("priceBaskets: NO basket when YES bids sum > 1, pays n-1", () => {
  const books = new Map([book("ya", [[0.5, 10]], [[0.4, 10]]), book("yb", [[0.5, 10]], [[0.4, 10]]), book("yc", [[0.5, 10]], [[0.3, 10]])]);
  const opps = priceBaskets(legs, books, [10]);
  assert.equal(opps.length, 1);
  assert.equal(opps[0].kind, "no");
  // NO cost = 0.6+0.6+0.7 = 1.9 per set, payout 2
  assert.ok(Math.abs(opps[0].profit - 10 * 0.1) < 1e-9);
  assert.equal(priceBaskets(legs.slice(0, 1), books).length, 0);
});

test("persistence counts consecutive-sweep runs per event+kind", () => {
  const rows = [1, 2, 3, 5, 7, 8].map((sweep) => ({ sweep, event: "e", opp: { kind: "yes" } }));
  assert.deepEqual(persistence(rows).get("e|yes"), [3, 1, 2]);
});

test("daysToEnd / annualized", () => {
  const now = Date.parse("2026-09-29T00:00:00Z");
  assert.equal(daysToEnd("2026-10-09T00:00:00Z", now), 10);
  assert.equal(daysToEnd(undefined, now), null);
  assert.ok(Math.abs(annualized(0.01, 36.5)! - 0.1) < 1e-9);
  assert.equal(annualized(0.01, 0), 3.65);
});
