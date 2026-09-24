import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketFor,
  cacheWindowCovers,
  cityDateKey,
  dateKey,
  entryTimestamp,
  eventTrials,
  favoriteSide,
  favoriteTrial,
  parseArgs,
  parseGammaTime,
  parseTemperatureSlug,
  pickEvents,
  priceAt,
  regroup,
  settledWinnerIndex,
  type WxEvent,
  type WxMarket,
} from "../src/research/weatherFavorites";
import { computeStrategyResult } from "../src/backtesting/statistics";
import { defaultBacktestConfig } from "../src/backtesting/engine";

const NO_COSTS = { feeBps: 0, slippageBps: 0 };

test("parseGammaTime handles gamma's closedTime format and ISO", () => {
  assert.equal(parseGammaTime("2026-07-10 15:19:58+00"), Date.UTC(2026, 6, 10, 15, 19, 58) / 1000);
  assert.equal(parseGammaTime("2026-07-10T12:00:00Z"), Date.UTC(2026, 6, 10, 12) / 1000);
  assert.equal(parseGammaTime(null), null);
  assert.equal(parseGammaTime("garbage"), null);
});

test("parseTemperatureSlug extracts kind/city/date, rejects non-temperature events", () => {
  assert.deepEqual(parseTemperatureSlug("highest-temperature-in-hong-kong-on-july-10-2026"), {
    kind: "highest",
    city: "hong-kong",
    date: "july-10-2026",
  });
  assert.equal(parseTemperatureSlug("where-will-it-rain-on-september-22-2026"), null);
  assert.equal(cityDateKey("lowest-temperature-in-nyc-on-july-1-2026"), "nyc:july-1-2026");
  assert.equal(cityDateKey("highest-temperature-in-nyc-on-july-1-2026"), "nyc:july-1-2026");
  assert.equal(dateKey("highest-temperature-in-nyc-on-july-1-2026"), "july-1-2026");
});

test("priceAt never looks ahead and rejects stale points", () => {
  const s = [
    { t: 100, p: 0.9 },
    { t: 200, p: 0.95 },
    { t: 300, p: 0.2 },
  ];
  assert.equal(priceAt(s, 250, 1000), 0.95);
  assert.equal(priceAt(s, 200, 1000), 0.95);
  assert.equal(priceAt(s, 50, 1000), null); // nothing at/before
  assert.equal(priceAt(s, 250, 10), null); // latest prior point too stale
});

test("settledWinnerIndex only accepts a clean 0/1 settlement on a closed market", () => {
  assert.equal(settledWinnerIndex({ closed: true, outcomePrices: '["0", "1"]' }), 1);
  assert.equal(settledWinnerIndex({ closed: true, outcomePrices: '["1", "0"]' }), 0);
  assert.equal(settledWinnerIndex({ closed: true, outcomePrices: '["0.5", "0.5"]' }), null);
  assert.equal(settledWinnerIndex({ closed: false, outcomePrices: '["1", "0"]' }), null);
});

test("favoriteSide picks Yes above 0.5, else No at 1-p", () => {
  assert.deepEqual(favoriteSide(0.92), { index: 0, price: 0.92 });
  const no = favoriteSide(0.03);
  assert.equal(no.index, 1);
  assert.ok(Math.abs(no.price - 0.97) < 1e-12);
});

test("bucketFor uses [min,max) and excludes >=99c", () => {
  assert.equal(bucketFor(0.85)?.label, "85-90");
  assert.equal(bucketFor(0.8999)?.label, "85-90");
  assert.equal(bucketFor(0.9)?.label, "90-95");
  assert.equal(bucketFor(0.985)?.label, "95-99");
  assert.equal(bucketFor(0.99), null);
  assert.equal(bucketFor(0.6), null);
});

