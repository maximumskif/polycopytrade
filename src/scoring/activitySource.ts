// Track K3 (docs/IMPROVEMENT_PLAN.md Tracks K-O, 2026-09-24): a wallet's
// scoring activity from the tracking daemon's stored wallet_activity rows,
// fetching from /activity only the ranges the DB can't PROVE it holds.
//
// Before this, every scoring run re-pulled a wallet's whole window through
// getActivityFromStart -- uncached by design (/activity is live data), and
// after K1 the dominant cost: a high-volume wallet's anchored 40-page pull
// is ~40 requests at ~1 req/s, repeated on every re-score even though the
// daemon already polls every tracked wallet.
//
// Contract: the returned Activity[] is what getActivityFromStart(address,
// pages, fromTs) would return. Not "the whole window" -- the same page
// budget, the same window re-opens at the API's offset cap, the same
// dedupe key -- because callers' truncation logic (walletConfirmation.ts's
// isTruncated, the wallet_scores `truncated` column) and every score
// recorded so far assume that pull. It's reproduced by REPLAYING the pull
// (replayFromStartPull) over a sorted, provably-complete local copy of the
// rows, so a wallet whose pure-API pull would be truncated still comes back
// truncated at the same point, and one that would reach the present comes
// back identical. The only freedom is the order of rows sharing one
// timestamp, which the API itself doesn't define either.
//
// Completeness comes from wallet_activity_coverage (migration 0006), never
// from the rows alone: the daemon keeps only the newest 200 rows per poll,
// so a busy wallet has silent holes, and the table began at the 2026-09-22
// DB reset. Missing ranges are fetched ASC with the same paging as
// getActivityFromStart, lazily -- one page at a time, only while the
// replay still needs rows it can't prove -- so a warm run costs ~1 request
// (the "anything newer?" page) instead of the whole window.
//
// Persistence: fetched pages of a TRACKED wallet (one with a `wallets`
// row) are inserted into wallet_activity tagged SCORING_GAP_FILL_SOURCE,
// with the range they prove recorded as coverage, so the next run is warm.
// Untracked wallets (sourcing candidates) aren't persisted: wallet_activity
// has a foreign key to `wallets`, and a `wallets` row would enroll the
// wallet in the daemon's polling. Backfilled rows are months-old fills --
// listUncopiedBuyFills ignores that tag so the paper-trading engine never
// copies them (see its comment and insertActivity's re-tag rule).
//
// Known limit, shared with the pure-API pull it replaces: a row the API
// indexes LATE (appearing after a newer row was already served) is missed
// if it lands inside an already-verified range. The pure pull has the same
// exposure at its own fetch time; here it persists until the rows are
// re-fetched. POLYCOPY_SCORE_FROM_DB=0 is the escape hatch.

import { activityKey, getActivity, getActivityFromStart, PolymarketApiError, type Activity } from "../api/client";
import { config } from "../config/env";
import { getDb } from "../storage/db";
import { runMigrations } from "../storage/migrate";
import {
  addActivityCoverage,
  findTrackedWalletAddress,
  insertActivity,
  listActivityCoverage,
  listStoredActivity,
  SCORING_GAP_FILL_SOURCE,
} from "../storage/repository";

// /activity paging, as getActivityFromStart uses it: 500-row pages, and
// offset=5000 is the last one the API accepts (5500 -> 400; see that
// function's docstring).
export const ACTIVITY_PAGE_SIZE = 500;
export const ACTIVITY_MAX_OFFSET = 5000;

// Inclusive unix-second range; toTs may be Infinity ("through the present").
export interface Interval {
  fromTs: number;
  toTs: number;
}

// Sorted, disjoint, with overlapping or adjacent intervals (integer
// seconds: [a,b] and [b+1,c] leave nothing between them) merged. Empty
// intervals (fromTs > toTs) are dropped.
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.fromTs <= i.toTs).sort((a, b) => a.fromTs - b.fromTs);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.fromTs <= last.toTs + 1) last.toTs = Math.max(last.toTs, i.toTs);
    else out.push({ ...i });
  }
  return out;
}

// The last second through which [fromTs, ...] is contiguously covered, or
// fromTs - 1 when fromTs itself isn't covered. Infinity = through the present.
export function coveredThrough(intervals: Interval[], fromTs: number): number {
  for (const i of mergeIntervals(intervals)) if (i.fromTs <= fromTs && fromTs <= i.toTs) return i.toTs;
  return fromTs - 1;
}

