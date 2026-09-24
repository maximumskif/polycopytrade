// Track E.13 -- new wallet sourcing beyond the exhausted OVERALL leaderboard.
// Sweeps the 9 non-OVERALL data-api leaderboard categories (POLITICS,
// SPORTS, ESPORTS, CRYPTO, CULTURE, WEATHER, ECONOMICS, TECH, FINANCE)
// across the MONTH and ALL windows, PNL-ordered only -- see
// docs/IMPROVEMENT_PLAN.md Track E.13 for why VOL/WEEK are skipped in this
// first pass (volume-ranked wallets have repeatedly turned out to be
// uncopyable high-frequency bots among this project's existing
// TRACKED_WALLETS entries; WEEK is too noisy/short-lived).
//
// Dedupes against TRACKED_WALLETS (a wallet already tracked is dropped even
// if it also tops a new category), then runs the existing scoreWallet()
// pipeline -- the same function `npm run wallet-score` uses -- on the top 3
// surviving candidates per category by pnl, so results are vetted the same
// way every other wallet in this project has been judged, not a raw
// address dump.
//
// Read-only research script: prints candidates, adds nothing to wallets.ts
// or the tracking DB. To actually track one, add it to wallets.ts (for
// archetype/source provenance) and run `npm run wallets:add`.
//
// Usage: npm run source-wallets

import "dotenv/config";
import { getActivity, getLeaderboard, type LeaderboardEntry } from "../api/client";
import { isCertainlyDormant, scoreWallet, scoreWalletShallow, scoreWalletWithActivity } from "../scoring/walletScore";
import { TRACKED_WALLETS, type TrackedWallet } from "../wallets";

const CATEGORIES = ["POLITICS", "SPORTS", "ESPORTS", "CRYPTO", "CULTURE", "WEATHER", "ECONOMICS", "TECH", "FINANCE"] as const;
const WINDOWS = ["MONTH", "ALL"] as const;
const LIMIT_PER_SWEEP = 25;
// Raised from 3 to 6 (2026-09-15, Track E.13 broaden pass): the first
// sweep (2026-09-13) only scored each category's top 3 surviving
// candidates, all of which are now in TRACKED_WALLETS (so dedupe()
// already skips them) -- this reuses the SAME already-pulled leaderboard
// data to score ranks 4-6 too, no extra leaderboard API calls, just more
// scoreWallet() calls (the expensive part). Not raised further: each
// sweep's per-wallet score cost is real rate-limited API time (~90 min for
// 27 wallets last time), and the first sweep's 26/27 vetoed rate (mostly
// dormant) sets a realistic expectation for this one too.
const TOP_N_PER_CATEGORY = 6;

type Category = (typeof CATEGORIES)[number];
type Window = (typeof WINDOWS)[number];

interface Candidate {
  entry: LeaderboardEntry;
  category: Category;
  window: Window;
  categoriesSeenIn: Set<Category>;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function sweep(): Promise<{ entry: LeaderboardEntry; category: Category; window: Window }[]> {
  const all: { entry: LeaderboardEntry; category: Category; window: Window }[] = [];
  for (const category of CATEGORIES) {
    for (const window of WINDOWS) {
      const entries = await getLeaderboard(category, window, "PNL", { limit: LIMIT_PER_SWEEP });
      for (const entry of entries) all.push({ entry, category, window });
    }
  }
  return all;
}

// Drops anything already in TRACKED_WALLETS, then collapses duplicate
// sightings of the same wallet across categories/windows into one Candidate
// -- keeping its highest-pnl sighting, but remembering every category it
// appeared under (a wallet ranking under several specialist categories
// rather than just one is itself a useful signal).
function dedupe(swept: { entry: LeaderboardEntry; category: Category; window: Window }[]): Map<string, Candidate> {
  const tracked = new Set(TRACKED_WALLETS.map((w) => w.address.toLowerCase()));
  const byAddress = new Map<string, Candidate>();
  for (const s of swept) {
    const addr = s.entry.proxyWallet.toLowerCase();
    if (tracked.has(addr)) continue;
    const existing = byAddress.get(addr);
    if (!existing) {
      byAddress.set(addr, { ...s, categoriesSeenIn: new Set([s.category]) });
    } else {
      existing.categoriesSeenIn.add(s.category);
      if (s.entry.pnl > existing.entry.pnl) {
        existing.entry = s.entry;
        existing.category = s.category;
        existing.window = s.window;
      }
    }
  }
  return byAddress;
}

function shortlist(deduped: Map<string, Candidate>): Candidate[] {
  const byCategory = new Map<Category, Candidate[]>();
  for (const c of deduped.values()) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }
  const selected: Candidate[] = [];
  for (const list of byCategory.values()) {
    list.sort((a, b) => b.entry.pnl - a.entry.pnl);
    selected.push(...list.slice(0, TOP_N_PER_CATEGORY));
  }
  return selected;
}

