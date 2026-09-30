import { test } from "node:test";
import assert from "node:assert/strict";
import { midpoint, orderScore, placeQuote, qMin, sideQ } from "../src/research/rewardsScan";

test("orderScore follows the documented worked example", () => {
  // 0.50 mid, 3c max spread, bid at 0.49 -> ((3-1)/3)^2
  assert.ok(Math.abs(orderScore(1, 3) - 4 / 9) < 1e-12);
  assert.equal(orderScore(3.5, 3), 0);
});

test("qMin: single-sided scores at 1/3 inside [0.10, 0.90], zero outside", () => {
  assert.equal(qMin(9, 0, 0.5), 3);
  assert.equal(qMin(9, 6, 0.5), 6);
  assert.equal(qMin(9, 0, 0.95), 0);
});

test("sideQ counts complement orders at 1-p and drops sub-min-size orders", () => {
  const q = sideQ(
    [{ price: 0.49, size: 100 }],
    [
      { price: 0.51, size: 100 },
      { price: 0.5, size: 5 },
    ],
    0.5,
    3,
    10
  );
  // YES bid 0.49 (1c) + NO ask 0.51 = YES 0.49 (1c); the 5-share order is below min size
  assert.ok(Math.abs(q - 2 * (4 / 9) * 100) < 1e-9);
  assert.equal(midpoint([{ price: 0.4, size: 1 }], [{ price: 0.6, size: 1 }]), 0.5);
});

test("placeQuote joins the top or sits 1c behind, clamped to max spread", () => {
  assert.deepEqual(placeQuote(0.5, 0.48, 0.52, 3, "top"), { bid: 0.48, ask: 0.52 });
  assert.deepEqual(placeQuote(0.5, 0.48, 0.52, 3, "behind"), { bid: 0.47, ask: 0.53 });
  assert.deepEqual(placeQuote(0.5, 0.2, 0.9, 3, "top"), { bid: 0.47, ask: 0.53 });
});
