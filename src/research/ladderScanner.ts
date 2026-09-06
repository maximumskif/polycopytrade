// Phase 1, ladder-harvester track: find current BTC/oil price-ladder events
// and surface the rungs sitting in the "harvest zone" 0x_exit described —
// cheap (retail-longshot-driven-down) outcomes that pay $1 at expiry.
//
// This is a SCANNER, not a strategy yet: it surfaces candidates for the
// human (or a later backtest) to judge, it does not decide what's "boring
// vs obvious" on its own. That judgment needs historical resolution data
// (how often does the 10-30c rung actually win?) which lives in Phase 1's
// backtest, not here.
//
// Confirmed via 0x_exit's actual open positions: the event slugs follow
// "what-price-will-<asset>-hit-in-<month>-<year>", e.g.
// "what-price-will-wti-hit-in-august-2026". Each event bundles the whole
// ladder of "hit $X" sub-markets.

import { searchEvents, type GammaEvent, type GammaMarket } from "../api/client";

const QUERIES = ["what price will bitcoin hit", "what price will wti hit"];

// Empirically: 0x_exit's real open positions were bought at 27-50c (per the
// live wallet data we pulled), and the post describes entries as low as 6c.
// Keep the band wide for the scanner; tighten once Phase 1 backtests show
// where the actual edge lives.
const HARVEST_ZONE = { min: 0.05, max: 0.45 };
const MIN_VOLUME = 500; // filters out dead/illiquid rungs

interface Candidate {
  event: string;
  market: string;
  outcome: string;
  price: number;
  impliedPayoutMultiple: number; // 1 / price, what a correct $1 outcome returns
  volume: number;
  endDate: string;
}

function candidatesFromMarket(eventTitle: string, market: GammaMarket): Candidate[] {
  // Some markets returned by search (e.g. negRisk/grouped sub-markets) don't
  // carry standalone outcomes/outcomePrices/volume — skip those rather than
  // guessing at their shape.
  if (!market.outcomes || !market.outcomePrices || market.volume == null || !market.endDate) return [];

  const outcomes: string[] = JSON.parse(market.outcomes);
  const prices: number[] = JSON.parse(market.outcomePrices).map(Number);
  const volume = Number(market.volume);
  const endDate = market.endDate;
  if (!(volume >= MIN_VOLUME)) return [];

  const out: Candidate[] = [];
  outcomes.forEach((outcome, i) => {
    const price = prices[i];
    if (price >= HARVEST_ZONE.min && price <= HARVEST_ZONE.max) {
      out.push({
        event: eventTitle,
        market: market.question,
        outcome,
        price,
        impliedPayoutMultiple: 1 / price,
        volume,
        endDate,
      });
    }
  });
  return out;
}

export async function main() {
  const allCandidates: Candidate[] = [];

  for (const query of QUERIES) {
    const events: GammaEvent[] = await searchEvents(query, 10);
    for (const event of events) {
      for (const market of event.markets ?? []) {
        allCandidates.push(...candidatesFromMarket(event.title, market));
      }
    }
  }

  allCandidates.sort((a, b) => b.volume - a.volume);

  console.log(`Found ${allCandidates.length} rungs in the ${HARVEST_ZONE.min}-${HARVEST_ZONE.max} harvest zone:\n`);
  for (const c of allCandidates) {
    console.log(
      `${(c.price * 100).toFixed(1)}c  ${c.outcome.padEnd(4)}  vol=$${c.volume.toFixed(0).padStart(8)}  ` +
        `pays ${c.impliedPayoutMultiple.toFixed(2)}x  ends ${c.endDate.slice(0, 10)}  — ${c.market}`
    );
  }
}

if (require.main === module) {
  main();
}
