// K5: the positions screen's mapping (closed/unredeemed position ->
// hold-to-resolution trial), its windowing, and the end-to-end pull
// against a mocked fetch.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildPositionTrials,
  gammaTimeTs,
  endDateTs,
  positionToTrial,
  scoreFromPositions,
  scoreWalletPositions,
  settlementOf,
  windowStartOf,
  CLOSED_PAGE_SIZE,
} from "../src/scoring/positionsScreen";
import { computeStrategyResult } from "../src/backtesting/statistics";
import { defaultBacktestConfig } from "../src/backtesting/engine";
import { parseScreenMode } from "../src/research/screenMode";
import { __setFetchImplForTests, __resetFetchImplForTests, type Activity, type ClosedPosition, type OpenPosition } from "../src/api/client";
import type { BacktestTrial } from "../src/domain/types";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

afterEach(() => __resetFetchImplForTests());

function closedPos(o: Partial<ClosedPosition>): ClosedPosition {
  return {
    conditionId: "c1",
    avgPrice: 0.5,
    totalBought: 100,
    realizedPnl: 50,
    curPrice: 1,
    timestamp: NOW - DAY,
    title: "Will X win?",
    slug: "x-win",
    eventSlug: "x-event",
    outcome: "Yes",
    endDate: "2026-09-24",
    ...o,
  };
}

function openPos(o: Partial<OpenPosition>): OpenPosition {
  return {
    conditionId: "r1",
    avgPrice: 0.4,
    totalBought: 50,
    size: 50,
    curPrice: 0,
    redeemable: true,
    title: "Will Y win?",
    slug: "y-win",
    eventSlug: "y-event",
    outcome: "Yes",
    endDate: "2026-09-24",
    ...o,
  };
}

function trade(ts: number): Activity {
  return {
    timestamp: ts,
    conditionId: "c",
    type: "TRADE",
    size: 1,
    usdcSize: 0.5,
    price: 0.5,
    side: "BUY",
    outcome: "Yes",
    title: "t",
    slug: "s",
    proxyWallet: "0xw",
    transactionHash: `tx-${ts}`,
  };
}

test("real closed positions (0x01c78f, 2026-09-25): stake = totalBought*avgPrice, P&L matches the API's realizedPnl", () => {
  // Winner held to settlement: Andres Andrade, San Diego 2.
  const win = positionToTrial(
    "0xw",
    closedPos({ avgPrice: 0.2884, totalBought: 4135.7034, realizedPnl: 2942.6811, curPrice: 1, eventSlug: "atp-blanc-andrade-2026-09-24" }),
    1790295024
  )!;
  assert.ok(Math.abs(win.usdcStaked - 1192.74) < 0.01);
  assert.ok(Math.abs(win.netReturn - 2942.6811) < 0.5, `net ${win.netReturn}`);
  assert.equal(win.won, true);
  assert.equal(win.eventKey, "atp-blanc-andrade-2026-09-24");
  assert.equal(win.entryTimestamp, 1790295024);
  // Loser held to settlement: Netherlands "Yes".
  const loss = positionToTrial("0xw", closedPos({ avgPrice: 0.1911, totalBought: 4917.5616, realizedPnl: -939.9132, curPrice: 0 }), 1)!;
  assert.ok(Math.abs(loss.netReturn - -939.9132) < 0.5, `net ${loss.netReturn}`);
  assert.equal(loss.netReturn, -loss.usdcStaked);
  assert.equal(loss.won, false);
});

test("won is the settled side, not realizedPnl > 0 (hold-to-resolution, like the activity screen)", () => {
  // Sold a winning side early at a loss: realized -10, but held to
  // resolution the buys return 100*(1-0.5).
  const t = positionToTrial("0xw", closedPos({ realizedPnl: -10, curPrice: 1 }), NOW)!;
  assert.equal(t.won, true);
  assert.equal(t.netReturn, 50);
});

test("unsettled or zero-cost positions are not trials; eventKey falls back to slug", () => {
  assert.equal(settlementOf(0.6035), null);
  assert.equal(settlementOf(0.5), null);
  assert.equal(positionToTrial("0xw", closedPos({ curPrice: 0.6035 }), NOW), null);
  assert.equal(positionToTrial("0xw", closedPos({ totalBought: 0 }), NOW), null);
  assert.equal(positionToTrial("0xw", closedPos({ eventSlug: "" }), NOW)!.eventKey, "x-win");
  assert.equal(positionToTrial("0xw", closedPos({ eventSlug: null }), NOW)!.eventKey, "x-win");
});

