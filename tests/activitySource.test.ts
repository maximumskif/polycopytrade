// Track K3 (2026-09-24): scoring activity from stored wallet_activity with
// API gap-filling (src/scoring/activitySource.ts). The central property is
// equivalence -- for any DB state (empty, cold, warm, daemon-only coverage,
// daemon coverage with a hole) the source returns what a pure
// getActivityFromStart pull of the same (fromTs, pages) returns -- checked
// against a fake /activity that implements the real paging rules (start
// inclusive, ASC/DESC, 400 past offset 5000). Plus the gap arithmetic, the
// daemon's poll coverage, and the paper-trading guard. In-memory SQLite,
// no network.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __setDbForTests, __resetDbForTests } from "../src/storage/db";
import { runMigrations } from "../src/storage/migrate";
import {
  __setFetchImplForTests,
  __resetFetchImplForTests,
  __setSlotReserverForTests,
  getActivity,
  getActivityFromStart,
  type Activity,
} from "../src/api/client";
import { config } from "../src/config/env";
import {
  addActivityCoverage,
  insertActivity,
  listActivityCoverage,
  listUncopiedBuyFills,
  upsertWallet,
  SCORING_GAP_FILL_SOURCE,
} from "../src/storage/repository";
import { coveredThrough, loadScoringActivity, mergeIntervals, missingRanges, replayFromStartPull } from "../src/scoring/activitySource";
import { pollCoverage, pollWallet } from "../src/tracking/pollWallet";
import type { TrackedWallet } from "../src/wallets";

const WALLET = "0xAbC0000000000000000000000000000000000001";
const tracked: TrackedWallet = { address: WALLET.toLowerCase(), label: "k3 test", archetype: "unclassified", source: "test" };

let db: DatabaseSync;
const originalScoreFromDb = config.scoreFromDb;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  __setDbForTests(db);
  runMigrations(db);
  // No 1.1s gap between fake calls -- these tests make hundreds.
  __setSlotReserverForTests({ reserve: () => Date.now() });
  config.scoreFromDb = true;
});

afterEach(() => {
  db.close();
  __resetDbForTests();
  __resetFetchImplForTests();
  __setSlotReserverForTests(undefined);
  config.scoreFromDb = originalScoreFromDb;
});

// ---------------------------------------------------------------------
// Synthetic wallet history + a fake /activity with the real paging rules
// ---------------------------------------------------------------------

// Deterministic: timestamps advance 0-2s per row (so plenty of rows share a
// timestamp, including across page boundaries), and every 97th row repeats
// an earlier row's activityKey at a later timestamp (the case where the
// pure pull's dedupe drops a row the DB keeps).
function makeHistory(n: number, t0 = 1_000_000): Activity[] {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const rows: Activity[] = [];
  let ts = t0;
  for (let i = 0; i < n; i++) {
    ts += Math.floor(rand() * 3);
    const dupOf = i % 97 === 96 ? rows[i - 50] : null;
    rows.push({
      timestamp: ts,
      conditionId: dupOf?.conditionId ?? `c${i % 13}`,
      type: i % 11 === 0 ? "REDEEM" : "TRADE",
      size: dupOf?.size ?? 10 + (i % 7),
      usdcSize: 5,
      price: dupOf?.price ?? 0.4 + (i % 5) / 10,
      side: dupOf?.side ?? (i % 3 === 0 ? "SELL" : "BUY"),
      outcome: dupOf?.outcome ?? (i % 2 ? "Yes" : "No"),
      title: `Market ${i % 13}`,
      slug: `m${i % 13}`,
      eventSlug: `e${i % 5}`,
      proxyWallet: WALLET.toLowerCase(),
      transactionHash: dupOf?.transactionHash ?? `tx-${i}`,
    });
  }
  return rows;
}

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 400 ? "Bad Request" : "OK",
    json: async () => body,
  } as unknown as Response;
}