// The parts of [fromTs, present] the intervals don't cover, oldest first --
// the ranges the API has to supply (the last one is open-ended unless
// coverage already runs through the present). Informational: the fetch
// loop below works on the first gap only, since the replay consumes rows in
// order and may stop (page budget) before later gaps matter.
export function missingRanges(intervals: Interval[], fromTs: number): Interval[] {
  const gaps: Interval[] = [];
  let cursor = fromTs;
  for (const i of mergeIntervals(intervals)) {
    if (i.toTs < cursor) continue;
    if (i.fromTs > cursor) gaps.push({ fromTs: cursor, toTs: i.fromTs - 1 });
    cursor = i.toTs + 1;
    if (!Number.isFinite(cursor)) return gaps;
  }
  gaps.push({ fromTs: cursor, toTs: Infinity });
  return gaps;
}

export type ReplayResult = { kind: "done"; rows: Activity[]; pagesUsed: number } | { kind: "need-more" };

// getActivityFromStart's exact paging loop, run against `rows` instead of
// the network. `rows` must be sorted by timestamp and hold EVERY row the
// API has for this wallet with timestamp in [fromTs, the prefix's end] --
// all of them when `complete` (verified through the present). Returns
// "need-more" the moment the replay would read past that prefix.
export function replayFromStartPull(rows: Activity[], complete: boolean, fromTs: number, pages: number): ReplayResult {
  const lowerBound = (ts: number): number => {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].timestamp < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const out: Activity[] = [];
  const seen = new Set<string>();
  let startTs = fromTs;
  let pagesUsed = 0;
  while (pagesUsed < pages) {
    const base = lowerBound(startTs);
    let offset = 0;
    let reachedEndOfHistory = false;
    while (pagesUsed < pages) {
      if (offset > ACTIVITY_MAX_OFFSET) break; // the real pull's 400: window re-opens, no page spent
      const batch = rows.slice(base + offset, base + offset + ACTIVITY_PAGE_SIZE);
      if (batch.length < ACTIVITY_PAGE_SIZE && !complete) return { kind: "need-more" };
      pagesUsed++;
      for (const a of batch) {
        const key = activityKey(a);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a);
      }
      if (batch.length < ACTIVITY_PAGE_SIZE) {
        reachedEndOfHistory = true;
        break;
      }
      offset += ACTIVITY_PAGE_SIZE;
    }
    if (reachedEndOfHistory || out.length === 0) break;
    startTs = Math.max(...out.map((a) => a.timestamp));
  }
  return { kind: "done", rows: out, pagesUsed };
}

// wallet_activity's UNIQUE key (0001_init.ts) minus the wallet -- the
// identity for merging stored and freshly-fetched rows. Deliberately NOT
// activityKey (which omits the timestamp): two API rows differing only in
// timestamp are two rows to the API and the DB, and only the replay's own
// dedupe should drop one, exactly as the pure pull would.
function storageKey(a: Activity): string {
  return `${a.transactionHash}:${a.conditionId}:${a.outcome}:${a.side}:${a.size}:${a.price}:${a.timestamp}`;
}

export interface ActivitySourceStats {
  mode: "db" | "api" | "api-fallback";
  tracked: boolean; // persisted (wallet has a `wallets` row)
  storedRows: number; // rows read from wallet_activity for the window
  apiPages: number; // /activity pages fetched to fill gaps
  apiRows: number;
  returnedRows: number;
  replayPages: number; // pages the equivalent pure-API pull would have spent
}

const migratedDbs = new WeakSet<object>();
function ensureSchema(): void {
  const db = getDb();
  if (migratedDbs.has(db)) return;
  runMigrations(db);
  migratedDbs.add(db);
}

let warnedDbUnavailable = false;

// A run's page budget for gap-filling: the replay spends at most `pages`,
// and each gap can waste at most one page reading past its end into
// already-covered rows. Past this something is off (e.g. coverage claims
// the API contradicts) -- fall back to the plain pull rather than loop.
function gapFillBudget(pages: number, gapCount: number): number {
  return pages + gapCount + 10;
}

