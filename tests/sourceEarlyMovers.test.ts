import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  earlyWinningBuys,
  findMove,
  parseGammaTime,
  rankNominees,
  winnerIndex,
  EARLY_MAX_PRICE,
  MIN_EARLY_USDC,
  MIN_EVENTS,
} from "../src/research/sourceEarlyMovers";
import type { MarketTrade } from "../src/api/client";

const H = 3600;

test("parseGammaTime handles gamma's non-ISO closedTime and ISO endDate", () => {
  assert.equal(parseGammaTime("2026-09-25 04:43:35+00"), Date.parse("2026-09-25T04:43:35Z") / 1000);
  assert.equal(parseGammaTime("2026-09-25T04:43:35Z"), Date.parse("2026-09-25T04:43:35Z") / 1000);
  assert.equal(parseGammaTime(null), null);
});

test("winnerIndex only for finalized markets", () => {
  assert.equal(winnerIndex({ closed: true, outcomePrices: '["0","1"]', umaResolutionStatus: "resolved" }), 1);
  assert.equal(winnerIndex({ closed: false, outcomePrices: '["0","1"]' }), null);
  assert.equal(winnerIndex({ closed: true, outcomePrices: '["0.5","0.5"]' }), null);
});

test("findMove: first cross after being cheap, with enough lead before close", () => {
  const close = 1000 * H;
  const s = (pts: [number, number][]) => pts.map(([t, p]) => ({ t: t * H, p }));
  assert.deepEqual(
    findMove(
      s([
        [1, 0.2],
        [5, 0.4],
        [10, 0.65],
        [20, 0.9],
      ]),
      close
    ),
    { cheapSeen: true, crossTs: 10 * H }
  );
  assert.equal(
    findMove(
      s([
        [1, 0.5],
        [5, 0.7],
      ]),
      close
    ),
    null,
    "never cheap"
  );
  assert.deepEqual(
    findMove(
      s([
        [1, 0.7],
        [2, 0.3],
        [3, 0.8],
      ]),
      close
    )?.crossTs,
    3 * H,
    "early high ignored, recovery counts"
  );
  assert.equal(
    findMove(
      s([
        [1, 0.2],
        [998, 0.9],
      ]),
      close
    ),
    null,
    "move only at resolution (2h lead < 6h)"
  );
});

function trade(o: Partial<MarketTrade>): MarketTrade {
  return { proxyWallet: "0xA", side: "BUY", asset: "t", conditionId: "c", size: 1000, price: 0.2, timestamp: 100, outcomeIndex: 1, ...o };
}

test("earlyWinningBuys keeps cheap, big-enough BUYs of the winner before the cross", () => {
  const trades = [
    trade({}),
    trade({ side: "SELL" }),
    trade({ outcomeIndex: 0 }),
    trade({ timestamp: 500 }),
    trade({ price: EARLY_MAX_PRICE + 0.01 }),
    trade({ size: (MIN_EARLY_USDC - 1) / 0.2 }),
  ];
  assert.equal(earlyWinningBuys(trades, 1, 400).length, 1);
});

test("aggregate + rankNominees count distinct events, not markets, and honor the skip set", () => {
  const rows = [
    { trade: trade({ proxyWallet: "0xA" }), eventKey: "e1", question: "q1" },
    { trade: trade({ proxyWallet: "0xA" }), eventKey: "e1", question: "q1b" },
    { trade: trade({ proxyWallet: "0xA" }), eventKey: "e2", question: "q2" },
    { trade: trade({ proxyWallet: "0xA" }), eventKey: "e3", question: "q3" },
    { trade: trade({ proxyWallet: "0xB" }), eventKey: "e1", question: "q1" },
    { trade: trade({ proxyWallet: "0xC" }), eventKey: "e1", question: "q1" },
    { trade: trade({ proxyWallet: "0xC" }), eventKey: "e2", question: "q2" },
    { trade: trade({ proxyWallet: "0xC" }), eventKey: "e3", question: "q3" },
  ];
  const all = aggregate(rows);
  assert.equal(all.get("0xa")!.events.size, 3);
  const ranked = rankNominees(all, new Set(["0xc"]));
  assert.deepEqual(
    ranked.map((n) => n.address),
    ["0xA"]
  );
  assert.ok(ranked.every((n) => n.events.size >= MIN_EVENTS));
});