// Serves `history` as of `api.now` (rows with timestamp <= now exist).
function fakeApi(history: Activity[]) {
  const api = { now: Infinity, calls: 0 };
  __setFetchImplForTests(async (input) => {
    const url = new URL(String(input));
    api.calls++;
    const start = Number(url.searchParams.get("start") ?? 1);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 500);
    if (offset > 5000) return response(400, { error: "offset too large" });
    let rows = history.filter((a) => a.timestamp >= start && a.timestamp <= api.now);
    if (url.searchParams.get("sortDirection") !== "ASC") rows = [...rows].reverse();
    return response(200, rows.slice(offset, offset + limit));
  });
  return api;
}

const key = (a: Activity) => `${a.transactionHash}:${a.conditionId}:${a.outcome}:${a.side}:${a.size}:${a.price}:${a.timestamp}`;
const newest = (rows: Activity[]) => rows.reduce((m, a) => Math.max(m, a.timestamp), -Infinity);

// The equivalence claim. Untruncated (the pull reached the wallet's newest
// row): the same rows, exactly. Truncated: the same row count and the same
// newest timestamp (so isTruncated() gives the same verdict), and the same
// rows below that last timestamp -- the only freedom is WHICH rows sharing
// the final page's boundary timestamp made it in, which is the API's
// unspecified tie order.
function assertEquivalent(actual: Activity[], expected: Activity[], history: Activity[], what: string) {
  assert.equal(actual.length, expected.length, `${what}: row count`);
  const end = newest(expected);
  assert.equal(newest(actual), end, `${what}: newest timestamp`);
  const truncated = end < newest(history);
  const below = (rows: Activity[]) =>
    rows
      .filter((a) => !truncated || a.timestamp < end)
      .map(key)
      .sort();
  assert.deepEqual(below(actual), below(expected), `${what}: rows`);
}

// Stands in for the tracking daemon: one pollWallet() against the fake API.
async function daemonPoll(api: { now: number }, now: number) {
  api.now = now;
  const result = await pollWallet({ address: tracked.address, label: tracked.label });
  assert.equal(result.outcome, "ok");
}

// ---------------------------------------------------------------------
// Gap arithmetic
// ---------------------------------------------------------------------

test("mergeIntervals merges overlapping and adjacent integer-second ranges and drops empty ones", () => {
  assert.deepEqual(
    mergeIntervals([
      { fromTs: 50, toTs: 60 },
      { fromTs: 10, toTs: 20 },
      { fromTs: 21, toTs: 30 }, // adjacent -> merges
      { fromTs: 55, toTs: 70 }, // overlapping -> merges
      { fromTs: 90, toTs: 89 }, // empty
    ]),
    [
      { fromTs: 10, toTs: 30 },
      { fromTs: 50, toTs: 70 },
    ]
  );
});

test("coveredThrough / missingRanges: backfill below coverage, the hole, and the open-ended top", () => {
  const cov = [
    { fromTs: 100, toTs: 200 },
    { fromTs: 300, toTs: 400 },
  ];
  assert.equal(coveredThrough(cov, 150), 200);
  assert.equal(coveredThrough(cov, 50), 49, "uncovered start -> nothing proven");
  assert.deepEqual(missingRanges(cov, 50), [
    { fromTs: 50, toTs: 99 },
    { fromTs: 201, toTs: 299 },
    { fromTs: 401, toTs: Infinity },
  ]);
  assert.deepEqual(missingRanges(cov, 150), [
    { fromTs: 201, toTs: 299 },
    { fromTs: 401, toTs: Infinity },
  ]);
  assert.deepEqual(missingRanges([{ fromTs: 0, toTs: Infinity }], 150), []);
});

