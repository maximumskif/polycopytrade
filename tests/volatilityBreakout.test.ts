import { test } from "node:test";
import assert from "node:assert/strict";
import { detectVolatilityBreakout, type PricePoint } from "../src/research/volatilityBreakout";

const OPTS = { lookback: 5, compressionPercentile: 0.25, breakoutWindow: 3, breakoutThreshold: 0.05 };

function series(prices: number[]): PricePoint[] {
  return prices.map((p, i) => ({ t: i * 60, p }));
}

// A real market never sits at a literal repeated constant -- an exact
// repeated value (e.g. 0.5, 0.5, 0.5...) produces many exact-zero-stdev
// ties, and since compression is judged as a percentile rank against ALL
// volatility seen so far, repeated identical ties keep pushing that rank
// back UP over time (each new tie is "not lower than" the accumulating pile
// of equal ties) -- so an exact-constant fixture stops being flagged
// compressed well before a late breakout, which is a test-data artifact,
// not real market behavior. Small deterministic jitter avoids the tie
// pathology and keeps a long quiet stretch flagged compressed throughout.
function quietSeries(n: number): number[] {
  const jitter = [0, 0.001, -0.001, 0.0015, -0.0015, 0.0005, -0.0005, 0.001, -0.001, 0.0005];
  return Array.from({ length: n }, (_, i) => 0.5 + jitter[i % jitter.length]);
}

test("detects an upward breakout right after a genuinely quiet period following a noisy one", () => {
  const noisy = [0.5, 0.65, 0.45, 0.68, 0.42, 0.66, 0.44, 0.67, 0.43, 0.65]; // stdev-heavy windows
  const quiet = quietSeries(10); // small non-zero jitter -- see quietSeries() for why an exact repeated constant is the wrong test fixture
  const breakout = [0.5, 0.5, 0.62]; // +0.12 jump within breakoutWindow=3
  const prices = [...noisy, ...quiet, ...breakout];

  const signal = detectVolatilityBreakout(series(prices), OPTS);
  assert.ok(signal, "expected a breakout to be detected");
  assert.equal(signal!.direction, "up");
  assert.ok(signal!.entryPrice > 0.55, `expected entryPrice near the breakout price, got ${signal!.entryPrice}`);
});

test("detects a downward breakout the same way", () => {
  const noisy = [0.5, 0.65, 0.45, 0.68, 0.42, 0.66, 0.44, 0.67, 0.43, 0.65];
  const quiet = quietSeries(10);
  const breakout = [0.5, 0.5, 0.38]; // -0.12 drop
  const prices = [...noisy, ...quiet, ...breakout];

  const signal = detectVolatilityBreakout(series(prices), OPTS);
  assert.ok(signal, "expected a breakout to be detected");
  assert.equal(signal!.direction, "down");
});

test("a persistently noisy series with no compression finds no signal", () => {
  const prices = Array.from({ length: 40 }, (_, i) => 0.5 + (i % 2 === 0 ? 0.1 : -0.1));
  const signal = detectVolatilityBreakout(series(prices), OPTS);
  assert.equal(signal, null);
});

test("a compressed series with no follow-through move within the breakout window finds no signal", () => {
  const noisy = [0.5, 0.65, 0.45, 0.68, 0.42, 0.66, 0.44, 0.67, 0.43, 0.65];
  const quiet = quietSeries(15); // stays quiet, never breaks out
  const prices = [...noisy, ...quiet];
  const signal = detectVolatilityBreakout(series(prices), OPTS);
  assert.equal(signal, null);
});

test("too short a series (below lookback*2 + breakoutWindow + 1) returns null rather than throwing", () => {
  const signal = detectVolatilityBreakout(series([0.5, 0.5, 0.5]), OPTS);
  assert.equal(signal, null);
});

test("a move below the breakout threshold is not treated as a breakout", () => {
  const noisy = [0.5, 0.65, 0.45, 0.68, 0.42, 0.66, 0.44, 0.67, 0.43, 0.65];
  const quiet = quietSeries(10);
  const tinyMove = [0.5, 0.5, 0.52]; // +0.02, below the 0.05 threshold
  const prices = [...noisy, ...quiet, ...tinyMove];
  const signal = detectVolatilityBreakout(series(prices), OPTS);
  assert.equal(signal, null);
});
