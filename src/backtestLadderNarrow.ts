// Phase 1g: Phase 1f found nearly all of 0x_exit's wallet's real profit came
// from one narrow slice of its trades — HIGH-side WTI ladder rungs bought at
// 15-30c (+103% net) — but that finding came entirely from the wallet's own
// historical trades, and the wallet went dormant on 2026-05-17. This tests
// whether that's a property of the MARKET (a mispricing still checkable
// today, independent of any one wallet) rather than something specific to
// that wallet's trading window.
//
// Reuses backtestLadder.ts's "first touch into a price zone, hold to
// expiry" methodology (same rigor/limitations — no slippage/depth
// modeling, single first-touch entry) with two changes: (1) the zone is
// narrowed to 15-30c instead of Phase 1a's flat 5-45c, and (2) events are
// restricted to ones that CLOSED AFTER the wallet went dormant, so this is
// genuinely out-of-sample relative to Phase 1f's data, not a re-read of the
// same historical window. Tests both WTI (where the signal was found) and
// BTC (to check whether it's WTI-specific or a general ladder-market
// pattern), and both HIGH-side and LOW-side rungs (Phase 1f found HIGH
// outperformed LOW sharply within the wallet's own trades).

import { searchEvents, type GammaEvent, type GammaMarket } from "./polymarketClient";
import { backtestMarket, summarize as summarizeLadder, type Trial } from "./backtestLadder";

function summarize(trials: Trial[]) {
  if (trials.length === 0) {
    console.log(`\nn=0 (no trials in this slice)`);
    return;
  }
  summarizeLadder(trials);
}

const NARROW_ZONE = { min: 0.15, max: 0.3 };
// The wallet's last trade was 2026-05-17 (see README Phase 1e/1f) — only
// events resolving after this are genuinely unseen by that wallet.
const OUT_OF_SAMPLE_CUTOFF = new Date("2026-05-17T00:00:00Z").getTime();

async function getOutOfSampleLadderEvents(query: string, monthSlugFragment: string): Promise<GammaEvent[]> {
  const events = await searchEvents(query, 30, "closed");
  return events
    .filter((e) => e.slug.includes(monthSlugFragment) && e.slug.match(/-in-[a-z]+-2026$/))
    .filter((e) => new Date(e.endDate).getTime() > OUT_OF_SAMPLE_CUTOFF)
    .sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
}

const isHighRung = (m: GammaMarket) => /\(HIGH\)/.test(m.question);
const isLowRung = (m: GammaMarket) => /\(LOW\)/.test(m.question);

interface TaggedTrial extends Trial {
  rungSide: "HIGH" | "LOW" | "n/a";
}

export async function main() {
  const wtiEvents = await getOutOfSampleLadderEvents("what price will wti hit", "what-price-will-wti-hit");
  const btcEvents = await getOutOfSampleLadderEvents("what price will bitcoin hit", "what-price-will-bitcoin-hit");

  console.log(
    `Out-of-sample ladders (closed after ${new Date(OUT_OF_SAMPLE_CUTOFF).toISOString().slice(0, 10)}): ` +
      `${wtiEvents.length} WTI, ${btcEvents.length} BTC`
  );
  console.log(`Zone: ${NARROW_ZONE.min * 100}-${NARROW_ZONE.max * 100}c\n`);

  const trials: TaggedTrial[] = [];
  for (const [asset, events] of [
    ["WTI", wtiEvents],
    ["BTC", btcEvents],
  ] as const) {
    for (const event of events) {
      for (const market of event.markets ?? []) {
        try {
          const trial = await backtestMarket(asset, event.title, market, NARROW_ZONE);
          if (trial) {
            const rungSide = isHighRung(market) ? "HIGH" : isLowRung(market) ? "LOW" : "n/a";
            trials.push({ ...trial, rungSide });
          }
        } catch (err) {
          console.error(`  skip ${market.question}: ${(err as Error).message}`);
        }
      }
    }
  }

  console.log(`=== All out-of-sample rungs, ${NARROW_ZONE.min * 100}-${NARROW_ZONE.max * 100}c zone ===`);
  summarize(trials);

  console.log(`\n=== HIGH-side rungs only (the specific Phase 1f signal) ===`);
  summarize(trials.filter((t) => t.rungSide === "HIGH"));

  console.log(`\n=== LOW-side rungs only ===`);
  summarize(trials.filter((t) => t.rungSide === "LOW"));

  console.log(`\n=== WTI only, HIGH-side (closest match to Phase 1f's actual finding) ===`);
  summarize(trials.filter((t) => t.asset === "WTI" && t.rungSide === "HIGH"));

  console.log(`\n=== BTC only, HIGH-side (generalization check) ===`);
  summarize(trials.filter((t) => t.asset === "BTC" && t.rungSide === "HIGH"));
}

if (require.main === module) {
  main();
}