test("pollCoverage: a full DESC batch proves (oldest, newest]; a short one is the whole history", () => {
  const rows = (tss: number[]) => tss.map((timestamp) => ({ timestamp }));
  assert.deepEqual(pollCoverage(rows([30, 20, 10]), 3), { fromTs: 11, toTs: 30 });
  assert.deepEqual(pollCoverage(rows([30, 20]), 3), { fromTs: 0, toTs: 30 });
  assert.equal(pollCoverage([], 3), null);
});

test("addActivityCoverage merges with stored intervals it touches", () => {
  upsertWallet(tracked);
  addActivityCoverage(tracked.address, 100, 200);
  addActivityCoverage(tracked.address, 300, 400);
  addActivityCoverage(tracked.address, 201, 299); // bridges both
  addActivityCoverage(tracked.address, 500, 499); // empty: no-op
  assert.deepEqual(listActivityCoverage(tracked.address), [{ fromTs: 100, toTs: 400 }]);
});

test("replayFromStartPull matches getActivityFromStart on the complete history, incl. offset-cap re-opens and truncation", async () => {
  const history = makeHistory(7000);
  fakeApi(history);
  for (const pages of [1, 3, 11, 12, 40]) {
    for (const fromTs of [1, history[2500].timestamp]) {
      const expected = await getActivityFromStart(WALLET, pages, fromTs);
      const replay = replayFromStartPull(
        history.filter((a) => a.timestamp >= fromTs),
        true,
        fromTs,
        pages
      );
      assert.equal(replay.kind, "done");
      if (replay.kind === "done") assertEquivalent(replay.rows, expected, history, `pages=${pages} fromTs=${fromTs}`);
    }
  }
});

test("replayFromStartPull asks for more rather than read past an incomplete prefix", () => {
  const history = makeHistory(600);
  assert.equal(replayFromStartPull(history.slice(0, 300), false, 1, 5).kind, "need-more");
  // ...but a page budget that ends inside the prefix needs nothing more.
  const r = replayFromStartPull(history.slice(0, 550), false, 1, 1);
  assert.equal(r.kind, "done");
});

// ---------------------------------------------------------------------
// Equivalence across DB states
// ---------------------------------------------------------------------

const CASES: { pages: number; fromIdx: number | null }[] = [
  { pages: 40, fromIdx: null }, // full history, reaches the present
  { pages: 40, fromIdx: 3000 }, // anchored, reaches the present
  { pages: 4, fromIdx: 1000 }, // anchored, truncated
  { pages: 12, fromIdx: null }, // crosses the offset cap, truncated
];

async function checkAllCases(history: Activity[], label: string) {
  for (const c of CASES) {
    const fromTs = c.fromIdx === null ? 1 : history[c.fromIdx].timestamp;
    config.scoreFromDb = false;
    const expected = await getActivityFromStart(WALLET, c.pages, fromTs);
    config.scoreFromDb = true;
    const { activity } = await loadScoringActivity(WALLET, c.pages, fromTs);
    assertEquivalent(activity, expected, history, `${label} pages=${c.pages} from=${c.fromIdx}`);
  }
}

