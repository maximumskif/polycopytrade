import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructPositions, detectHedges } from "../src/backtesting/positionReconstruction";
import type { Activity } from "../src/api/schemas";

function fill(overrides: Partial<Activity>): Activity {
  return {
    timestamp: 0,
    conditionId: "c1",
    type: "TRADE",
    size: 0,
    usdcSize: 0,
    price: 0,
    side: "BUY",
    outcome: "Yes",
    title: "t",
    slug: "s",
    proxyWallet: "0xw",
    transactionHash: "tx",
    ...overrides,
  };
}

test("a single buy opens a still-open position with no realized P&L", () => {
  const [pos] = reconstructPositions("0xw", [fill({ timestamp: 100, side: "BUY", size: 10, price: 0.4 })]);
  assert.equal(pos.finalSize, 10);
  assert.equal(pos.avgCost, 0.4);
  assert.equal(pos.realizedPnl, 0);
  assert.equal(pos.closedAt, null);
  assert.equal(pos.incompleteHistory, false);
  assert.equal(pos.events[0].kind, "opened");
});

test("buy then full sell closes the position and books the correct realized P&L", () => {
  // Bought 10 @ 0.40 (cost $4), sold 10 @ 0.60 (proceeds $6) -> +$2 realized.
  const [pos] = reconstructPositions("0xw", [
    fill({ timestamp: 100, side: "BUY", size: 10, price: 0.4 }),
    fill({ timestamp: 200, side: "SELL", size: 10, price: 0.6 }),
  ]);
  assert.equal(pos.finalSize, 0);
  assert.ok(Math.abs(pos.realizedPnl - 2) < 1e-9);
  assert.equal(pos.closedAt, 200);
  assert.equal(pos.holdDurationSeconds, 100);
  assert.equal(pos.events.at(-1)!.kind, "closed");
});

test("scaling in twice computes a correctly weighted average cost", () => {
  // 10 @ 0.40 then 10 @ 0.60 -> avg cost (10*0.4 + 10*0.6)/20 = 0.50
  const [pos] = reconstructPositions("0xw", [
    fill({ timestamp: 100, side: "BUY", size: 10, price: 0.4 }),
    fill({ timestamp: 150, side: "BUY", size: 10, price: 0.6 }),
  ]);
  assert.equal(pos.finalSize, 20);
  assert.equal(pos.avgCost, 0.5);
  assert.equal(pos.events[1].kind, "increased");
});

test("a partial sell reduces the position without closing it, realizing P&L only on the sold portion", () => {
  // 10 @ 0.40, sell 4 @ 0.70 -> realized 4*(0.70-0.40)=1.2, 6 shares remain at 0.40 cost.
  const [pos] = reconstructPositions("0xw", [
    fill({ timestamp: 100, side: "BUY", size: 10, price: 0.4 }),
    fill({ timestamp: 150, side: "SELL", size: 4, price: 0.7 }),
  ]);
  assert.equal(pos.finalSize, 6);
  assert.equal(pos.avgCost, 0.4);
  assert.ok(Math.abs(pos.realizedPnl - 1.2) < 1e-9);
  assert.equal(pos.closedAt, null);
  assert.equal(pos.events.at(-1)!.kind, "reduced");
});

test("reopening after a full close produces two separate positions, not one", () => {
  const positions = reconstructPositions("0xw", [
    fill({ timestamp: 100, side: "BUY", size: 10, price: 0.4 }),
    fill({ timestamp: 200, side: "SELL", size: 10, price: 0.5 }),
    fill({ timestamp: 300, side: "BUY", size: 5, price: 0.3 }),
  ]);
  assert.equal(positions.length, 2);
  assert.equal(positions[0].closedAt, 200);
  assert.equal(positions[1].closedAt, null);
  assert.equal(positions[1].finalSize, 5);
});

test("a sell with no prior tracked buy is flagged incompleteHistory, not silently trusted", () => {
  const [pos] = reconstructPositions("0xw", [fill({ timestamp: 100, side: "SELL", size: 10, price: 0.6 })]);
  assert.equal(pos.incompleteHistory, true);
  assert.equal(pos.closedAt, 100);
});

test("a sell larger than the tracked position is flagged incompleteHistory", () => {
  const [pos] = reconstructPositions("0xw", [
    fill({ timestamp: 100, side: "BUY", size: 5, price: 0.4 }),
    fill({ timestamp: 200, side: "SELL", size: 8, price: 0.5 }),
  ]);
  assert.equal(pos.incompleteHistory, true);
  assert.equal(pos.finalSize, 0);
});

test("different (conditionId, outcome) pairs never merge into one position", () => {
  const positions = reconstructPositions("0xw", [
    fill({ timestamp: 100, conditionId: "c1", outcome: "Yes", side: "BUY", size: 10, price: 0.4 }),
    fill({ timestamp: 100, conditionId: "c1", outcome: "No", side: "BUY", size: 10, price: 0.6 }),
    fill({ timestamp: 100, conditionId: "c2", outcome: "Yes", side: "BUY", size: 10, price: 0.4 }),
  ]);
  assert.equal(positions.length, 3);
});

test("non-TRADE activity (e.g. REWARD rows) is ignored", () => {
  const positions = reconstructPositions("0xw", [
    fill({ timestamp: 100, type: "REWARD", side: "", conditionId: "", outcome: "", size: 1, price: 0 }),
    fill({ timestamp: 200, type: "TRADE", side: "BUY", size: 10, price: 0.4 }),
  ]);
  assert.equal(positions.length, 1);
});

test("detectHedges flags overlapping opposite-outcome positions on the same market", () => {
  const positions = reconstructPositions("0xw", [
    fill({ timestamp: 100, conditionId: "c1", outcome: "Yes", side: "BUY", size: 10, price: 0.4 }),
    fill({ timestamp: 150, conditionId: "c1", outcome: "No", side: "BUY", size: 10, price: 0.5 }),
  ]);
  const hedges = detectHedges(positions);
  assert.equal(hedges.length, 1);
  assert.equal(hedges[0].overlapStart, 150);
});

test("detectHedges does not flag sequential (non-overlapping) opposite-outcome positions", () => {
  const positions = reconstructPositions("0xw", [
    fill({ timestamp: 100, conditionId: "c1", outcome: "Yes", side: "BUY", size: 10, price: 0.4 }),
    fill({ timestamp: 150, conditionId: "c1", outcome: "Yes", side: "SELL", size: 10, price: 0.5 }),
    fill({ timestamp: 200, conditionId: "c1", outcome: "No", side: "BUY", size: 10, price: 0.5 }),
  ]);
  const hedges = detectHedges(positions);
  assert.equal(hedges.length, 0);
});
