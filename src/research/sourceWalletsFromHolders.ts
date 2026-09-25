// New wallet-sourcing channel (docs/IMPROVEMENT_PLAN.md Track E.13's
// original "needs a different channel" list named this explicitly: "per-market
// top holders" -- never built until now). Different signal from
// sourceWallets.ts's leaderboard sweep: instead of "who made the most money
// historically" (which today's archetype-cohort sweep found has gone almost
// entirely dormant -- 94 of 95 tracked wallets), this asks "who has a large
// real position in a market that's trading heavily RIGHT NOW." Structurally
// biased toward currently-active wallets, which is exactly what the quality
// pool is short of.
//
// Method, each step confirmed against a real live call before being wired
// up here (2026-09-15, not doc-sourced):
// 1. getActiveEventsByVolume() -- gamma-api /events?order=volume24hr, the
//    hottest markets right now, independent of any wallet's history.
// 2. For each event's first few markets, getTopHolders() -- data-api
//    /holders?market=<conditionId>, pre-sorted descending by outcome-token
//    amount (share count, not USD -- a real position, not a leaderboard
//    guess).
// 3. Dedupe against TRACKED_WALLETS; wallets appearing as a top holder in
//    MULTIPLE distinct hot markets are a stronger signal than one, tracked
//    and surfaced the same way sourceWallets.ts tracks
//    "categoriesSeenIn" for its own convergence signal.
// 4. Cheaply pre-filter a larger shortlisted pool for genuine RECENT
//    activity (one fast most-recent-first /activity call each) before the
//    expensive full pull -- added after the first live run found holder
//    `amount` (position size) doesn't predict recency at all: 4/4
//    size-shortlisted candidates came back dormant. A wallet can place one
//    big bet and go quiet holding it.
// 5. Score the recency-filtered survivors through scoreWalletShallow() --
//    NOT scoreWallet(). Found live: scoreWallet()'s getActivityFromStart
//    pages forward from a wallet's OLDEST activity, so even a shallow page
//    budget on a high-volume wallet can cap out before reaching recent
//    trades, falsely flagging a genuinely active wallet "dormant" (it did,
//    twice, on real candidates here). scoreWalletShallow() uses
//    getActivityDeep instead (pages backward from NOW) -- a non-reproducible
//    quick screen, not a trustworthy final number, but one that actually
//    answers "is this wallet active" correctly.
// 6. Since Track M1/M2 (2026-09-24): any shallow result that passes
//    isQualityWallet() is auto-confirmed from a pinned anchor
//    (walletConfirmation.ts, the same logic as `npm run confirm-shallow`),
//    and every score is recorded in `wallet_scores`.
//
// Adds nothing to wallets.ts or the tracking daemon's tables; prints a
// ready-to-paste wallets.ts entry per confirmed quality wallet. To actually
// track one, paste it into wallets.ts and run `npm run wallets:add`.
//
// Usage: npm run source-wallets-holders [-- --tag=<gamma tag slug>] [--screen=activity|positions]
//
// `--screen=positions` (K5, opt-in) screens with src/scoring/positionsScreen.ts
// instead of scoreWalletShallow; see src/research/screenMode.ts for why it
// isn't the default.
//
// `--tag` (e.g. `--tag=soccer`) restricts the scan to one category's
// events. Added 2026-09-24 (item 42): the quality pool's first-ever market
// overlap was two soccer wallets, and the consensus/divergence tests need
// more wallets in ONE category to overlap -- untagged, the top-by-volume
// events spread across every category.

import "dotenv/config";
import { getActiveEventsByVolume, getTopHolders, getActivity } from "../api/client";
import { scoreWalletShallow } from "../scoring/walletScore";
import { runMigrations } from "../storage/migrate";
import { recentlyConfirmedAddresses, RESCORE_AFTER_DAYS } from "./recentlyScored";
import { TRACKED_WALLETS, type TrackedWallet } from "../wallets";
import { printVerdicts, screenAndConfirm, type PipelineOutcome, type ScoringAttempt } from "./walletConfirmation";
import { parseScreenMode, positionsScreenAttempt, POSITIONS_SOURCE_SUFFIX } from "./screenMode";

const EVENTS_TO_SCAN = 15;
const MARKETS_PER_EVENT = 3; // caps ladder-style events with dozens of sub-markets
const HOLDERS_PER_MARKET_SIDE = 15;
// Kept small deliberately: a holder-sourced candidate can be a genuine
// whale with a very long trading history (the whole point of this channel
// is finding large, currently-active positions), and each candidate's
// scoreWalletShallow() pull is rate-limited to ~1/sec per unique market
// resolved. This is a fast FIRST PASS to see if the channel surfaces
// anything real at all -- a promising candidate gets a deeper, slower
// anchored re-check (same "shallow scan first, confirm on deeper pull"
// pattern this project already used for 0x_exit: historyPages raised from
// 10 to 40 only once the shallow pass looked worth it), which since
// 2026-09-24 runs automatically on each isQualityWallet() pass (step 6).
const MAX_CANDIDATES_TO_SCORE = 15;
const SHALLOW_HISTORY_PAGES = 4;
const SOURCE = "source-wallets-holders";

