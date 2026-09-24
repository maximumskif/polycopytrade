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
// Research script: prints candidates and adds nothing to wallets.ts or the
// tracking daemon's tables. Since Track M1/M2 (2026-09-24) every score is
// recorded in `wallet_scores`, shallow passes are auto-confirmed from a
// pinned anchor (walletConfirmation.ts), and a ready-to-paste wallets.ts
// entry is printed for each confirmed quality wallet. To actually track
// one, paste it into wallets.ts and run `npm run wallets:add`.
//
// Usage: npm run source-wallets

import "dotenv/config";
import { getActivity, getLeaderboard, type LeaderboardEntry } from "../api/client";
import { isCertainlyDormant, scoreWalletShallow, scoreWalletWithActivity } from "../scoring/walletScore";
import { runMigrations } from "../storage/migrate";
import { recentlyConfirmedAddresses, RESCORE_AFTER_DAYS } from "./recentlyScored";
import { TRACKED_WALLETS, type TrackedWallet } from "../wallets";
import {
  isTruncated,
  newestTimestamp,
  printVerdicts,
  recordAttempt,
  screenAndConfirm,
  type PipelineOutcome,
  type ScoringAttempt,
} from "./walletConfirmation";

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
const SHALLOW_HISTORY_PAGES = 4; // scoreWalletShallow's default, named so it's recorded accurately
const SOURCE = "source-wallets";

type Category = (typeof CATEGORIES)[number];
type Window = (typeof WINDOWS)[number];