test("favoriteTrial payout: win returns 1/p - 1, loss -1, costs applied like engine.applyCosts", () => {
  const base = { eventKey: "e", category: "c", conditionId: "m", outcome: "No", entryTimestamp: 0, quotedPrice: 0.95 };
  const win = favoriteTrial({ ...base, won: true, config: NO_COSTS })!;
  assert.ok(Math.abs(win.netReturn - (1 / 0.95 - 1)) < 1e-12);
  assert.equal(win.entryPrice, 0.95);
  const loss = favoriteTrial({ ...base, won: false, config: NO_COSTS })!;
  assert.equal(loss.netReturn, -1);
  const costly = favoriteTrial({ ...base, won: true, config: { feeBps: 100, slippageBps: 100 } })!;
  assert.ok(Math.abs(costly.shares - 0.99 / (0.95 * 1.01)) < 1e-12);
  assert.equal(costly.entryPrice, 0.95); // bucket on the quoted price
  assert.equal(favoriteTrial({ ...base, quotedPrice: 1, won: true, config: NO_COSTS }), null);
});

test("entryTimestamp: end anchor capped at closedTime, close anchor, and not before market start", () => {
  const end = "2026-07-10T12:00:00Z";
  const endTs = Date.UTC(2026, 6, 10, 12) / 1000;
  const m = { startDate: "2026-07-08T04:00:00Z", endDate: end, closedTime: "2026-07-10 15:00:00+00" };
  assert.equal(entryTimestamp(m, end, "end", 24), endTs - 24 * 3600);
  assert.equal(entryTimestamp(m, end, "close", 6), endTs + 3 * 3600 - 6 * 3600);
  const early = { ...m, closedTime: "2026-07-10 08:00:00+00" }; // closed before endDate
  assert.equal(entryTimestamp(early, end, "end", 6), endTs - 4 * 3600 - 6 * 3600);
  assert.equal(entryTimestamp(m, end, "end", 72), null); // before the market existed
});

function market(i: number, finalYes: boolean, closedTime = "2026-07-10 15:00:00+00"): WxMarket {
  return {
    conditionId: `c${i}`,
    question: `range ${i}`,
    outcomes: '["Yes", "No"]',
    outcomePrices: finalYes ? '["1", "0"]' : '["0", "1"]',
    clobTokenIds: `["yes${i}", "no${i}"]`,
    startDate: "2026-07-08T04:00:00Z",
    endDate: "2026-07-10T12:00:00Z",
    closedTime,
    closed: true,
  };
}

test("eventTrials builds one favorite trial per settled in-band market, keyed by event", () => {
  const endTs = Date.UTC(2026, 6, 10, 12) / 1000;
  const entry = endTs - 24 * 3600;
  const event: WxEvent = {
    slug: "highest-temperature-in-seoul-on-july-10-2026",
    endDate: "2026-07-10T12:00:00Z",
    markets: [market(0, false), market(1, true), market(2, false), market(3, false)],
  };
  const histories = new Map([
    [
      "yes0",
      [
        { t: entry - 600, p: 0.04 },
        { t: entry + 600, p: 0.5 },
      ],
    ], // No favorite at 96c, won (look-ahead point ignored)
    ["yes1", [{ t: entry - 600, p: 0.88 }]], // Yes favorite at 88c, won
    ["yes2", [{ t: entry - 600, p: 0.4 }]], // favorite at 60c -> out of every bucket
    ["yes3", [{ t: entry - 600, p: 0.08 }]], // No favorite at 92c, market settled No -> won
  ]);
  const trials = eventTrials({ event, histories, anchor: "end", leadHours: 24, maxStaleSeconds: 3 * 3600, config: NO_COSTS });
  assert.equal(trials.length, 3);
  assert.ok(trials.every((t) => t.eventKey === event.slug && t.category === "highest-temp" && t.entryTimestamp === entry));
  const byCond = new Map(trials.map((t) => [t.conditionId, t]));
  assert.equal(byCond.get("c0")!.outcome, "No");
  assert.ok(Math.abs(byCond.get("c0")!.entryPrice - 0.96) < 1e-12);
  assert.equal(byCond.get("c1")!.outcome, "Yes");
  assert.equal(byCond.get("c1")!.won, true);
  assert.equal(byCond.has("c2"), false);

  // A losing favorite: Yes quoted at 90c but the range didn't hit.
  const lossEvent: WxEvent = { ...event, markets: [market(5, false)] };
  const lossTrials = eventTrials({
    event: lossEvent,
    histories: new Map([["yes5", [{ t: entry - 60, p: 0.9 }]]]),
    anchor: "end",
    leadHours: 24,
    maxStaleSeconds: 3600,
    config: NO_COSTS,
  });
  assert.equal(lossTrials.length, 1);
  assert.equal(lossTrials[0].won, false);
  assert.equal(lossTrials[0].netReturn, -1);
});

