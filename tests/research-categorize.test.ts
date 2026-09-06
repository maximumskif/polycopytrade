// Regression test for a real bug found 2026-08-15 while auditing
// 0x1b20a0...'s trade breakdown: the sports keyword " vs " (space-vs-space)
// never matches real market titles phrased "Team A vs. Team B" (period,
// no space before it), silently misfiling most non-O/U MLB/UFC moneyline
// bets as "other" -- including in the LIVE paper-trading category filter
// (src/paperTrading/engine.ts), not just backtest reporting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { categorize } from "../src/categorize";

test("a 'Team A vs. Team B' moneyline title (period, no trailing space) is categorized as sports", () => {
  assert.equal(categorize("New York Yankees vs. Chicago White Sox"), "sports");
});

test("a 'Team A vs Team B' title (no period) is still categorized as sports", () => {
  assert.equal(categorize("Lakers vs Celtics"), "sports");
});

test("an O/U-suffixed title is still categorized as sports", () => {
  assert.equal(categorize("Pittsburgh Pirates vs. Cincinnati Reds: O/U 9.5"), "sports");
});

test("a non-sports title is categorized as other", () => {
  assert.equal(categorize("Will X happen?"), "other");
});