interface Candidate {
  entry: LeaderboardEntry;
  category: Category;
  window: Window;
  categoriesSeenIn: Set<Category>;
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
function dedupe(skipRecent: Set<string>, swept: { entry: LeaderboardEntry; category: Category; window: Window }[]): Map<string, Candidate> {
  const tracked = new Set(TRACKED_WALLETS.map((w) => w.address.toLowerCase()));
  for (const addr of skipRecent) tracked.add(addr);
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
  runMigrations();
  console.log(`Sweeping ${CATEGORIES.length} categories x ${WINDOWS.length} windows (PNL-ordered, top ${LIMIT_PER_SWEEP} each)...`);
  const swept = await sweep();
  console.log(`${swept.length} raw leaderboard entries pulled.`);

  const skipRecent = recentlyConfirmedAddresses();
  const deduped = dedupe(skipRecent, swept);
  console.log(
    `${deduped.size} distinct wallets not already in TRACKED_WALLETS or confirmed-scored in the last ${RESCORE_AFTER_DAYS} days ` +
      `(${skipRecent.size} recently confirmed; --rescore to include them).`
  );

  const candidates = shortlist(deduped);
  console.log(`Scoring top ${TOP_N_PER_CATEGORY} per category (${candidates.length} candidates)...\n`);

  const outcomes: PipelineOutcome[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const wallet: TrackedWallet = {
      address: candidate.entry.proxyWallet,
      label: `${candidate.entry.userName ?? candidate.entry.proxyWallet} (${candidate.category} ${candidate.window} leaderboard #${candidate.entry.rank}, pnl=$${candidate.entry.pnl.toFixed(0)})`,
      archetype: "unclassified",
      source: `https://polymarket.com/leaderboard/${candidate.category.toLowerCase()}/${candidate.window.toLowerCase()}/profit`,
    };
    const base = { address: wallet.address, label: wallet.label, provenance: wallet.source };
    try {
      // Cheap dormancy pre-check (1 call, newest-first) before the expensive
      // full-history scoreWallet() pull (~3 min each). Added 2026-09-22 after
      // the broaden pass's first 10/10 scored candidates came back vetoed,
      // overwhelmingly on `dormant` -- each of those cost a full pull to
      // learn something one call proves. Exact, not heuristic: see
      // isCertainlyDormant. Skipped wallets are reported (screened out), not
      // silently dropped, and not recorded in wallet_scores (no score exists).
      const latest = await getActivity(wallet.address, { limit: 1 });
      const latestTs = latest.length ? latest[0].timestamp : null;
      if (isCertainlyDormant(latestTs)) {
        outcomes.push({ ...base, kind: "screened-out", reason: "dormant (pre-check: newest activity > 30 days old; full pull skipped)" });
        console.log(`[${i + 1}/${candidates.length}] ${wallet.label} -> VETOED(dormant) via pre-check, full pull skipped`);
        continue;
      }
      const historyPages = wallet.historyPages ?? 10;
      const full = await scoreWalletWithActivity(wallet);
      // The full pull pages FORWARD from the oldest activity under a page
      // budget, so a high-volume wallet can cap out before reaching its
      // recent trades and get falsely flagged `dormant` (item 40's sweep hit
      // this on 5 wallets that had just passed the pre-check above). The
      // pre-check's newest timestamp makes the truncation exactly
      // detectable; rescore from a newest-first window instead, marked
      // shallow since that window isn't reproducible (see scoreWalletShallow).
      // The truncated full pull is still recorded (truncated=1) as provenance.
      const fullAttempt: ScoringAttempt = {
        method: "full",
        historyStart: null,
        historyPages,
        truncated: isTruncated(latestTs, newestTimestamp(full.activity)),
        fills: full.activity.length,
        score: full.score,
      };
      let screen = fullAttempt;
      if (fullAttempt.truncated) {
        recordAttempt(fullAttempt, { source: SOURCE, label: wallet.label });
        const shallow = await scoreWalletShallow(wallet, SHALLOW_HISTORY_PAGES);
        screen = {
          method: "shallow",
          historyStart: null,
          historyPages: SHALLOW_HISTORY_PAGES,
          truncated: false,
          fills: shallow.activity.length,
          score: shallow.score,
        };
      }
      // Printed as each candidate finishes -- scoring 50+ wallets can take
      // hours (each is a real rate-limited full-history pull), and every
      // prior version of this script buffered ALL output until the very
      // end, which meant a killed/timed-out run lost 100% of its progress
      // with nothing to show for it (hit live 2026-09-15 running this
      // exact script under a foreground time limit).
      console.log(
        `[${i + 1}/${candidates.length}] ${wallet.label} -> qualityScore=${screen.score.qualityScore}` +
          `${screen.score.flags.length ? ` VETOED(${screen.score.flags.join(",")})` : " clean"}` +
          (screen.method === "shallow" ? " [shallow: full pull truncated before recent activity]" : "")
      );
      // Track M1 (2026-09-24): a shallow pass is auto-confirmed from a
      // pinned anchor here, instead of by a later hand-run confirm-shallow.
      const outcome = await screenAndConfirm(base, screen, { source: SOURCE });
      outcomes.push(outcome);
      if (outcome.kind !== "screened-out") console.log(`    -> ${outcome.kind}${outcome.reason ? `: ${outcome.reason}` : ""}`);
    } catch (err) {
      outcomes.push({ ...base, kind: "error", reason: (err as Error).message });
      console.log(`[${i + 1}/${candidates.length}] ${wallet.label} -> scoring failed: ${(err as Error).message}`);
    }
  }

  printVerdicts(outcomes);

  const count = (kind: PipelineOutcome["kind"]) => outcomes.filter((o) => o.kind === kind).length;
  console.log(
    `\nSummary: ${swept.length} raw entries -> ${deduped.size} new wallets -> ${candidates.length} shortlisted -> ` +
      `${count("confirmed-quality")} confirmed quality / ${count("failed-confirmation")} failed confirmation / ` +
      `${count("unconfirmed-truncated")} unconfirmed (truncated) / ${count("screened-out")} screened out` +
      `${count("error") ? ` / ${count("error")} scoring errors` : ""}.`
  );
}

if (require.main === module) {
  main();
}
