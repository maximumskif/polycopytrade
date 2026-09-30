import { test } from "node:test";
import assert from "node:assert/strict";
import { fillPnl, intervalFills } from "../src/research/rewardsPaper";

test("intervalFills: trades through our bid buy YES, through our ask buy NO, capped at size", () => {
  const q = { bid: 0.45, ask: 0.55 };
  const f = intervalFills(
    [
      { price: 0.44, size: 30 },
      { price: 0.45, size: 100 }, // at the bid: not through
      { price: 0.56, size: 10 },
      { price: 0.4, size: 30 },
    ],
    q,
    50
  );
  assert.deepEqual(f, { boughtYes: 50, boughtNo: 10 });
});

test("fillPnl: YES at bid, NO at 1-ask, settled at resolution", () => {
  const q = { bid: 0.45, ask: 0.55 };
  assert.ok(Math.abs(fillPnl({ boughtYes: 10, boughtNo: 0 }, q, true) - 5.5) < 1e-9);
  assert.ok(Math.abs(fillPnl({ boughtYes: 10, boughtNo: 0 }, q, false) + 4.5) < 1e-9);
  assert.ok(Math.abs(fillPnl({ boughtYes: 0, boughtNo: 10 }, q, true) + 4.5) < 1e-9);
  // a matched pair locks in the spread whatever happens
  assert.ok(Math.abs(fillPnl({ boughtYes: 10, boughtNo: 10 }, q, false) - 1) < 1e-9);
});