test("untracked wallet: identical to the pure pull, nothing persisted", async () => {
  const history = makeHistory(7000);
  fakeApi(history);
  await checkAllCases(history, "untracked");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM wallet_activity`).get() as { n: number }).n, 0);
});

test("tracked wallet, cold then warm: identical both times, and the warm run fetches ~nothing", async () => {
  const history = makeHistory(7000);
  const api = fakeApi(history);
  upsertWallet(tracked);
  await checkAllCases(history, "cold");
  await checkAllCases(history, "warm");

  const fromTs = history[3000].timestamp;
  config.scoreFromDb = false;
  api.calls = 0;
  await getActivityFromStart(WALLET, 40, fromTs);
  const pureCalls = api.calls;
  config.scoreFromDb = true;
  api.calls = 0;
  const { stats } = await loadScoringActivity(WALLET, 40, fromTs);
  assert.equal(api.calls, 1, `warm run: one "anything newer?" page (pure pull took ${pureCalls})`);
  assert.equal(stats.apiPages, 1);
  assert.ok(pureCalls >= 8);
});

test("daemon coverage + new activity since: fills the backfill and the newer rows only, still identical", async () => {
  const history = makeHistory(7000);
  const api = fakeApi(history);
  upsertWallet(tracked);
  // Daemon polled when the wallet's newest row was row 6000, then again a
  // few rows later (overlapping batches -> one interval).
  await daemonPoll(api, history[6000].timestamp);
  await daemonPoll(api, history[6100].timestamp);
  assert.equal(listActivityCoverage(tracked.address).length, 1);
  api.now = Infinity; // the wallet traded on after the daemon's last poll
  await checkAllCases(history, "daemon");
});

test("daemon coverage with a hole (wallet out-traded one poll's 200-row limit): the hole is fetched, result identical", async () => {
  const history = makeHistory(7000);
  const api = fakeApi(history);
  upsertWallet(tracked);
  await daemonPoll(api, history[5000].timestamp);
  await daemonPoll(api, history[5600].timestamp); // 600 rows later: no overlap with the last batch
  assert.equal(listActivityCoverage(tracked.address).length, 2, "two disjoint intervals, the hole unclaimed");
  api.now = Infinity;
  await checkAllCases(history, "hole");
});

test("POLYCOPY_SCORE_FROM_DB=0: pure API pull, DB untouched", async () => {
  const history = makeHistory(800);
  fakeApi(history);
  upsertWallet(tracked);
  config.scoreFromDb = false;
  const { activity, stats } = await loadScoringActivity(WALLET, 10, 1);
  assert.equal(stats.mode, "api");
  assert.equal(activity.length, (await getActivityFromStart(WALLET, 10, 1)).length);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM wallet_activity`).get() as { n: number }).n, 0);
});

// ---------------------------------------------------------------------
// Paper-trading guard
// ---------------------------------------------------------------------

test("scorer-backfilled fills are never paper-copied; the daemon seeing a fill makes it copyable again", async () => {
  const history = makeHistory(700);
  const api = fakeApi(history);
  upsertWallet(tracked);
  await loadScoringActivity(WALLET, 10, 1); // backfills all 700 rows
  const stored = db.prepare(`SELECT COUNT(*) AS n FROM wallet_activity WHERE source = ?`).get(SCORING_GAP_FILL_SOURCE) as { n: number };
  assert.equal(stored.n, 700);
  assert.equal(listUncopiedBuyFills(tracked.address).length, 0, "old backfilled fills must not become paper orders");

  // The daemon's live poll returns the newest 200 -- rows it would have
  // inserted itself before K3 existed. Those (and only those) become
  // copyable, and count as newly inserted for the daemon.
  await daemonPoll(api, Infinity);
  const newest200 = [...history].reverse().slice(0, 200);
  const expectedBuys = new Set(newest200.filter((a) => a.type === "TRADE" && a.side === "BUY").map(key));
  const copyable = listUncopiedBuyFills(tracked.address);
  assert.equal(copyable.length, expectedBuys.size);
  const poll = db.prepare(`SELECT activity_inserted AS n FROM wallet_polls ORDER BY id DESC LIMIT 1`).get() as { n: number };
  assert.equal(poll.n, 200);
});

test("insertActivity never downgrades a daemon row to the gap-fill tag", async () => {
  upsertWallet(tracked);
  const [row] = makeHistory(1);
  assert.equal(insertActivity(tracked.address, [row]), 1);
  assert.equal(insertActivity(tracked.address, [row], { source: SCORING_GAP_FILL_SOURCE }), 0);
  const r = db.prepare(`SELECT source FROM wallet_activity`).get() as { source: string };
  assert.equal(r.source, "polymarket-data-api");
  // sanity: getActivity is the daemon's call shape (DESC, newest first)
  fakeApi(makeHistory(3));
  assert.equal((await getActivity(WALLET, { limit: 1 })).length, 1);
});
