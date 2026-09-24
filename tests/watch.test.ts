// Track M3: watchlist condition evaluation against fake DB rows (in-memory
// SQLite with the real migrations), the fire-once/re-arm rule, --run/--ack
// bookkeeping with a fake launcher, and the rendered output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/storage/migrate";
import { evaluateCondition, type Measurement } from "../src/watch/conditions";
import { decide, type ActionRecord } from "../src/watch/state";
import { ackEntry, evaluateWatchlist, formatResults, runFired, watchSummaryLines, type Launcher } from "../src/watch/check";
import { WATCHLIST, type WatchEntry } from "../src/watch/watchlist";

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";
const C = "0xcccc000000000000000000000000000000000003";
const NOW = Date.parse("2026-10-10T12:00:00Z") / 1000;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  return db;
}

function addWallet(db: DatabaseSync, address: string, label = address) {
  db.prepare(`INSERT INTO wallets (address, label, archetype, created_at, updated_at) VALUES (?, ?, 'x', 0, 0)`).run(address, label);
}

let seq = 0;
function addFill(
  db: DatabaseSync,
  wallet: string,
  o: { cid?: string; eventSlug?: string; slug?: string; title?: string; ts?: number; type?: string } = {}
): number {
  seq++;
  const slug = o.slug ?? `market-${seq}`;
  const payload = JSON.stringify({ eventSlug: o.eventSlug ?? "" });
  const res = db
    .prepare(
      `INSERT INTO wallet_activity (wallet_address, transaction_hash, condition_id, outcome, side, size, usdc_size, price, type, title, slug, timestamp, collected_at, raw_payload)
       VALUES (?, ?, ?, 'Yes', 'BUY', 1, 1, 0.5, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      wallet,
      `0xtx${seq}`,
      o.cid ?? `cid-${seq}`,
      o.type ?? "TRADE",
      o.title ?? "Team A vs. Team B",
      slug,
      o.ts ?? NOW - 86400,
      payload
    );
  return Number(res.lastInsertRowid);
}

function addScore(
  db: DatabaseSync,
  address: string,
  o: { isQuality?: boolean; method?: string; truncated?: boolean; score?: number } = {}
) {
  db.prepare(
    `INSERT INTO wallet_scores (address, scored_at, method, history_pages, truncated, quality_score, flags, distinct_events, win_rate, roi, net_pnl, is_quality, source)
     VALUES (?, 0, ?, 40, ?, ?, '[]', 30, 0.6, 0.1, 100, ?, 'test')`
  ).run(address, o.method ?? "anchored", o.truncated ? 1 : 0, o.score ?? 60, o.isQuality === false ? 0 : 1);
}

function addPaperOrder(db: DatabaseSync, wallet: string, activityId: number, status: string) {
  db.prepare(
    `INSERT INTO paper_orders (wallet_address, source_activity_id, condition_id, outcome, category, leader_price, leader_timestamp, stake_usdc, delay_seconds, status, created_at)
     VALUES (?, ?, 'cid', 'Yes', 'sports', 0.5, 0, 1, 30, ?, 0)`
  ).run(wallet, activityId, status);
}

const ctx = (db: DatabaseSync) => ({ db, now: NOW });

// ---------- condition evaluation ----------

test("leagueEvents: baseline + past-dated league events since the baseline date; futures, other leagues, older and upcoming excluded", () => {
  const db = freshDb();
  addWallet(db, A);
  addWallet(db, B);
  const cond = {
    kind: "leagueEvents" as const,
    wallet: A,
    league: "nfl",
    baselineEvents: 12,
    baselineFromDate: "2026-09-24",
    threshold: 20,
  };
  addFill(db, A, { eventSlug: "nfl-atl-gb-2026-09-25" });
  addFill(db, A, { eventSlug: "nfl-atl-gb-2026-09-25" }); // same event twice
  addFill(db, A, { eventSlug: "nfl-nyg-la-2026-09-22" }); // before baseline date: already in the 12
  addFill(db, A, { eventSlug: "nfl-kc-den-2026-10-12" }); // not played yet
  addFill(db, A, { eventSlug: "nfl-team-to-make-postseason" }); // undated future
  addFill(db, A, { eventSlug: "mlb-nyy-bos-2026-09-30" }); // other league
  addFill(db, A, { slug: "nfl-sf-sea-2026-10-01" }); // no eventSlug: market slug is the key
  addFill(db, A, { eventSlug: "nfl-den-lv-2026-10-02", type: "REDEEM" }); // not a trade
  addFill(db, B, { eventSlug: "nfl-chi-det-2026-10-03" }); // other wallet
  const m = evaluateCondition(cond, ctx(db));
  assert.equal(m.met, false);
  assert.equal(m.value, "~14 events");
  assert.match(m.details[0], /\+ 2 dated NFL.*1 more not yet played.*1 undated/);

  for (let d = 1; d <= 6; d++) addFill(db, A, { eventSlug: `nfl-g${d}-2026-10-0${d + 2}` });
  const fired = evaluateCondition(cond, ctx(db));
  assert.equal(fired.met, true);
  assert.equal(fired.value, "~20 events");
  assert.equal(fired.stateKey, "met");
});

test("leagueEvents: untracked wallet is noted", () => {
  const db = freshDb();
  const m = evaluateCondition(
    { kind: "leagueEvents", wallet: A, league: "nfl", baselineEvents: 0, baselineFromDate: "2026-01-01", threshold: 20 },
    ctx(db)
  );
  assert.equal(m.met, false);
  assert.ok(m.details.some((d) => /not tracked/.test(d)));
});

test("qualityCategoryOverlap: counts markets shared by 2+ confirmed quality wallets, per category, max wins", () => {
  const db = freshDb();
  for (const w of [A, B, C]) addWallet(db, w);
  addScore(db, A);
  addScore(db, B);
  addScore(db, C, { isQuality: false }); // not in pool: its overlap doesn't count
  for (let i = 0; i < 3; i++) {
    addFill(db, A, { cid: `s${i}`, title: "Arsenal vs. Chelsea" });
    addFill(db, B, { cid: `s${i}`, title: "Arsenal vs. Chelsea" });
  }
  addFill(db, A, { cid: "p1", title: "Will the Senate flip?" });
  addFill(db, B, { cid: "p1", title: "Will the Senate flip?" });
  addFill(db, A, { cid: "x1", title: "Arsenal vs. Chelsea" });
  addFill(db, C, { cid: "x1", title: "Arsenal vs. Chelsea" });
  addFill(db, A, { cid: "s0", title: "Arsenal vs. Chelsea" }); // repeat fill, same market
  const cond = { kind: "qualityCategoryOverlap" as const, threshold: 3 };
  const m = evaluateCondition(cond, ctx(db));
  assert.equal(m.value, "3 (sports)");
  assert.equal(m.met, true);
  assert.match(m.details[0], /sports 3, politics 1/);
  assert.match(m.details[1], /2 of 2 quality wallets/);
  assert.equal(evaluateCondition({ ...cond, threshold: 4 }, ctx(db)).met, false);
});

test("qualityCategoryOverlap: pool uses latest CONFIRMED row -- a newer shallow screen doesn't count, a newer failed confirmation does", () => {
  const db = freshDb();
  for (const w of [A, B]) addWallet(db, w);
  addScore(db, A);
  addScore(db, B, { isQuality: false });
  addScore(db, B, { method: "shallow" }); // shallow pass: ignored
  addScore(db, B, { truncated: true }); // truncated pass: ignored
  const m = evaluateCondition({ kind: "qualityCategoryOverlap", threshold: 1 }, ctx(db));
  assert.equal(m.noData, true);
  assert.match(m.details[0], /quality pool has 1 wallet/);
});

test("walletResumed: fires only on a TRADE newer than lastSeenTs", () => {
  const db = freshDb();
  addWallet(db, A);
  const cond = { kind: "walletResumed" as const, wallet: A, lastSeenTs: 1000 };
  addFill(db, A, { ts: 1000 });
  addFill(db, A, { ts: 5000, type: "REDEEM" });
  db.prepare(
    `INSERT INTO wallet_polls (wallet_address, polled_at, outcome, positions_fetched, activity_fetched, activity_inserted) VALUES (?, ?, 'ok', 0, 0, 0)`
  ).run(A, NOW);
  const m = evaluateCondition(cond, ctx(db));
  assert.equal(m.met, false);
  assert.match(m.value, /last trade 1970-01-01 00:16Z/);
  assert.match(m.details[0], /last polled it 2026-10-10 12:00Z/);
  addFill(db, A, { ts: 2000 });
  const fired = evaluateCondition(cond, ctx(db));
  assert.equal(fired.met, true);
  assert.match(fired.details[0], /1 trade\(s\) newer/);
});

test("qualityPoolChanged: stateKey is the member set; empty table is no-data, not 'everyone left'", () => {
  const db = freshDb();
  const cond = { kind: "qualityPoolChanged" as const, baseline: [A.toUpperCase(), B] };
  const empty = evaluateCondition(cond, ctx(db));
  assert.equal(empty.met, false);
  assert.equal(empty.noData, true);

  addWallet(db, A, "alpha (label)");
  addScore(db, A);
  addScore(db, B);
  assert.equal(evaluateCondition(cond, ctx(db)).met, false);

  addScore(db, C);
  addScore(db, B, { isQuality: false, score: 50 });
  const m = evaluateCondition(cond, ctx(db));
  assert.equal(m.met, true);
  assert.equal(m.stateKey, `${A},${C}`);
  assert.match(m.value, /2 wallets: alpha, 0xcccc00\.\.\./);
  assert.ok(m.details.some((d) => d.startsWith("added: ") && d.includes(C)));
  assert.ok(m.details.some((d) => d.startsWith("removed: ") && d.includes(B)));
});

test("paperResolvedEvents: distinct events of resolved orders only", () => {
  const db = freshDb();
  addWallet(db, A);
  addPaperOrder(db, A, addFill(db, A, { eventSlug: "mlb-x-2026-08-01" }), "won");
  addPaperOrder(db, A, addFill(db, A, { eventSlug: "mlb-x-2026-08-01" }), "lost"); // same event, other line
  addPaperOrder(db, A, addFill(db, A, { slug: "wnba-y-2026-08-02" }), "won");
  addPaperOrder(db, A, addFill(db, A, { eventSlug: "mlb-z-2026-08-03" }), "filled"); // open
  const m = evaluateCondition({ kind: "paperResolvedEvents", threshold: 2 }, ctx(db));
  assert.equal(m.value, "2 events");
  assert.equal(m.met, true);
  assert.match(m.details[0], /3 resolved paper order/);
});

test("every seeded entry evaluates without throwing on an empty-schema DB and on a DB with no tables", () => {
  for (const db of [freshDb(), new DatabaseSync(":memory:")]) {
    const { results } = evaluateWatchlist(WATCHLIST, db, NOW, {});
    for (const r of results) {
      assert.equal(r.status, "not-yet", `${r.entry.id}: ${r.error}`);
      assert.ok(r.measurement);
    }
  }
});

test("seeded watchlist: unique ids usable as job names; actions are npm commands", () => {
  const ids = WATCHLIST.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of WATCHLIST) {
    assert.match(e.id, /^[a-z0-9][a-z0-9-]*$/);
    if (e.action) assert.deepEqual(e.action.slice(0, 2), ["npm", "run"]);
    else assert.ok(e.note, `${e.id}: human-review entry needs a note`);
  }
});

// ---------- re-arm rule ----------

const met = (stateKey = "met"): Measurement => ({ met: true, value: "v", threshold: "t", stateKey, details: [] });
const unmet = (noData = false): Measurement => ({
  met: false,
  value: "v",
  threshold: "t",
  stateKey: "",
  details: [],
  ...(noData ? { noData: true } : {}),
});
const rec = (stateKey = "met"): ActionRecord => ({ stateKey, actionedAt: "2026-10-01T00:00:00.000Z", how: "run" });

test("decide: fires once per state, re-arms on a real unmet reading only", () => {
  assert.deepEqual(decide(met(), undefined), { status: "FIRED", rearm: false });
  assert.deepEqual(decide(met(), rec()), { status: "actioned", rearm: false });
  assert.deepEqual(decide(met("a,c"), rec("a,b")), { status: "FIRED", rearm: false }); // new state
  assert.deepEqual(decide(unmet(), rec()), { status: "not-yet", rearm: true });
  assert.deepEqual(decide(unmet(true), rec()), { status: "not-yet", rearm: false }); // no data: keep
  assert.deepEqual(decide(unmet(), undefined), { status: "not-yet", rearm: false });
  assert.deepEqual(decide(null, rec()), { status: "error", rearm: false }); // error: keep
});

function entry(id: string, action?: string[]): WatchEntry {
  return {
    id,
    description: `desc ${id}`,
    planRef: "item 0",
    condition: { kind: "paperResolvedEvents", threshold: 1 },
    action,
    note: `note ${id}`,
  };
}

test("--run lifecycle: fire -> launch+record -> actioned -> unmet re-arms -> fires again", () => {
  const db = freshDb();
  addWallet(db, A);
  const e = entry("paper", ["npm", "run", "paper:report"]);
  const launched: [string, string[]][] = [];
  const launch: Launcher = (name, argv) => {
    launched.push([name, argv]);
    return { ok: true, runDir: "data/runs/x" };
  };

  let records: Record<string, ActionRecord> = {};
  addPaperOrder(db, A, addFill(db, A, { eventSlug: "e1" }), "won");
  let ev = evaluateWatchlist([e], db, NOW, records);
  assert.equal(ev.results[0].status, "FIRED");
  const ran = runFired(ev.results, ev.records, launch, "2026-10-10T12:00:00.000Z");
  assert.deepEqual(launched, [["watch-paper", ["npm", "run", "paper:report"]]]);
  records = ran.records;
  assert.deepEqual(records.paper, { stateKey: "met", actionedAt: "2026-10-10T12:00:00.000Z", how: "run", runDir: "data/runs/x" });

  ev = evaluateWatchlist([e], db, NOW, records);
  assert.equal(ev.results[0].status, "actioned");
  assert.equal(runFired(ev.results, ev.records, launch, "later").lines.length, 0); // no re-launch
  assert.equal(launched.length, 1);

  db.exec(`DELETE FROM paper_orders`);
  ev = evaluateWatchlist([e], db, NOW, records);
  assert.equal(ev.results[0].status, "not-yet");
  assert.deepEqual(ev.records, {}); // re-armed
  records = ev.records;

  addPaperOrder(db, A, addFill(db, A, { eventSlug: "e2" }), "won");
  ev = evaluateWatchlist([e], db, NOW, records);
  assert.equal(ev.results[0].status, "FIRED");
});

test("--run: failed launch records nothing; human-review entries are left FIRED; --ack records them", () => {
  const db = freshDb();
  addWallet(db, A);
  addPaperOrder(db, A, addFill(db, A, { eventSlug: "e1" }), "won");
  const entries = [entry("cmd", ["npm", "run", "x"]), entry("manual")];
  const ev = evaluateWatchlist(entries, db, NOW, {});
  const res = runFired(ev.results, ev.records, () => ({ ok: false, error: "systemd-run missing" }), "t");
  assert.deepEqual(res.records, {});
  assert.match(res.lines[0], /cmd: launch FAILED.*systemd-run missing/);
  assert.match(res.lines[1], /manual: no command.*--ack manual/);

  const acked = ackEntry(ev.results, ev.records, "manual", "t");
  assert.equal(acked.error, undefined);
  assert.equal(acked.records.manual.how, "ack");
  assert.equal(evaluateWatchlist(entries, db, NOW, acked.records).results[1].status, "actioned");
  assert.match(ackEntry(ev.results, ev.records, "nope", "t").error ?? "", /no watch entry/);

  db.exec(`DELETE FROM paper_orders`);
  const ev2 = evaluateWatchlist(entries, db, NOW, {});
  assert.match(ackEntry(ev2.results, ev2.records, "manual", "t").error ?? "", /not-yet, not FIRED/);
});

// ---------- output ----------

test("output: report shows value vs threshold, action only when FIRED; status summary lists only FIRED/error plus a count", () => {
  const db = freshDb();
  addWallet(db, A);
  addPaperOrder(db, A, addFill(db, A, { eventSlug: "e1" }), "won");
  const entries: WatchEntry[] = [
    entry("fired", ["npm", "run", "paper:report", "--", "a b"]),
    { ...entry("waiting", ["npm", "run", "y"]), condition: { kind: "paperResolvedEvents", threshold: 20 } },
    { ...entry("broken", ["npm", "run", "z"]), condition: { kind: "bogus" } as unknown as WatchEntry["condition"] },
  ];
  // an unknown kind returns undefined from the switch -> treat as error
  const { results } = evaluateWatchlist(entries, db, NOW, {});
  const report = formatResults(results).join("\n");
  assert.match(report, /\[FIRED\] fired {2}\(item 0\)\n {4}desc fired\n {4}now: 1 events {3}need: >= 1 events/);
  assert.match(report, /action: npm run job -- watch-fired -- npm run paper:report -- 'a b'/);
  assert.match(report, /note: note fired/);
  assert.match(report, /\[not-yet\] waiting/);
  assert.doesNotMatch(report, /watch-waiting/);
  assert.match(report, /\[ERROR\] broken/);

  const summary = watchSummaryLines(results);
  assert.equal(summary[0], "3 watches: 1 FIRED, 1 error, 0 actioned, 1 not-yet");
  assert.equal(summary.length, 3);
  assert.match(summary[1], /^ {2}FIRED {2}fired: 1 events \(need >= 1 events\) -> npm run job -- watch-fired/);
  assert.match(summary[2], /^ {2}ERROR {2}broken: /);
});
