import { test } from "node:test";
import assert from "node:assert/strict";
import { equalWeight } from "../src/research/earlyMoversOOS";
import { earlyLosingBuys } from "../src/research/sourceEarlyMovers";
import type { BacktestTrial } from "../src/domain/types";
import type { MarketTrade } from "../src/api/client";

function trial(usdcStaked: number, netReturn: number): BacktestTrial {
  return {
    walletAddress: "w",
    conditionId: "c",
    outcome: "Yes",
    eventKey: "e",
    category: "other",
    entryTimestamp: 1,
    entryPrice: 0.3,
    usdcStaked,
    shares: usdcStaked / 0.3,
    resolved: true,
    won: netReturn > 0,
    netReturn,
  };
}

test("equalWeight scales a wallet's trials to total stake 1, preserving its ROI", () => {
  const scaled = equalWeight([trial(300, 150), trial(700, -100)]);
  assert.ok(Math.abs(scaled.reduce((s, t) => s + t.usdcStaked, 0) - 1) < 1e-12);
  assert.ok(Math.abs(scaled.reduce((s, t) => s + t.netReturn, 0) - 0.05) < 1e-12); // (150 - 100) / 1000
  assert.deepEqual(equalWeight([]), []);
});

test("earlyLosingBuys keeps cheap early BUYs of a non-winning outcome only", () => {
  const t = (o: Partial<MarketTrade>): MarketTrade => ({
    proxyWallet: "0xA",
    side: "BUY",
    asset: "a",
    conditionId: "c",
    size: 1000,
    price: 0.2,
    timestamp: 100,
    outcomeIndex: 0,
    ...o,
  });
  const trades = [t({}), t({ outcomeIndex: 1 }), t({ side: "SELL" }), t({ timestamp: 500 }), t({ outcomeIndex: undefined })];
  assert.equal(earlyLosingBuys(trades, 1, 400).length, 1);
});
