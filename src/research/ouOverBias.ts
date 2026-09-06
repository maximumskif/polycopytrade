// Strategy-fork test (2026-08-17): is "buy Over" a market-wide MLB
// over/under inefficiency, or just 0x1b20a0...'s own game-selection skill?
//
// That wallet's real Over fills hit 96.7% (269 fills / 12 distinct games,
// avg entry price 0.43 — see docs/AUDIT.md) — but 12 games is this
// wallet's own picks, not an independent test. This mirrors Phase 1g's
// method exactly: the ladder-harvester's narrow "HIGH-side rung, 15-30c"
// rule looked great on the wallet that revealed it, then didn't clearly
// replicate on unseen ladder events. Same discipline here: pull a BROAD,
// wallet-agnostic sample of real MLB O/U lines (every line on every game,
// not filtered to any one trader's picks) and check whether buying Over
// indiscriminately at its real closing price would have been profitable.
//
// Source: gamma-api's /events?tag_slug=mlb listing (see getEventsByTag) —
// NOT /public-search, which only surfaces season-long prop events for a
// generic "MLB" query (confirmed by testing), never individual games.
//
// One real game has several O/U lines (5.5, 6.5, 7.5, ... runs), all
// settled by the same final score — so they're correlated, not
// independent trials. Each line is still a real, separately-priced market
// (worth including), but eventKey = the game's event slug so
// computeStrategyResult's distinctEvents/effectiveIndependentSampleCount
// correctly treats "5 lines on one game" as ~1 real data point, not 5 —
// same sample-inflation guard as everywhere else in this project.

import { getEventsByTag, getPricesHistory, type GammaEvent, type GammaMarket } from "../api/client";
import { computeStrategyResult } from "../backtesting/statistics";
import type { BacktestConfig, BacktestTrial } from "../domain/types";

const GAME_EVENT_SLUG = /^mlb-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/;
// Main full-game O/U line only — excludes "1st 5 Innings O/U", spreads,
// moneylines, and prop markets, which are a different bet type entirely.
const MAIN_OU_QUESTION = /: O\/U [\d.]+$/;
const EVENTS_PER_PAGE = 100;
const MAX_EVENT_PAGES = 3; // ~300 recent closed games is plenty for a broad, independent read

interface OuLine {
  eventSlug: string;
  market: GammaMarket;
  overTokenId: string;
  overEntryPrice: number; // real CLOB closing price, minutes before game time
  overWon: boolean;
  endTs: number;
}

async function fetchGameEvents(): Promise<GammaEvent[]> {
  const out: GammaEvent[] = [];
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const batch = await getEventsByTag("mlb", { closed: true, limit: EVENTS_PER_PAGE, offset: page * EVENTS_PER_PAGE });
    if (batch.length === 0) break;
    out.push(...batch.filter((e) => GAME_EVENT_SLUG.test(e.slug)));
    if (batch.length < EVENTS_PER_PAGE) break;
  }
  return out;
}

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The real market-consensus price right before the game locks, not an
// early/thin opening tick — same "closing line" reasoning sportsbook
// efficiency studies use. Walks backward from endDate in growing windows
// since we don't know in advance how far back the last real tick is.
async function closingOverPrice(tokenId: string, endTs: number): Promise<number | null> {
  const windows = [
    [endTs - 2 * 3600, endTs - 60],
    [endTs - 12 * 3600, endTs - 60],
    [endTs - 48 * 3600, endTs - 60],
  ];
  for (const [start, end] of windows) {
    const res = await getPricesHistory(tokenId, start, end, 5);
    const history = res.history ?? [];
    if (history.length > 0) return history[history.length - 1].p;
  }
  return null;
}

