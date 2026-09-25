// Track M3 (docs/IMPROVEMENT_PLAN.md Tracks K-O): research follow-ups that
// used to be "remember to re-check X once Y" notes buried in the plan, as
// machine-checked entries. `npm run watch:check` evaluates every condition
// (src/watch/check.ts) and prints the action command for any that fired.
//
// Why a typed TS module and not docs/watchlist.json: a condition is not a
// free-form expression, it's one of a handful of evaluators (each a real
// query against the daemon DB, src/watch/conditions.ts) with typed
// parameters. JSON would need its own mini-DSL plus runtime validation to
// catch a misspelled kind or a missing threshold; here `npx tsc` catches
// both, and each entry sits next to comments giving its provenance. Adding
// an entry = appending to WATCHLIST below and committing.
//
// Conditions deliberately read only local data (the tracking daemon's
// wallet_activity / wallet_polls / paper_orders, and wallet_scores), so a
// check costs zero API calls. Where that makes a measure an approximation
// of what the action script would compute from the API, the condition's
// comment says so -- firing means "worth running the real script now",
// the script's own output is the result.

export type WatchCondition =
  // Distinct <league> events (eventKey = eventSlug, else market slug; league
  // = its first dash-separated segment, the same rule sportSegmentation.ts
  // uses) the wallet has traded. `baselineEvents` is what the action script
  // last measured from the API; only events with a trailing YYYY-MM-DD date
  // on/after `baselineFromDate` and already in the past (so the game has
  // plausibly resolved) are added on top from the daemon's wallet_activity.
  | {
      kind: "leagueEvents";
      wallet: string;
      league: string;
      baselineEvents: number;
      baselineFromDate: string; // YYYY-MM-DD, UTC
      threshold: number;
    }
  // Max, over categorize() categories, of distinct markets (condition_id)
  // traded by >= 2 wallets of the current quality pool, from the daemon's
  // wallet_activity. Only covers what the daemon has stored (activity since
  // each wallet started being tracked), so it is a lower bound on the
  // API-derived overlap item 41 measured.
  | { kind: "qualityCategoryOverlap"; threshold: number }
  // The wallet has a TRADE in wallet_activity newer than `lastSeenTs`.
  | { kind: "walletResumed"; wallet: string; lastSeenTs: number }
  // The quality pool (each wallet's latest confirmed wallet_scores row --
  // non-shallow, not truncated -- with is_quality = 1, the same rule as
  // listConfirmedQualityWallets) differs from `baseline`.
  | { kind: "qualityPoolChanged"; baseline: string[] }
  // Distinct events behind resolved (won/lost) paper_orders, via each
  // order's source fill in wallet_activity.
  | { kind: "paperResolvedEvents"; threshold: number; walletAddress?: string };

export interface WatchEntry {
  id: string; // becomes part of a job name (`watch-<id>`): [a-z0-9-]
  description: string;
  planRef: string; // docs/IMPROVEMENT_PLAN.md item(s)
  condition: WatchCondition;
  // argv launched by `watch:check --run` via the L1 job runner. Absent =
  // the follow-up is a human review; `--run` then leaves the entry FIRED
  // and `watch:check --ack <id>` marks it handled.
  action?: string[];
  // What to do beyond / instead of `action`.
  note?: string;
}

const NDB1 = "0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227";
const HIGHTEMPTATION = "0x6011655c4afb76f36dd1b08a137a1ba73466b31e";
const VITO3CORLEONE = "0x34dd4a4b70eaf79a17878f7938263c801d4dfd83";
const PAPER_WALLET_0X1B20A0 = "0x1b20a00709dfe648afd26b326394b5e031f83ab0";