// Real finding, first live run of this script (2026-09-15): shortlisting by
// position size/market-count alone scored 4/4 candidates dormant. Holder
// `amount` reflects position SIZE, not RECENCY -- a wallet can place one
// big bet and go quiet holding it. A much larger pool is now cheaply
// pre-filtered for genuine recent activity (a single 1-call, most-recent-
// first /activity check per candidate -- not the expensive multi-page
// historical pull) BEFORE the few survivors get the slower
// scoreWalletShallow() treatment, instead of discovering dormancy only
// after paying for that pull.
const RECENCY_PREFILTER_POOL_SIZE = 80;
const RECENCY_WINDOW_DAYS = 14;

interface Sighting {
  address: string;
  name: string | null;
  amount: number;
  eventTitle: string;
  marketQuestion: string;
}

interface Candidate {
  address: string;
  name: string | null;
  bestSighting: Sighting;
  marketsSeenIn: Set<string>; // eventTitle:marketQuestion, for a human-readable "seen in N markets" count
}

async function collectSightings(tagSlug?: string): Promise<Sighting[]> {
  const events = await getActiveEventsByVolume(EVENTS_TO_SCAN, tagSlug);
  console.log(`${events.length} active ${tagSlug ? `"${tagSlug}" ` : ""}events by 24h volume.`);

  const sightings: Sighting[] = [];
  for (const event of events) {
    const markets = (event.markets ?? []).slice(0, MARKETS_PER_EVENT);
    for (const market of markets) {
      let groups;
      try {
        groups = await getTopHolders(market.conditionId, HOLDERS_PER_MARKET_SIDE);
      } catch (err) {
        console.log(`  [${event.title} / ${market.question}] holders pull failed: ${(err as Error).message}`);
        continue;
      }
      for (const group of groups) {
        for (const holder of group.holders) {
          sightings.push({
            address: holder.proxyWallet,
            name: holder.name || holder.pseudonym || null,
            amount: holder.amount,
            eventTitle: event.title,
            marketQuestion: market.question,
          });
        }
      }
    }
  }
  return sightings;
}

function dedupe(skipRecent: Set<string>, sightings: Sighting[]): Map<string, Candidate> {
  const tracked = new Set(TRACKED_WALLETS.map((w) => w.address.toLowerCase()));
  for (const addr of skipRecent) tracked.add(addr);
  const byAddress = new Map<string, Candidate>();
  for (const s of sightings) {
    const addr = s.address.toLowerCase();
    if (tracked.has(addr)) continue;
    const marketKey = `${s.eventTitle}:${s.marketQuestion}`;
    const existing = byAddress.get(addr);
    if (!existing) {
      byAddress.set(addr, { address: s.address, name: s.name, bestSighting: s, marketsSeenIn: new Set([marketKey]) });
    } else {
      existing.marketsSeenIn.add(marketKey);
      if (s.amount > existing.bestSighting.amount) existing.bestSighting = s;
      if (!existing.name && s.name) existing.name = s.name;
    }
  }
  return byAddress;
}

// Multi-market convergence (a wallet sized into more than one currently-hot
// market) first -- a stronger, different signal than single-market size
// alone -- then fill remaining slots by largest single position. Returns a
// pool larger than MAX_CANDIDATES_TO_SCORE -- the recency pre-filter below
// is what actually narrows it down to real scoring candidates.
function shortlist(deduped: Map<string, Candidate>, poolSize: number): Candidate[] {
  const all = [...deduped.values()];
  const multiMarket = all.filter((c) => c.marketsSeenIn.size >= 2).sort((a, b) => b.marketsSeenIn.size - a.marketsSeenIn.size);
  const singleMarket = all.filter((c) => c.marketsSeenIn.size < 2).sort((a, b) => b.bestSighting.amount - a.bestSighting.amount);
  return [...multiMarket, ...singleMarket].slice(0, poolSize);
}

// Cheap: one call, most-recent-first (getActivity's default sortDirection),
// small limit -- NOT getActivityFromStart's multi-page historical pull. Just
// "has this wallet traded within RECENCY_WINDOW_DAYS," nothing more.
async function isRecentlyActive(address: string): Promise<boolean> {
  const recent = await getActivity(address, { limit: 5 });
  const trades = recent.filter((a) => a.type === "TRADE");
  if (trades.length === 0) return false;
  const lastTs = Math.max(...trades.map((a) => a.timestamp));
  const daysSince = (Math.floor(Date.now() / 1000) - lastTs) / 86400;
  return daysSince <= RECENCY_WINDOW_DAYS;
}