async function collectOuLines(events: GammaEvent[]): Promise<OuLine[]> {
  const lines: OuLine[] = [];
  for (const event of events) {
    for (const market of event.markets ?? []) {
      if (!market.closed || !MAIN_OU_QUESTION.test(market.question)) continue;
      const outcomes = parseJsonArray(market.outcomes);
      const outcomePrices = parseJsonArray(market.outcomePrices);
      const tokenIds = parseJsonArray(market.clobTokenIds);
      const overIdx = outcomes.indexOf("Over");
      if (overIdx === -1 || tokenIds.length !== outcomes.length || outcomePrices.length !== outcomes.length) continue;
      if (!market.endDate) continue;

      const endTs = Math.floor(new Date(market.endDate).getTime() / 1000);
      const overEntryPrice = await closingOverPrice(tokenIds[overIdx], endTs);
      if (overEntryPrice === null) continue; // no observable pre-game price, skip rather than guess

      lines.push({
        eventSlug: event.slug,
        market,
        overTokenId: tokenIds[overIdx],
        overEntryPrice,
        overWon: outcomePrices[overIdx] === "1",
        endTs,
      });
    }
  }
  return lines;
}

function toTrials(lines: OuLine[]): BacktestTrial[] {
  return lines.map((l) => {
    const shares = l.overEntryPrice > 0 ? 1 / l.overEntryPrice : 0;
    const netReturn = l.overWon ? shares - 1 : -1; // $1 stake per line
    return {
      walletAddress: "market-wide-no-wallet",
      conditionId: l.market.conditionId,
      outcome: "Over",
      eventKey: l.eventSlug,
      category: "sports",
      entryTimestamp: l.endTs,
      entryPrice: l.overEntryPrice,
      usdcStaked: 1,
      shares,
      resolved: true,
      won: l.overWon,
      netReturn,
    };
  });
}

function baseConfig(strategyName: string): BacktestConfig {
  return {
    strategyName,
    strategyVersion: "1",
    datasetCutoff: Math.floor(Date.now() / 1000),
    walletAddresses: [],
    entryRule: "buy Over at closing price on every main-game MLB O/U line",
    exitRule: "hold-to-resolution",
    observationDelaySeconds: 0,
    executionDelaySeconds: 0,
    feeBps: 0,
    slippageBps: 0,
    resolutionTreatment: "hold-to-resolution",
  };
}

function printResult(label: string, trials: BacktestTrial[]): void {
  if (trials.length === 0) {
    console.log(`\n[${label}] no trials`);
    return;
  }
  const r = computeStrategyResult(trials, baseConfig(label));
  console.log(`\n[${label}]`);
  console.log(
    `  trials=${r.trialCount}  distinctGames=${r.distinctEvents}  effectiveIndependentSampleCount=${r.effectiveIndependentSampleCount.toFixed(1)}`
  );
  console.log(`  winRate=${(r.winRate * 100).toFixed(1)}%  netPnl=$${r.netPnl.toFixed(2)}  roi=${(r.roi * 100).toFixed(1)}%`);
  if (r.roiBootstrapCI) {
    console.log(`  95% ROI CI: [${(r.roiBootstrapCI[0] * 100).toFixed(1)}%, ${(r.roiBootstrapCI[1] * 100).toFixed(1)}%]`);
  } else {
    console.log(`  95% ROI CI: n/a (too few independent events)`);
  }
}

const PRICE_BANDS: Array<[number, number, string]> = [
  [0, 0.2, "0-20c"],
  [0.2, 0.3, "20-30c"],
  [0.3, 0.56, "30-56c (wallet's own observed Over range)"],
  [0.56, 0.7, "56-70c"],
  [0.7, 1.01, "70c+"],
];

async function main() {
  console.log("Pulling closed MLB game events (gamma-api /events?tag_slug=mlb)...");
  const events = await fetchGameEvents();
  console.log(`${events.length} closed individual-game events found.`);

  console.log("Collecting main-game O/U lines + real closing prices (one CLOB call per line, ~1/sec)...");
  const lines = await collectOuLines(events);
  console.log(`${lines.length} O/U lines with an observable closing price.`);

  const allTrials = toTrials(lines);
  printResult("ALL main-game O/U lines — buy Over indiscriminately", allTrials);

  for (const [lo, hi, name] of PRICE_BANDS) {
    const banded = allTrials.filter((t) => t.entryPrice >= lo && t.entryPrice < hi);
    printResult(`Over, entry price ${name}`, banded);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
