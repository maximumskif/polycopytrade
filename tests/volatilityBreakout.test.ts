import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breakoutTrial,
  detectVolatilityBreakout,
  isSignalFinal,
  parseArgs,
  regroupByMonth,
  selectClosedMonthlyLadders,
  DEFAULT_EVENTS_PER_ASSET,
  type PricePoint,
} from "../src/research/volatilityBreakout";
import { computeStrategyResult } from "../src/backtesting/statistics";
import { defaultBacktestConfig } from "../src/backtesting/engine";
import type { GammaEvent } from "../src/api/client";

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

// 2026-09-24 engine migration: the live pull now stops fetching a rung's
// history once a prefix signal is provably final (isSignalFinal). This
// checks the claim it rests on -- a "final" prefix signal equals the
// full-series signal -- over many pseudo-random series and every prefix.
test("a prefix signal accepted by isSignalFinal always equals the full-series signal", () => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  let checked = 0;
  for (let trial = 0; trial < 200; trial++) {
    let p = 0.5;
    const prices: number[] = [];
    for (let i = 0; i < 80; i++) {
      const regime = Math.floor(i / 10) % 2 === 0 ? 0.04 : 0.003; // alternate noisy/quiet stretches
      p = Math.min(0.99, Math.max(0.01, p + (rand() - 0.5) * 2 * regime + (rand() < 0.03 ? 0.1 : 0)));
      prices.push(p);
    }
    const full = series(prices);
    const fullSignal = detectVolatilityBreakout(full, OPTS);
    for (let len = 1; len <= full.length; len++) {
      const prefixSignal = detectVolatilityBreakout(full.slice(0, len), OPTS);
      if (prefixSignal && isSignalFinal(prefixSignal, len, OPTS.breakoutWindow)) {
        assert.deepEqual(prefixSignal, fullSignal);
        checked++;
      }
    }
  }
  assert.ok(checked > 50, `expected the property to be exercised, only ${checked} final prefix signals`);
});

test("isSignalFinal requires a full forward breakoutWindow after the breakout inside the prefix", () => {
  const signal = { breakoutIndex: 10, direction: "up" as const, entryPrice: 0.6 };
  assert.equal(isSignalFinal(signal, 16, 5), true); // last index 15 = 10 + 5
  assert.equal(isSignalFinal(signal, 15, 5), false);
});

function ev(slug: string, endDate: string | undefined): GammaEvent {
  return { id: slug, title: slug, slug, endDate } as GammaEvent;
}

test("selectClosedMonthlyLadders keeps ended monthly ladders (incl. year-less 2025 slugs), newest first, capped", () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  const events = [
    ev("what-price-will-bitcoin-hit-in-september-2026", "2026-10-01T04:00:00Z"), // not ended yet -- excluded
    ev("what-price-will-bitcoin-hit-in-august-2026", "2026-09-01T04:00:00Z"),
    ev("what-price-will-bitcoin-hit-in-august", "2025-09-01T04:00:00Z"), // year-less 2025 slug -- kept
    ev("what-price-will-bitcoin-hit-september-15-21", "2025-09-21T04:00:00Z"), // weekly -- excluded
    ev("what-price-will-bitcoin-hit-in-july-2026", "2026-08-01T04:00:00Z"),
    ev("what-price-will-ethereum-hit-in-july-2026", "2026-08-01T04:00:00Z"), // other asset -- excluded
    ev("what-price-will-bitcoin-hit-in-june-2026", undefined), // no endDate -- excluded
  ];
  const picked = selectClosedMonthlyLadders(events, "what-price-will-bitcoin-hit", 10, now).map((e) => e.slug);
  assert.deepEqual(picked, [
    "what-price-will-bitcoin-hit-in-august-2026",
    "what-price-will-bitcoin-hit-in-july-2026",
    "what-price-will-bitcoin-hit-in-august",
  ]);
  assert.equal(selectClosedMonthlyLadders(events, "what-price-will-bitcoin-hit", 2, now).length, 2);
});

test("breakoutTrial prices the breakout side and pays 1/entryPrice shares on a win", () => {
  const up = breakoutTrial({
    asset: "BTC",
    eventKey: "e1",
    conditionId: "c1",
    signal: { breakoutIndex: 3, direction: "up", entryPrice: 0.25 },
    entryTimestamp: 100,
    yesWon: true,
  })!;
  assert.equal(up.outcome, "Yes");
  assert.equal(up.entryPrice, 0.25);
  assert.equal(up.won, true);
  assert.ok(Math.abs(up.netReturn - 3) < 1e-9); // $1 buys 4 shares, pays $4

  const down = breakoutTrial({
    asset: "WTI",
    eventKey: "e1",
    conditionId: "c2",
    signal: { breakoutIndex: 3, direction: "down", entryPrice: 0.9 },
    entryTimestamp: 100,
    yesWon: true,
  })!;
  assert.equal(down.outcome, "No");
  assert.ok(Math.abs(down.entryPrice - 0.1) < 1e-9);
  assert.equal(down.won, false);
  assert.equal(down.netReturn, -1);

  assert.equal(
    breakoutTrial({
      asset: "BTC",
      eventKey: "e",
      conditionId: "c",
      signal: { breakoutIndex: 1, direction: "up", entryPrice: 1 },
      entryTimestamp: 0,
      yesWon: true,
    }),
    null
  );
});

test("many rungs of one ladder count as ONE independent event, not n trials", () => {
  const trials = Array.from({ length: 30 }, (_, i) =>
    breakoutTrial({
      asset: "BTC",
      eventKey: i < 25 ? "ladder-a" : "ladder-b",
      conditionId: `c${i}`,
      signal: { breakoutIndex: 1, direction: "up", entryPrice: 0.5 },
      entryTimestamp: i,
      yesWon: i % 2 === 0,
    })!
  );
  const r = computeStrategyResult(trials, defaultBacktestConfig());
  assert.equal(r.trialCount, 30);
  assert.equal(r.distinctEvents, 2);
});

test("regroupByMonth merges same-month ladders across assets into one cluster", () => {
  const mk = (eventKey: string) =>
    breakoutTrial({
      asset: "BTC",
      eventKey,
      conditionId: eventKey,
      signal: { breakoutIndex: 1, direction: "up", entryPrice: 0.5 },
      entryTimestamp: 0,
      yesWon: true,
    })!;
  const months = new Map([
    ["btc-aug", "2026-08"],
    ["wti-aug", "2026-08"],
    ["btc-jul", "2026-07"],
  ]);
  const regrouped = regroupByMonth([mk("btc-aug"), mk("wti-aug"), mk("btc-jul"), mk("unknown")], months);
  assert.deepEqual(
    regrouped.map((t) => t.eventKey),
    ["2026-08", "2026-08", "2026-07", "unknown"]
  );
});

test("parseArgs reads --eventsPerAsset and rejects nonsense", () => {
  assert.equal(parseArgs([]).eventsPerAsset, DEFAULT_EVENTS_PER_ASSET);
  assert.equal(parseArgs(["--eventsPerAsset=12"]).eventsPerAsset, 12);
  assert.throws(() => parseArgs(["--eventsPerAsset=0"]));
  assert.throws(() => parseArgs(["--eventsPerAsset=abc"]));
});