test("clustering: correlated range-markets collapse to one event; stricter regroupings merge further", () => {
  const cfg = defaultBacktestConfig();
  const mk = (eventKey: string, i: number) =>
    favoriteTrial({
      eventKey,
      category: "x",
      conditionId: `${eventKey}${i}`,
      outcome: "No",
      entryTimestamp: i,
      quotedPrice: 0.95,
      won: true,
      config: NO_COSTS,
    })!;
  const trials = [
    mk("highest-temperature-in-nyc-on-july-1-2026", 0),
    mk("highest-temperature-in-nyc-on-july-1-2026", 1),
    mk("lowest-temperature-in-nyc-on-july-1-2026", 2),
    mk("highest-temperature-in-paris-on-july-1-2026", 3),
  ];
  assert.equal(computeStrategyResult(trials, cfg).distinctEvents, 3);
  assert.equal(computeStrategyResult(regroup(trials, cityDateKey), cfg).distinctEvents, 2);
  assert.equal(computeStrategyResult(regroup(trials, dateKey), cfg).distinctEvents, 1);
});

test("pickEvents is deterministic, order-independent, temperature-only", () => {
  const evs: WxEvent[] = ["a", "b", "c", "d", "e"].map((c) => ({ slug: `highest-temperature-in-${c}-on-july-1-2026` }));
  evs.push({ slug: "where-will-it-rain-on-july-1-2026" });
  const p1 = pickEvents(evs, 3).map((e) => e.slug);
  const p2 = pickEvents([...evs].reverse(), 3).map((e) => e.slug);
  assert.deepEqual(p1, p2);
  assert.equal(p1.length, 3);
  assert.ok(p1.every((s) => s.includes("temperature")));
});

test("parseArgs defaults and validation", () => {
  const d = parseArgs([]);
  assert.deepEqual(d.leadHours, [24, 6]);
  assert.equal(d.anchor, "end");
  assert.equal(d.slippageBps, 50);
  assert.deepEqual(parseArgs(["--leadHours=12", "--anchor=close"]).leadHours, [12]);
  assert.throws(() => parseArgs(["--anchor=foo"]));
  assert.throws(() => parseArgs(["--leadHours=x"]));
  assert.throws(() => parseArgs(["--days=0"]));
});

test("cacheWindowCovers: reusable only for the same anchor and a lead range inside the pulled window", () => {
  const pulled = { anchor: "end" as const, minLead: 6, maxLead: 24, maxStaleHours: 3 };
  assert.equal(cacheWindowCovers(pulled, pulled), true);
  assert.equal(cacheWindowCovers(pulled, { ...pulled, minLead: 12, maxLead: 12 }), true);
  assert.equal(cacheWindowCovers(pulled, { ...pulled, minLead: 2 }), false);
  assert.equal(cacheWindowCovers(pulled, { ...pulled, maxLead: 48 }), false);
  assert.equal(cacheWindowCovers(pulled, { ...pulled, anchor: "close" }), false);
});