test("one position equals the sum of its BUY fills held to resolution", () => {
  // Fills: 60 shares @0.4 and 40 @0.65 -> 100 shares, avg 0.5, settles 0.
  const fills: BacktestTrial[] = [
    { ...positionToTrial("0xw", closedPos({ totalBought: 60, avgPrice: 0.4, curPrice: 0 }), NOW)! },
    { ...positionToTrial("0xw", closedPos({ totalBought: 40, avgPrice: 0.65, curPrice: 0 }), NOW)! },
  ];
  const position = positionToTrial("0xw", closedPos({ totalBought: 100, avgPrice: 0.5, curPrice: 0 }), NOW)!;
  const config = defaultBacktestConfig();
  const a = computeStrategyResult(fills, config);
  const b = computeStrategyResult([position], config);
  assert.ok(Math.abs(a.totalStaked - b.totalStaked) < 1e-9);
  assert.ok(Math.abs(a.netPnl - b.netPnl) < 1e-9);
});

test("gamma closedTime and endDate parsing", () => {
  assert.equal(gammaTimeTs("2026-09-25 04:43:35+00"), Date.UTC(2026, 8, 25, 4, 43, 35) / 1000);
  assert.equal(gammaTimeTs("2026-09-25T04:43:35Z"), Date.UTC(2026, 8, 25, 4, 43, 35) / 1000);
  assert.equal(gammaTimeTs(null), null);
  assert.equal(gammaTimeTs("garbage"), null);
  assert.equal(endDateTs("2026-09-24"), Date.UTC(2026, 8, 24) / 1000);
  assert.equal(endDateTs(undefined), null);
});

test("windowStartOf: oldest closed timestamp, or 0 when the closed history ran out", () => {
  const closed = [closedPos({ timestamp: 300 }), closedPos({ timestamp: 100 }), closedPos({ timestamp: 200 })];
  assert.equal(windowStartOf(closed, false), 100);
  assert.equal(windowStartOf(closed, true), 0);
  assert.equal(windowStartOf([], false), 0);
});

test("unredeemed positions: windowed by gamma close time, endDate as fallback, deduped against closed", () => {
  const windowStart = Date.UTC(2026, 8, 24, 12) / 1000;
  const closed = [closedPos({ conditionId: "dup", outcome: "No", timestamp: windowStart + 10 })];
  const redeemable = [
    openPos({ conditionId: "in", endDate: "2026-10-02" }), // closed inside the window (per gamma)
    openPos({ conditionId: "early", endDate: "2026-10-02" }), // scheduled end inside, but closed a week earlier
    openPos({ conditionId: "noGammaRecent", endDate: "2026-09-24" }), // fallback: endDate + 1 day >= windowStart
    openPos({ conditionId: "noGammaOld", endDate: "2026-09-20" }),
    openPos({ conditionId: "dup", outcome: "No" }), // already a closed position
    openPos({ conditionId: "live", curPrice: 0.3 }),
  ];
  const closeTimes = new Map([
    ["in", windowStart + 3600],
    ["early", windowStart - 7 * DAY],
    ["live", windowStart + 1],
  ]);
  const r = buildPositionTrials("0xw", closed, redeemable, windowStart, closeTimes);
  const ids = r.trials.map((t) => t.conditionId).sort();
  assert.deepEqual(ids, ["dup", "in", "noGammaRecent"]);
  assert.equal(r.redeemableIncluded, 2);
  assert.equal(r.unsettledSkipped, 1);
  assert.equal(r.trials.find((t) => t.conditionId === "in")!.entryTimestamp, windowStart + 3600);
  // No window (closed history exhausted): every settled unredeemed position counts.
  assert.equal(buildPositionTrials("0xw", [], redeemable, 0).trials.length, 5);
});

