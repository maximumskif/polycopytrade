import { test } from "node:test";
import assert from "node:assert/strict";
import { kellyFraction, simulateBankroll, wilsonLowerBound } from "../src/backtesting/bankrollSimulation";

test("wilsonLowerBound: a small sample's lower bound sits well below its raw win rate", () => {
  // 9/10 wins = 90% raw, but n=10 is a thin sample -- the lower bound
  // should reflect real uncertainty, not just restate 0.9.
  const bound = wilsonLowerBound(9, 10);
  assert.ok(bound < 0.9, `expected a conservative bound below 0.9, got ${bound}`);
  assert.ok(bound > 0);
});

test("wilsonLowerBound: a large sample's lower bound converges close to its raw win rate", () => {
  const bound = wilsonLowerBound(900, 1000);
  assert.ok(bound > 0.87 && bound < 0.9, `expected a bound close to 0.9 with a large sample, got ${bound}`);
});

test("wilsonLowerBound: zero trials returns 0, not NaN", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test("kellyFraction: a coin flip at fair odds (price=0.5, pWin=0.5) has zero edge", () => {
  const f = kellyFraction(0.5, 0.5);
  assert.ok(Math.abs(f) < 1e-9, `expected ~0 edge, got ${f}`);
});

test("kellyFraction: a real edge (higher win prob than the price implies) is positive", () => {
  // price=0.5 implies the market thinks pWin=0.5; believing pWin=0.6 is a real edge.
  const f = kellyFraction(0.6, 0.5);
  assert.ok(f > 0, `expected a positive edge, got ${f}`);
});

test("kellyFraction: believing LESS than the price implies gives zero, not a negative stake", () => {
  const f = kellyFraction(0.4, 0.5);
  assert.equal(f, 0);
});

test("kellyFraction: matches a hand-computed value", () => {
  // price=0.9, pWin=0.95 -> b = 1/0.9 - 1 = 0.1111..., f = 0.95 - 0.05/0.1111... = 0.95 - 0.45 = 0.5
  const f = kellyFraction(0.95, 0.9);
  assert.ok(Math.abs(f - 0.5) < 1e-6, `expected ~0.5, got ${f}`);
});

test("kellyFraction: out-of-range price returns 0, not NaN/Infinity", () => {
  assert.equal(kellyFraction(0.9, 0), 0);
  assert.equal(kellyFraction(0.9, 1), 0);
  assert.equal(kellyFraction(0.9, -0.1), 0);
});

test("simulateBankroll: an all-winning sequence at a real edge grows the bankroll monotonically", () => {
  const bets = Array.from({ length: 20 }, () => ({ won: true, price: 0.9 }));
  const result = simulateBankroll(bets, { pWinEstimate: 0.95, startingBankroll: 1000 });
  assert.ok(result.finalBankroll > result.startingBankroll, `expected growth, got ${result.finalBankroll}`);
  for (let i = 1; i < result.bankrollCurve.length; i++) {
    assert.ok(result.bankrollCurve[i] >= result.bankrollCurve[i - 1], "bankroll should never decrease on an all-win sequence");
  }
  assert.equal(result.wins, 20);
  assert.ok(!result.busted);
});

test("simulateBankroll: an all-losing sequence shrinks the bankroll but never goes negative", () => {
  const bets = Array.from({ length: 50 }, () => ({ won: false, price: 0.9 }));
  const result = simulateBankroll(bets, { pWinEstimate: 0.95, startingBankroll: 1000 });
  assert.ok(result.finalBankroll < result.startingBankroll);
  assert.ok(result.finalBankroll >= 0);
  for (const b of result.bankrollCurve) assert.ok(b >= 0, "bankroll must never go negative");
});

test("simulateBankroll: a negative edge (pWinEstimate below what the price implies) places no bets", () => {
  const bets = Array.from({ length: 10 }, () => ({ won: true, price: 0.9 }));
  // price=0.9 implies break-even at pWin=0.9; believing pWin=0.8 is a clearly negative edge.
  const result = simulateBankroll(bets, { pWinEstimate: 0.8, startingBankroll: 1000 });
  assert.equal(result.betsPlaced, 0);
  assert.equal(result.finalBankroll, result.startingBankroll);
});

test("simulateBankroll: maxStakeFraction caps the stake even when Kelly suggests more", () => {
  // A huge edge (pWin=0.999 at price=0.5) would want to stake a large fraction --
  // maxStakeFraction should visibly cap growth per bet.
  const bets = [{ won: true, price: 0.5 }];
  const uncapped = simulateBankroll(bets, { pWinEstimate: 0.999, kellyFractionMultiplier: 1, maxStakeFraction: 1, startingBankroll: 1000 });
  const capped = simulateBankroll(bets, { pWinEstimate: 0.999, kellyFractionMultiplier: 1, maxStakeFraction: 0.05, startingBankroll: 1000 });
  assert.ok(capped.finalBankroll < uncapped.finalBankroll, "capped stake should grow the bankroll less than uncapped");
});

test("simulateBankroll: a bankroll that hits zero is marked busted and stops betting further", () => {
  // pWinEstimate=1.0 at price=0.5 -> kellyFraction=1 (certain-edge edge case) -> the
  // whole bankroll gets staked; a loss on that bet empties it exactly.
  const bets = [
    { won: false, price: 0.5 },
    { won: true, price: 0.9 }, // should never be reached
  ];
  const result = simulateBankroll(bets, { pWinEstimate: 1.0, kellyFractionMultiplier: 1, maxStakeFraction: 1, startingBankroll: 1000 });
  assert.ok(result.busted);
  assert.equal(result.finalBankroll, 0);
  assert.equal(result.betsPlaced, 1, "should not place the second bet after busting");
});

test("simulateBankroll: maxDrawdownPct reflects a real peak-to-trough drop", () => {
  const bets = [
    { won: true, price: 0.5 }, // grow
    { won: false, price: 0.5 }, // then lose some back
    { won: false, price: 0.5 },
  ];
  const result = simulateBankroll(bets, { pWinEstimate: 0.7, kellyFractionMultiplier: 1, maxStakeFraction: 0.3, startingBankroll: 1000 });
  assert.ok(result.maxDrawdownPct > 0, "a win followed by losses should show a real drawdown");
  assert.ok(result.maxDrawdownPct <= 1);
});
