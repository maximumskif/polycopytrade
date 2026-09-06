import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRollingWindowResults } from "../src/backtesting/rollingWindow";
import { defaultBacktestConfig } from "../src/backtesting/engine";
import type { BacktestTrial } from "../src/domain/types";

const DAY = 86400;
const config = defaultBacktestConfig();

function trial(overrides: Partial<BacktestTrial>): BacktestTrial {
  return {
    walletAddress: "0xw",
    conditionId: "c1",
    outcome: "Yes",
    eventKey: "e1",
    category: "other",
    entryTimestamp: 0,
    entryPrice: 0.5,
    usdcStaked: 10,
    shares: 20,
    resolved: true,
    won: true,
    netReturn: 10,
    ...overrides,
  };
}

test("buckets trials into non-overlapping windows by entryTimestamp", () => {
  const trials = [
    trial({ conditionId: "c0", entryTimestamp: 0 * DAY }),
    trial({ conditionId: "c1", entryTimestamp: 0.5 * DAY }),
    trial({ conditionId: "c2", entryTimestamp: 1 * DAY }),
    trial({ conditionId: "c3", entryTimestamp: 2.5 * DAY }),
  ];
  const windows = computeRollingWindowResults(trials, config, DAY);
  assert.equal(windows.length, 3);
  assert.equal(windows[0].result.trialCount, 2); // day 0: t=0 and t=0.5d
  assert.equal(windows[1].result.trialCount, 1); // day 1: t=1d
  assert.equal(windows[2].result.trialCount, 1); // day 2: t=2.5d
});

test("reproduces a decaying-edge pattern (Phase 1f shape): net P&L declines window over window", () => {
  // wk0: all wins, wk1: mixed, wk2: all losses -- same shape as the real
  // 0x_exit-wallet finding this feature was built to generalize.
  const trials = [
    ...Array.from({ length: 7 }, (_, i) => trial({ conditionId: `w0-${i}`, entryTimestamp: i * DAY, won: true, netReturn: 5 })),
    ...Array.from({ length: 7 }, (_, i) =>
      trial({ conditionId: `w1-${i}`, entryTimestamp: (7 + i) * DAY, won: i % 2 === 0, netReturn: i % 2 === 0 ? 5 : -10 })
    ),
    ...Array.from({ length: 7 }, (_, i) => trial({ conditionId: `w2-${i}`, entryTimestamp: (14 + i) * DAY, won: false, netReturn: -10 })),
  ];
  const windows = computeRollingWindowResults(trials, config, 7 * DAY);
  assert.equal(windows.length, 3);
  assert.ok(windows[0].result.netPnl > windows[1].result.netPnl);
  assert.ok(windows[1].result.netPnl > windows[2].result.netPnl);
  assert.ok(windows[0].result.netPnl > 0);
  assert.ok(windows[2].result.netPnl < 0);
});

test("unresolved trials are excluded from every window", () => {
  const trials = [
    trial({ entryTimestamp: 0, resolved: true }),
    trial({ conditionId: "c2", entryTimestamp: 0, resolved: false, won: null, netReturn: 0 }),
  ];
  const windows = computeRollingWindowResults(trials, config, DAY);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].result.trialCount, 1);
});

test("an empty trial set produces no windows", () => {
  assert.deepEqual(computeRollingWindowResults([], config, DAY), []);
});

test("windowEnd is exclusive -- a trial exactly on the boundary lands in the NEXT window", () => {
  const trials = [trial({ conditionId: "c0", entryTimestamp: 0 }), trial({ conditionId: "c1", entryTimestamp: DAY })];
  const windows = computeRollingWindowResults(trials, config, DAY);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].windowStart, 0);
  assert.equal(windows[0].windowEnd, DAY);
  assert.equal(windows[0].result.trialCount, 1);
  assert.equal(windows[1].result.trialCount, 1);
});

test("a smaller stepSeconds than windowSeconds produces overlapping sliding windows", () => {
  const trials = [
    trial({ conditionId: "c0", entryTimestamp: 0 }),
    trial({ conditionId: "c1", entryTimestamp: 3 * DAY }),
    trial({ conditionId: "c2", entryTimestamp: 6 * DAY }),
  ];
  // 7-day window, 3-day step -- the middle trial should appear in more than one window.
  const windows = computeRollingWindowResults(trials, config, 7 * DAY, 3 * DAY);
  const windowsContainingC1 = windows.filter((w) => w.windowStart <= 3 * DAY && w.windowEnd > 3 * DAY);
  assert.ok(windowsContainingC1.length > 1, "expected the middle trial to fall inside multiple overlapping windows");
});