test("scoreFromPositions: flags come out of computeWalletScore like the activity screen's", () => {
  const wallet = { address: "0xw", label: "w" };
  // 25 events, alternating wins/losses at avg 0.4: profitable, clean.
  const closed = Array.from({ length: 25 }, (_, i) =>
    closedPos({ conditionId: `c${i}`, eventSlug: `e${i}`, avgPrice: 0.4, curPrice: i % 2 === 0 ? 1 : 0, timestamp: NOW - i * 3600 })
  );
  const recent = Array.from({ length: 10 }, (_, i) => trade(NOW - i * 600));
  const clean = scoreFromPositions(wallet, recent, closed, [], true).score;
  assert.deepEqual(clean.flags, []);
  assert.equal(clean.distinctEvents, 25);
  assert.ok(clean.roi > 0);

  const dormant = scoreFromPositions(wallet, [trade(NOW - 40 * DAY)], closed, [], true).score;
  assert.ok(dormant.flags.includes("dormant"));

  const few = scoreFromPositions(wallet, recent, closed.slice(0, 5), [], true).score;
  assert.ok(few.flags.includes("insufficient-sample"));

  // Unredeemed losers in the window change the answer (the survivorship fix).
  const losers = Array.from({ length: 30 }, (_, i) =>
    openPos({ conditionId: `l${i}`, eventSlug: `le${i}`, avgPrice: 0.5, totalBought: 200 })
  );
  const withLosers = scoreFromPositions(wallet, recent, closed, losers, true).score;
  assert.ok(withLosers.roi < 0);
});

function mockApi(closedPages: number, urls: string[]) {
  const iso = (ts: number) =>
    new Date(ts * 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "+00");
  __setFetchImplForTests(async (input) => {
    const url = String(input);
    urls.push(url);
    const u = new URL(url);
    let body: unknown = [];
    if (u.pathname === "/activity") body = [trade(NOW - 60)];
    else if (u.pathname === "/closed-positions") {
      const page = Number(u.searchParams.get("offset")) / CLOSED_PAGE_SIZE;
      body =
        page < closedPages
          ? Array.from({ length: CLOSED_PAGE_SIZE }, (_, i) =>
              closedPos({ conditionId: `c${page}-${i}`, eventSlug: `e${page}-${i}`, timestamp: NOW - 3600 - page * 100 - i })
            )
          : [];
    } else if (u.pathname === "/positions")
      body = [openPos({ conditionId: "rIn", endDate: "2099-01-01" }), openPos({ conditionId: "rOld", endDate: "2099-01-01" })];
    else if (u.pathname === "/markets" && u.searchParams.get("closed") === "true")
      body = [
        { id: "1", conditionId: "rIn", question: "q", slug: "s", closed: true, closedTime: iso(NOW - 1800) },
        { id: "2", conditionId: "rOld", question: "q", slug: "s", closed: true, closedTime: iso(NOW - 30 * DAY) },
      ];
    return { status: 200, ok: true, statusText: "OK", json: async () => body } as unknown as Response;
  });
}

const W = { address: "0xw", label: "w", archetype: "unclassified" as const, source: "t" };

test("scoreWalletPositions: 4 full closed pages -> windowed; unredeemed kept by gamma close time", async () => {
  const urls: string[] = [];
  mockApi(99, urls);
  const r = await scoreWalletPositions(W, 4);
  const paths = urls.map((u) => new URL(u).pathname);
  assert.deepEqual(paths, ["/activity", ...Array(4).fill("/closed-positions"), "/positions", "/markets"]);
  assert.ok(urls.some((u) => u.includes("redeemable=true") && u.includes("sortBy=RESOLVING")));
  assert.equal(r.closedCount, 4 * CLOSED_PAGE_SIZE);
  assert.equal(r.windowStart, NOW - 3600 - 300 - 49);
  assert.equal(r.dataApiRequests, 6);
  assert.equal(r.gammaLookups, 2);
  assert.equal(r.redeemableIncluded, 1);
  assert.ok(r.trials.some((t) => t.conditionId === "rIn"));
  assert.ok(!r.trials.some((t) => t.conditionId === "rOld"));
});

test("scoreWalletPositions: a short closed page means whole history -- no window, no gamma lookups", async () => {
  const urls: string[] = [];
  mockApi(1, urls);
  const r = await scoreWalletPositions(W, 4);
  assert.deepEqual(
    urls.map((u) => new URL(u).pathname),
    ["/activity", "/closed-positions", "/closed-positions", "/positions"]
  );
  assert.equal(r.windowStart, 0);
  assert.equal(r.gammaLookups, 0);
  assert.equal(r.redeemableIncluded, 2);
});

test("parseScreenMode: activity by default, positions opt-in, anything else rejected", () => {
  assert.equal(parseScreenMode([]), "activity");
  assert.equal(parseScreenMode(["--tag=soccer", "--screen=positions"]), "positions");
  assert.equal(parseScreenMode(["--screen=activity"]), "activity");
  assert.throws(() => parseScreenMode(["--screen=fast"]));
});
