import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, resultKeySpace, roundTripReturn, simulateExit } from "../src/research/takeProfitScan";

const path = [
  { t: 1, p: 0.9 },
  { t: 2, p: 0.92 },
  { t: 3, p: 0.8 },
];

test("simulateExit: first take-profit or stop touch, else resolution", () => {
  assert.deepEqual(simulateExit(path, 0.9, false, { tpCents: 2, stopCents: 0 }), { exitQuote: 0.92, early: true, target: 0.92 });
  assert.equal(simulateExit(path, 0.9, false, { tpCents: 0, stopCents: 5 }).exitQuote, 0.8);
  assert.deepEqual(simulateExit(path, 0.9, true, { tpCents: 5, stopCents: 0 }), { exitQuote: 1, early: false });
  assert.deepEqual(simulateExit(path, 0.9, false, { tpCents: 0, stopCents: 0 }), { exitQuote: 0, early: false });
});

test("roundTripReturn: fees on both taker legs, maker exit at the target for free", () => {
  // no costs: buy 0.9, sell 0.92 -> +2.22%
  assert.ok(Math.abs(roundTripReturn(0.9, { exitQuote: 0.92, early: true }, 0, 0) - (0.92 / 0.9 - 1)) < 1e-9);
  // taker both ways at 5%: a +1c move loses money
  assert.ok(roundTripReturn(0.9, { exitQuote: 0.91, early: true }, 0.05, 100) < 0);
  // maker exit ignores the observed overshoot and pays no exit costs
  const maker = roundTripReturn(0.9, { exitQuote: 0.95, early: true, target: 0.91 }, 0, 0, true);
  assert.ok(Math.abs(maker - (0.91 / 0.9 - 1)) < 1e-9);
  // held to resolution: loss is the whole stake
  assert.equal(roundTripReturn(0.9, { exitQuote: 0, early: false }, 0.05, 100), -1);
});

test("parseArgs requires a cache; key space covers the grid", () => {
  assert.throws(() => parseArgs([]));
  const a = parseArgs(["--cache=x.json", "--makerExit"]);
  assert.equal(a.makerExit, true);
  assert.deepEqual(resultKeySpace(a).slippageBps, [100, 300]);
});
