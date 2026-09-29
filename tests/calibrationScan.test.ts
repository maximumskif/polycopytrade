import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breakevenPrice,
  eventTrials,
  hashPick,
  parseArgs,
  scorableMarkets,
  sideTrial,
  snapshotTs,
  windowDates,
  type ScanEvent,
  type ScanMarket,
} from "../src/research/calibrationScan";

const END = Date.UTC(2026, 8, 1, 20) / 1000; // 2026-09-01T20:00Z

function market(over: Partial<ScanMarket> = {}): ScanMarket {
  return {
    conditionId: "0xc1",
    question: "A vs. B",
    outcomes: '["Yes","No"]',
    outcomePrices: '["1","0"]',
    clobTokenIds: '["yes1","no1"]',
    startDate: "2026-08-25T00:00:00Z",
    endDate: "2026-09-01T20:00:00Z",
    closedTime: "2026-09-02 02:00:00+00",
    closed: true,
    volumeNum: 10_000,
    ...over,
  };
}

test("snapshotTs: offsets from endDate, only while the market was open", () => {
  const m = market();
  assert.equal(snapshotTs(m, undefined, -6), END - 6 * 3600);
  assert.equal(snapshotTs(m, undefined, 3), END + 3 * 3600);
  // +6h lands at closedTime (02:00Z) -> no entry at or after close.
  assert.equal(snapshotTs(m, undefined, 6), null);
  // before startDate -> no entry
  assert.equal(snapshotTs(market({ startDate: "2026-09-01T18:00:00Z" }), undefined, -6), null);
});

test("sideTrial: taker fee is rate*(1-p) of the stake, slippage worsens price", () => {
  const t = sideTrial({
    eventKey: "e",
    tag: "sports",
    conditionId: "c",
    outcome: "Yes",
    ts: 0,
    quotedPrice: 0.5,
    won: true,
    feeRate: 0.05,
    slippageBps: 0,
  })!;
  // fee = 0.05 * 0.5 = 2.5% of $1 -> shares = 0.975 / 0.5
  assert.ok(Math.abs(t.shares - 1.95) < 1e-9);
  assert.ok(Math.abs(t.netReturn! - 0.95) < 1e-9);
  assert.ok(Math.abs(breakevenPrice(t) - 1 / 1.95) < 1e-9);
  const lose = sideTrial({
    eventKey: "e",
    tag: "sports",
    conditionId: "c",
    outcome: "Yes",
    ts: 0,
    quotedPrice: 0.95,
    won: false,
    feeRate: 0.05,
    slippageBps: 100,
  })!;
  assert.equal(lose.netReturn, -1);
  assert.equal(lose.entryPrice, 0.95); // bucket key stays the quote
  assert.ok(lose.shares < 1 / 0.95);
});

test("eventTrials scores both sides at the last non-stale price before the snapshot", () => {
  const event: ScanEvent = { slug: "a-vs-b", tag: "sports", endDate: "2026-09-01T20:00:00Z", markets: [market()] };
  const series = [
    { t: END - 7 * 3600, p: 0.6 },
    { t: END - 6 * 3600 + 60, p: 0.9 }, // after the -6h instant: must not be used
  ];
  const trials = eventTrials(event, new Map([["yes1", series]]), -6, { minVolume: 0, maxStaleSeconds: 3600, slippageBps: 0 });
  assert.equal(trials.length, 2);
  const yes = trials.find((t) => t.outcome === "Yes")!;
  const no = trials.find((t) => t.outcome === "No")!;
  assert.equal(yes.entryPrice, 0.6);
  assert.ok(Math.abs(no.entryPrice - 0.4) < 1e-9);
  assert.equal(yes.won, true);
  assert.equal(no.won, false);
  // Price older than maxStale -> no trials.
  assert.equal(eventTrials(event, new Map([["yes1", series]]), -6, { minVolume: 0, maxStaleSeconds: 1800, slippageBps: 0 }).length, 0);
});

test("scorableMarkets drops unsettled, low-volume and non-binary markets", () => {
  const ev = {
    markets: [
      market(),
      market({ conditionId: "0xc2", outcomePrices: '["0.5","0.5"]' }),
      market({ conditionId: "0xc3", volumeNum: 100 }),
      market({ conditionId: "0xc4", outcomes: '["A","B","C"]' }),
    ],
  };
  assert.deepEqual(
    scorableMarkets(ev, 5000).map((m) => m.conditionId),
    ["0xc1"]
  );
});

test("hashPick is deterministic and order-independent", () => {
  const xs = ["a", "b", "c", "d", "e"];
  assert.deepEqual(
    hashPick(xs, 2, (x) => x),
    hashPick([...xs].reverse(), 2, (x) => x)
  );
});

test("parseArgs defaults and windowDates", () => {
  const a = parseArgs(["--asOf=2026-09-29", "--days=2", "--skipDays=5"]);
  assert.equal(a.slippageBps, 100);
  assert.deepEqual(a.sensitivityBps, [300]);
  assert.deepEqual(windowDates(a), ["2026-09-24", "2026-09-23"]);
});
