import { test } from "node:test";
import assert from "node:assert/strict";
import { asOurPrices, bidPrice, filledShares, sessions } from "../src/research/mmPaperEval";
import type { SnapshotRow } from "../src/research/oddsSnapshot";

test("bidPrice: fair - margin, never crossing the ask, 1c tick", () => {
  assert.equal(bidPrice({ fair: 0.567, pmAsk: 0.6 }, 2), 0.54);
  assert.equal(bidPrice({ fair: 0.6, pmAsk: 0.57 }, 1), 0.56); // capped at ask - 1c
  assert.equal(bidPrice({ fair: 0.015, pmAsk: null }, 1), null);
});

test("filledShares: through needs prints below the bid, touch counts the bid", () => {
  const tape = [
    { price: 0.55, size: 40 },
    { price: 0.54, size: 30 },
    { price: 0.53, size: 50 },
  ];
  assert.equal(filledShares(tape, 0.54, 100, "through"), 50);
  assert.equal(filledShares(tape, 0.54, 100, "touch"), 80);
  assert.equal(filledShares(tape, 0.54, 60, "touch"), 60);
  assert.equal(filledShares(tape, 0.5, 100, "through"), 0);
});

test("asOurPrices maps complement-token trades to 1 - price", () => {
  const t = asOurPrices(
    [
      { asset: "A", price: 0.4, size: 1 },
      { asset: "B", price: 0.7, size: 2 },
    ],
    "A"
  );
  assert.deepEqual(t[0], { price: 0.4, size: 1 });
  assert.ok(Math.abs(t[1].price - 0.3) < 1e-9);
});

test("sessions: each snapshot quotes until the next one or kickoff", () => {
  const side = { label: "X", conditionId: "c", tokenId: "A", fair: 0.5, pmBid: 0.49, pmAsk: 0.51 };
  const rows: SnapshotRow[] = [
    { ts: 100, sport: "s", eventSlug: "g", commenceTime: new Date(1000 * 1000).toISOString(), sides: [side] },
    { ts: 500, sport: "s", eventSlug: "g", commenceTime: new Date(1000 * 1000).toISOString(), sides: [side] },
    { ts: 2000, sport: "s", eventSlug: "late", commenceTime: new Date(1000 * 1000).toISOString(), sides: [side] },
  ];
  const s = sessions(rows);
  assert.deepEqual(
    s.map((x) => [x.eventSlug, x.start, x.end]),
    [
      ["g", 100, 500],
      ["g", 500, 1000],
    ]
  );
});