export const WATCHLIST: WatchEntry[] = [
  {
    id: "ndb1-nfl-events",
    description: "ndb1's NFL segment reaches MIN_SAMPLE_SIZE (was +42.0% ROI, CI [12.9%, 70.7%] on only 12 events)",
    planRef: "item 45",
    // 12 = item 45's `sport-segmentation -- ndb1` run on 2026-09-24 (log:
    // data/segment-ndb1.log). A game dated 2026-09-24 had not resolved at
    // that run (10:41 EDT), so new events count from that date on.
    condition: { kind: "leagueEvents", wallet: NDB1, league: "nfl", baselineEvents: 12, baselineFromDate: "2026-09-24", threshold: 20 },
    action: ["npm", "run", "sport-segmentation", "--", "ndb1"],
    note: "Estimate only; the script's NFL distinctEvents is the real count. If NFL's CI still clears zero at >= 20 events, pre-register (npm run prereg) before acting on it.",
  },
  {
    id: "quality-overlap",
    description: "Quality wallets in ONE category overlap on >= 20 distinct markets (G.19 consensus/divergence precondition)",
    planRef: "G.19 items 1-2, items 41-42",
    condition: { kind: "qualityCategoryOverlap", threshold: 20 },
    action: ["npm", "run", "smart-money-divergence"],
    note:
      "G.19 item 2 is smart-money-divergence. Item 1 (consensus restricted to quality wallets) has no script yet -- " +
      "consensus-signal tests the full tracked pool; build the quality-restricted variant then.",
  },
  {
    id: "0x1b20a0-resumed",
    description: "0x1b20a0... (the only paper-traded wallet) trades again after going quiet on 2026-08-10",
    planRef: "items 12, 14, 41",
    // Its newest TRADE in the daemon DB as of 2026-09-24: 2026-08-10T00:21Z
    // (later rows are REDEEM / rebates, which don't count as trading).
    condition: { kind: "walletResumed", wallet: PAPER_WALLET_0X1B20A0, lastSeenTs: 1786321311 },
    action: ["npm", "run", "ou-over-under-split"],
    note: "Per item 14 also re-run `npm run sport-segmentation` (default wallet) once new trades resolve (WNBA had 4 events, O/U Over 7).",
  },
  {
    id: "quality-pool-changed",
    description: "Confirmed quality pool (latest confirmed wallet_scores row passes isQualityWallet) changes membership",
    planRef: "items 45, 49",
    // The pool seeded by `seed-quality-pool` on 2026-09-24 (item 49).
    condition: { kind: "qualityPoolChanged", baseline: [NDB1, HIGHTEMPTATION, VITO3CORLEONE] },
    note:
      "Human review: for each added wallet, vet paper-trading candidacy the way item 45 did ndb1 -- " +
      "`npm run follower-delay-demo -- <wallet> 30` and `npm run sport-segmentation -- <wallet>` (both cost API calls). " +
      "Then `npm run watch:check -- --ack quality-pool-changed`.",
  },
  {
    id: "paper-resolved-events",
    description: "Paper trading has resolved orders on >= 20 distinct events (paper:report stops warning 'too few')",
    planRef: "item 12",
    condition: { kind: "paperResolvedEvents", threshold: 20 },
    action: ["npm", "run", "paper:report"],
    note: "paper:report counts distinct markets; this counts distinct events, the stricter unit.",
  },
  {
    id: "lamyk-forward-test",
    description: "lamyk's pre-registered forward paper test reaches its evaluation point (>= 20 resolved events)",
    planRef: "item 64",
    condition: { kind: "paperResolvedEvents", threshold: 20, walletAddress: "0xc004b035b67be284e0d1db56c39e865df6cac095" },
    action: ["npm", "run", "paper:report"],
    note: "Evaluate against item 64's rule exactly: PASS = paper net ROI > 0 AND event-clustered 95% CI lower bound > -10%; else stop paper-trading lamyk.",
  },
  {
    id: "gkeqd-forward-test",
    description: "gkeqd's pre-registered forward paper test reaches its evaluation point (>= 20 resolved events)",
    planRef: "item 66",
    condition: { kind: "paperResolvedEvents", threshold: 20, walletAddress: "0xdf17f4a8dd01a4cfa6fc3da323a2baee5f8697d1" },
    action: ["npm", "run", "paper:report"],
    note: "Same rule as item 64 (ROI > 0 AND CI lower > -10%); one of 3 parallel forward tests -- see item 66 on reading a single pass.",
  },
  {
    id: "bidifakepolls-forward-test",
    description: "BiDiFakePolls's pre-registered forward paper test reaches its evaluation point (>= 20 resolved events)",
    planRef: "item 66",
    condition: { kind: "paperResolvedEvents", threshold: 20, walletAddress: "0xd24b95551eb288ff82bb625dcd7f32f62abdef76" },
    action: ["npm", "run", "paper:report"],
    note: "Same rule as item 64 (ROI > 0 AND CI lower > -10%); one of 3 parallel forward tests -- see item 66 on reading a single pass.",
  },
];
