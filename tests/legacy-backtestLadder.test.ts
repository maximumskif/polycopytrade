// Regression tests for the ladder-return calculation bug found while
// auditing the repo (2026-08-13): summarize() used to sum each trial's
// binary `payout` (0 or 1) as the return on a $1 stake, which silently
// assumes every winning $1 stake pays back exactly $1 regardless of entry
// price. A $1 stake at price p actually buys 1/p shares, each worth $1 if
// it wins — so the true payout on a win is 1/p, not 1. The bug made every
// reported "net" collapse to (winRate - 1), independent of entry price;
// confirmed against the original Phase 1a README table, where every
// bucket's published net matched winRate-100% to one decimal place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, type Trial } from "../src/legacy/backtestLadder";

function trial(entryPrice: number, won: boolean): Trial {
  const payout = won ? 1 : 0;
  return {
    asset: "WTI",
    event: "test event",
    market: "test market",
    side: "Yes",
    entryPrice,
    won,
    payout,
    pnlPerDollarStaked: payout / entryPrice - 1,
  };
}

test("a single winning trial at 50c returns 2 shares ($2), not $1", () => {
  const s = summarize([trial(0.5, true)]);
  assert.equal(s.n, 1);
  assert.equal(s.totalStaked, 1);
  assert.equal(s.sharesAcquired, 2);
  assert.equal(s.grossReturned, 2);
  assert.equal(s.netProfit, 1);
  assert.equal(s.roi, 1); // +100%, not the old bug's 0%
});

test("a single losing trial still acquires shares but returns nothing", () => {
  const s = summarize([trial(0.2, false)]);
  assert.equal(s.sharesAcquired, 5); // $1 / 0.20 = 5 shares, win or lose
  assert.equal(s.grossReturned, 0);
  assert.equal(s.netProfit, -1);
  assert.equal(s.roi, -1);
});

test("fair-odds pricing at the true win probability nets to ~breakeven, not winRate-100%", () => {
  // Ten trials priced at 50c; exactly 5 win (the price's own implied
  // probability). A fairly-priced market should net to ~0%. The old bug
  // would have reported net = winRate - 100% = 50% - 100% = -50% here,
  // which is the exact failure mode this test guards against.
  const trials = [...Array.from({ length: 5 }, () => trial(0.5, true)), ...Array.from({ length: 5 }, () => trial(0.5, false))];
  const s = summarize(trials);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.sharesAcquired, 20); // 10 trials * 2 shares each
  assert.equal(s.grossReturned, 10); // 5 winners * 2 shares
  assert.equal(s.netProfit, 0);
  assert.equal(s.roi, 0);
});

test("cheap longshots need a correspondingly lower win rate to break even", () => {
  // 10 trials at 10c; breakeven win rate is ~10%. Exactly 1 win (10%)
  // should net to ~0%, not net = 10% - 100% = -90% (the old bug).
  const trials = [...Array.from({ length: 1 }, () => trial(0.1, true)), ...Array.from({ length: 9 }, () => trial(0.1, false))];
  const s = summarize(trials);
  assert.equal(s.sharesAcquired, 100); // 10 trials * 10 shares each
  assert.equal(s.grossReturned, 10); // 1 winner * 10 shares
  assert.equal(s.netProfit, 0);
  assert.equal(s.roi, 0);
});

test("empty trial set does not divide by zero", () => {
  const s = summarize([]);
  assert.equal(s.n, 0);
  assert.equal(s.winRate, 0);
  assert.equal(s.roi, 0);
  assert.equal(s.avgEntryPrice, 0);
});