async function main() {
  runMigrations();
  console.log(`Scanning top ${EVENTS_TO_SCAN} active events by 24h volume, top ${MARKETS_PER_EVENT} markets each...`);
  const tagSlug = process.argv
    .slice(2)
    .find((a) => a.startsWith("--tag="))
    ?.slice("--tag=".length);
  const screenMode = parseScreenMode(process.argv.slice(2));
  const source = screenMode === "positions" ? SOURCE + POSITIONS_SOURCE_SUFFIX : SOURCE;
  console.log(`Screen: ${screenMode}.`);
  const sightings = await collectSightings(tagSlug);
  console.log(`${sightings.length} raw (market, holder) sightings.`);

  const skipRecent = recentlyConfirmedAddresses();
  const deduped = dedupe(skipRecent, sightings);
  console.log(
    `${deduped.size} distinct wallets not already in TRACKED_WALLETS or confirmed-scored in the last ${RESCORE_AFTER_DAYS} days ` +
      `(${skipRecent.size} recently confirmed; --rescore to include them).`
  );

  const prefilterPool = shortlist(deduped, RECENCY_PREFILTER_POOL_SIZE);
  console.log(
    `Cheaply checking recency (1 call each, most-recent-first) for the top ${prefilterPool.length} by convergence/size, ` +
      `looking for >=${MAX_CANDIDATES_TO_SCORE} active within the last ${RECENCY_WINDOW_DAYS} days...`
  );
  const candidates: Candidate[] = [];
  for (const candidate of prefilterPool) {
    if (candidates.length >= MAX_CANDIDATES_TO_SCORE) break;
    let active: boolean;
    try {
      active = await isRecentlyActive(candidate.address);
    } catch (err) {
      console.log(`  [${candidate.address}] recency check failed: ${(err as Error).message}`);
      continue;
    }
    console.log(`  [${candidate.address}] ${candidate.name ?? "(no username)"} recently active: ${active}`);
    if (active) candidates.push(candidate);
  }
  console.log(`\n${candidates.length} of ${prefilterPool.length} checked passed the recency pre-filter.`);
  console.log(`Scoring ${candidates.length} candidates (multi-market convergence first, then largest single position)...\n`);

  const outcomes: PipelineOutcome[] = [];
  for (const candidate of candidates) {
    const wallet: TrackedWallet = {
      address: candidate.address,
      label: `${candidate.name ?? candidate.address} (top-holder sourced${tagSlug ? ` --tag=${tagSlug}` : ""}, seen in ${candidate.marketsSeenIn.size} hot market(s), best position ${candidate.bestSighting.amount.toFixed(0)} shares in "${candidate.bestSighting.marketQuestion}")`,
      archetype: "unclassified",
      source: "npm run source-wallets-holders (data-api /holders on active-by-volume24hr events)",
    };
    const base = { address: wallet.address, label: wallet.label, provenance: wallet.source };
    console.log(`  scoring [${candidate.address}] ${candidate.name ?? "(no username)"}...`);
    try {
      let screen: ScoringAttempt;
      if (screenMode === "positions") {
        screen = await positionsScreenAttempt(wallet);
      } else {
        const { score, activity } = await scoreWalletShallow(wallet, SHALLOW_HISTORY_PAGES);
        screen = {
          method: "shallow",
          historyStart: null,
          historyPages: SHALLOW_HISTORY_PAGES,
          truncated: false,
          fills: activity.length,
          score,
        };
      }
      console.log(
        `    -> ${screenMode} screen qualityScore=${screen.score.qualityScore}/100  flags=${screen.score.flags.join(",") || "(none)"}`
      );
      // Track M1 (2026-09-24): shallow passes (isQualityWallet, not the old
      // ">= 50") are auto-confirmed from a pinned anchor right here -- item
      // 42 did this by hand and 3 of 3 real-looking soccer passes failed.
      const outcome = await screenAndConfirm(base, screen, { source, log: (line) => console.log(`  ${line}`) });
      outcomes.push(outcome);
      if (outcome.kind !== "screened-out") console.log(`      -> ${outcome.kind}${outcome.reason ? `: ${outcome.reason}` : ""}`);
    } catch (err) {
      console.log(`    -> scoring failed: ${(err as Error).message}`);
      outcomes.push({ ...base, kind: "error", reason: (err as Error).message });
    }
  }

  printVerdicts(outcomes);

  const count = (kind: PipelineOutcome["kind"]) => outcomes.filter((o) => o.kind === kind).length;
  console.log(
    `\nSummary: ${sightings.length} raw sightings -> ${deduped.size} new wallets -> ${prefilterPool.length} checked for recency -> ` +
      `${candidates.length} passed (active within ${RECENCY_WINDOW_DAYS}d) -> ` +
      `${count("confirmed-quality")} confirmed quality / ${count("failed-confirmation")} failed confirmation / ` +
      `${count("unconfirmed-truncated")} unconfirmed (truncated) / ${count("screened-out")} screened out` +
      `${count("error") ? ` / ${count("error")} scoring errors` : ""}.`
  );
}

if (require.main === module) {
  main();
}