export async function loadScoringActivity(
  address: string,
  pages = 10,
  fromTs = 1
): Promise<{ activity: Activity[]; stats: ActivitySourceStats }> {
  const stats: ActivitySourceStats = {
    mode: "db",
    tracked: false,
    storedRows: 0,
    apiPages: 0,
    apiRows: 0,
    returnedRows: 0,
    replayPages: 0,
  };
  const pureApi = async (mode: ActivitySourceStats["mode"]) => {
    const activity = await getActivityFromStart(address, pages, fromTs);
    return { activity, stats: { ...stats, mode, returnedRows: activity.length } };
  };
  if (!config.scoreFromDb) return pureApi("api");

  let tracked: string | null;
  try {
    ensureSchema();
    tracked = findTrackedWalletAddress(address);
  } catch (err) {
    // A scoring run must not die because the local DB is unavailable --
    // it's an optimization, the API is the source of truth.
    if (!warnedDbUnavailable) {
      console.warn(`[activity-source] local DB unavailable, scoring from the API: ${(err as Error).message}`);
      warnedDbUnavailable = true;
    }
    return pureApi("api-fallback");
  }
  stats.tracked = tracked !== null;

  const byKey = new Set<string>();
  const known: Activity[] = [];
  const add = (a: Activity) => {
    const k = storageKey(a);
    if (byKey.has(k)) return;
    byKey.add(k);
    known.push(a);
  };
  let intervals: Interval[] = [];
  if (tracked) {
    for (const a of listStoredActivity(tracked, fromTs)) add(a);
    stats.storedRows = known.length;
    intervals = mergeIntervals(listActivityCoverage(tracked));
  }
  const budget = gapFillBudget(pages, missingRanges(intervals, fromTs).length);

  // One contiguous ASC read in progress: every page from offset 0 at
  // `startTs` has been fetched, the newest timestamp seen is `maxTs`.
  let cursor: { startTs: number; offset: number; maxTs: number | null } | null = null;
  for (;;) {
    const through = coveredThrough(intervals, fromTs);
    const prefix = known.filter((a) => a.timestamp >= fromTs && a.timestamp <= through).sort((a, b) => a.timestamp - b.timestamp);
    const replay = replayFromStartPull(prefix, through === Infinity, fromTs, pages);
    if (replay.kind === "done") {
      return { activity: replay.rows, stats: { ...stats, returnedRows: replay.rows.length, replayPages: replay.pagesUsed } };
    }
    if (stats.apiPages >= budget) {
      console.warn(`[activity-source] ${address}: gap-fill exceeded ${budget} pages, falling back to a plain API pull`);
      return pureApi("api-fallback");
    }

    const gapStart = through + 1;
    // Continue the current read only if it's what ends at the gap (its
    // last page proved everything before maxTs); otherwise the gap moved
    // (merged into later coverage) and a fresh read starts there.
    if (!cursor || cursor.maxTs !== gapStart) cursor = { startTs: gapStart, offset: 0, maxTs: null };
    if (cursor.offset > ACTIVITY_MAX_OFFSET) cursor = { startTs: cursor.maxTs!, offset: 0, maxTs: cursor.maxTs };

    let batch: Activity[];
    try {
      batch = await getActivity(address, { limit: ACTIVITY_PAGE_SIZE, offset: cursor.offset, start: cursor.startTs, sortDirection: "ASC" });
    } catch (err) {
      // Offset cap hit earlier than ACTIVITY_MAX_OFFSET predicts: re-open
      // the window at the newest row read, like getActivityFromStart.
      if (err instanceof PolymarketApiError && err.statusCode === 400 && cursor.maxTs !== null && cursor.offset > 0) {
        cursor = { startTs: cursor.maxTs, offset: 0, maxTs: cursor.maxTs };
        continue;
      }
      throw err;
    }
    stats.apiPages++;
    stats.apiRows += batch.length;
    for (const a of batch) add(a);

    const batchMax = batch.length ? Math.max(...batch.map((a) => a.timestamp)) : null;
    // A short page is the end of the wallet's history: everything from
    // startTs on is in hand. A full page proves only up to one second
    // before its newest row (more rows at that timestamp may follow).
    const endOfHistory = batch.length < ACTIVITY_PAGE_SIZE;
    const proven: Interval = { fromTs: cursor.startTs, toTs: endOfHistory ? Infinity : batchMax! - 1 };
    intervals = mergeIntervals([...intervals, proven]);
    if (tracked) {
      insertActivity(tracked, batch, { source: SCORING_GAP_FILL_SOURCE });
      // Persist only through the newest row actually seen, not "the
      // present": the next run re-asks for anything newer.
      const persistTo = endOfHistory ? (batchMax ?? cursor.startTs - 1) : proven.toTs;
      addActivityCoverage(tracked, proven.fromTs, persistTo);
    }
    cursor.offset += ACTIVITY_PAGE_SIZE;
    if (batchMax !== null) cursor.maxTs = Math.max(cursor.maxTs ?? batchMax, batchMax);
  }
}

// Drop-in for getActivityFromStart in scoring (walletScore.ts).
export async function getScoringActivity(address: string, pages = 10, fromTs = 1): Promise<Activity[]> {
  return (await loadScoringActivity(address, pages, fromTs)).activity;
}