async function main() {
  console.log(`Sweeping ${CATEGORIES.length} categories x ${WINDOWS.length} windows (PNL-ordered, top ${LIMIT_PER_SWEEP} each)...`);
  const swept = await sweep();
  console.log(`${swept.length} raw leaderboard entries pulled.`);

  const deduped = dedupe(swept);
  console.log(`${deduped.size} distinct wallets not already in TRACKED_WALLETS.`);

  const candidates = shortlist(deduped);
  console.log(`Scoring top ${TOP_N_PER_CATEGORY} per category (${candidates.length} candidates)...\n`);

  const results: {
    candidate: Candidate;
    score: Awaited<ReturnType<typeof scoreWallet>> | null;
    error?: string;
    skippedDormant?: boolean;
    shallow?: boolean;
  }[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const wallet: TrackedWallet = {
      address: candidate.entry.proxyWallet,
      label: `${candidate.entry.userName ?? candidate.entry.proxyWallet} (${candidate.category} ${candidate.window} leaderboard #${candidate.entry.rank}, pnl=$${candidate.entry.pnl.toFixed(0)})`,
      archetype: "unclassified",
      source: `https://polymarket.com/leaderboard/${candidate.category.toLowerCase()}/${candidate.window.toLowerCase()}/profit`,
    };
    try {
      // Cheap dormancy pre-check (1 call, newest-first) before the expensive
      // full-history scoreWallet() pull (~3 min each). Added 2026-09-22 after
      // the broaden pass's first 10/10 scored candidates came back vetoed,
      // overwhelmingly on `dormant` -- each of those cost a full pull to
      // learn something one call proves. Exact, not heuristic: see
      // isCertainlyDormant. Skipped wallets are reported, not silently
      // dropped, and count toward the vetoed total.
      const latest = await getActivity(wallet.address, { limit: 1 });
      const latestTs = latest.length ? latest[0].timestamp : null;
      if (isCertainlyDormant(latestTs)) {
        results.push({ candidate, score: null, skippedDormant: true });
        console.log(`[${i + 1}/${candidates.length}] ${wallet.label} -> VETOED(dormant) via pre-check, full pull skipped`);
        continue;
      }
      const full = await scoreWalletWithActivity(wallet);
      let score = full.score;
      const activity = full.activity;
      // The full pull pages FORWARD from the oldest activity under a page
      // budget, so a high-volume wallet can cap out before reaching its
      // recent trades and get falsely flagged `dormant` (item 40's sweep hit
      // this on 5 wallets that had just passed the pre-check above). The
      // pre-check's newest timestamp makes the truncation exactly
      // detectable; rescore from a newest-first window instead, marked
      // shallow since that window isn't reproducible (see scoreWalletShallow).
      const pulledLatestTs = activity.length ? Math.max(...activity.map((a) => a.timestamp)) : null;
      let shallow = false;
      if (latestTs !== null && (pulledLatestTs === null || pulledLatestTs < latestTs)) {
        score = (await scoreWalletShallow(wallet)).score;
        shallow = true;
      }
      results.push({ candidate, score, shallow });
      // Printed as each candidate finishes -- scoring 50+ wallets can take
      // hours (each is a real rate-limited full-history pull), and every
      // prior version of this script buffered ALL output until the very
      // end, which meant a killed/timed-out run lost 100% of its progress
      // with nothing to show for it (hit live 2026-09-15 running this
      // exact script under a foreground time limit). This progress line is
      // purely additive -- the final sorted summary below is unchanged.
      console.log(
        `[${i + 1}/${candidates.length}] ${wallet.label} -> qualityScore=${score.qualityScore}${score.flags.length ? ` VETOED(${score.flags.join(",")})` : " clean"}` +
          (shallow ? " [shallow: full pull truncated before recent activity]" : "")
      );
    } catch (err) {
      results.push({ candidate, score: null, error: (err as Error).message });
      console.log(`[${i + 1}/${candidates.length}] ${wallet.label} -> scoring failed: ${(err as Error).message}`);
    }
  }

  results.sort((a, b) => (b.score?.qualityScore ?? -1) - (a.score?.qualityScore ?? -1));

  let scored = 0;
  let vetoed = 0;
  let preVetoed = 0;
  for (const { candidate, score, error, skippedDormant, shallow } of results) {
    const seenIn = [...candidate.categoriesSeenIn].join(", ");
    console.log(`[${candidate.entry.proxyWallet}] ${candidate.entry.userName ?? "(no username)"}`);
    console.log(
      `  seen in: ${seenIn}  best rank: ${candidate.category} ${candidate.window} #${candidate.entry.rank}  vol=$${candidate.entry.vol.toFixed(0)}  pnl=$${candidate.entry.pnl.toFixed(0)}`
    );
    if (skippedDormant) {
      preVetoed++;
      console.log(`  VETOED -- dormant (pre-check: newest activity > 30 days old; full pull skipped)`);
    } else if (error) {
      console.log(`  scoring failed: ${error}`);
    } else if (score) {
      scored++;
      const isVetoed = score.flags.length > 0;
      if (isVetoed) vetoed++;
      console.log(
        `  qualityScore=${score.qualityScore}/100${isVetoed ? `  (VETOED -- ${score.flags.join(", ")})` : ""}` +
          (shallow ? "  [shallow rescore -- full pull truncated; confirm with a deeper historyPages before trusting]" : "")
      );
      console.log(
        `  events=${score.distinctEvents}  winRate=${pct(score.winRate)}  roi=${pct(score.roi)}  netPnl=$${score.netPnl.toFixed(2)}` +
          `  daysSinceLastActivity=${score.daysSinceLastActivity.toFixed(1)}`
      );
    }
    console.log("");
  }

  console.log(
    `Summary: ${swept.length} raw entries -> ${deduped.size} new wallets -> ${candidates.length} shortlisted -> ` +
      `${preVetoed} pre-vetoed dormant, ${scored} fully scored (${scored - vetoed} clean / ${vetoed} vetoed)` +
      `${results.length - scored - preVetoed ? `, ${results.length - scored - preVetoed} scoring errors` : ""}.`
  );
}

if (require.main === module) {
  main();
}
