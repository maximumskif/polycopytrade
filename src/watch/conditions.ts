// Track M3: evaluators for src/watch/watchlist.ts conditions. Each one is a
// read-only query against the tracking daemon's SQLite DB -- zero API
// calls -- and returns what it measured, the threshold it compared to, and
// a `stateKey` that identifies the fired state for the re-arm rule in
// src/watch/state.ts (same key = same state = don't fire again).
//
// The queries live here rather than in src/storage/repository.ts on
// purpose (file ownership during parallel work, docs/AGENTS.md); they only
// read tables other code writes.
//
// Missing data is not an error: a fresh DB (e.g. a worktree's own) has no
// rows, or even no tables, and every evaluator then reports "not yet" with
// a note saying why, instead of throwing.

import type { DatabaseSync } from "node:sqlite";
import { categorize } from "../research/categorize";
import type { WatchCondition } from "./watchlist";

export interface Measurement {
  met: boolean;
  value: string; // current measured value, human-readable
  threshold: string; // what `value` is compared to
  stateKey: string;
  details: string[]; // extra lines (breakdowns, caveats, missing-data notes)
  // Set when the DB lacks what the condition reads (fresh DB, empty table):
  // "not yet", but also no evidence the condition went false (no re-arm).
  noData?: true;
}

export interface EvalContext {
  db: DatabaseSync;
  now: number; // unix seconds
}

// SQL expression for a fill's eventKey, matching src/backtesting/engine.ts's
// eventKeyFor(): the eventSlug when present, else the market slug.
const EVENT_KEY_SQL = `COALESCE(NULLIF(json_extract(a.raw_payload, '$.eventSlug'), ''), a.slug)`;

function hasTables(db: DatabaseSync, tables: string[]): string[] {
  const stmt = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`);
  return tables.filter((t) => stmt.get(t) === undefined);
}

function noData(threshold: string, why: string): Measurement {
  return { met: false, value: "n/a", threshold, stateKey: "", details: [`no data: ${why}`], noData: true };
}

function missingTablesNote(missing: string[]): string {
  return `table(s) ${missing.join(", ")} not in this DB (fresh DB? point DB_PATH/--db at the daemon's)`;
}

function isoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function isoMinute(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function walletTracked(db: DatabaseSync, wallet: string): boolean {
  return db.prepare(`SELECT 1 FROM wallets WHERE lower(address) = ?`).get(wallet.toLowerCase()) !== undefined;
}

function lastPoll(db: DatabaseSync, wallet: string): number | null {
  if (hasTables(db, ["wallet_polls"]).length) return null;
  const row = db.prepare(`SELECT MAX(polled_at) AS t FROM wallet_polls WHERE lower(wallet_address) = ?`).get(wallet.toLowerCase()) as
    { t: number | null } | undefined;
  return row?.t ?? null;
}

// The confirmed quality pool: each wallet's latest row among confirmed ones
// (method != 'shallow' AND truncated = 0) with is_quality set -- the same
// rule as repository.ts's listConfirmedQualityWallets(), restated here as a
// query so this module doesn't depend on that file's in-flux API.
export function confirmedQualityPool(db: DatabaseSync): { address: string; qualityScore: number }[] | null {
  if (hasTables(db, ["wallet_scores"]).length) return null;
  return db
    .prepare(
      `SELECT lower(address) AS address, quality_score AS qualityScore FROM wallet_scores
       WHERE id IN (SELECT MAX(id) FROM wallet_scores WHERE method != 'shallow' AND truncated = 0 GROUP BY lower(address))
         AND is_quality = 1
       ORDER BY lower(address)`
    )
    .all() as { address: string; qualityScore: number }[];
}

// Display name for a wallet: first word of its label in the daemon's
// `wallets` table (e.g. "ndb1"), else a shortened address.
export function walletName(db: DatabaseSync, wallet: string): string {
  const short = `${wallet.slice(0, 8)}...`;
  if (hasTables(db, ["wallets"]).length) return short;
  const row = db.prepare(`SELECT label FROM wallets WHERE lower(address) = ?`).get(wallet.toLowerCase()) as { label: string } | undefined;
  const first = row?.label.split(" ")[0];
  return first && !first.startsWith("0x") && !first.startsWith("unnamed") ? first : short;
}

const TRAILING_DATE_RE = /(\d{4}-\d{2}-\d{2})$/;

function evalLeagueEvents(c: Extract<WatchCondition, { kind: "leagueEvents" }>, { db, now }: EvalContext): Measurement {
  const threshold = `>= ${c.threshold} events`;
  const missing = hasTables(db, ["wallets", "wallet_activity"]);
  if (missing.length) return noData(threshold, missingTablesNote(missing));

  const keys = db
    .prepare(`SELECT DISTINCT ${EVENT_KEY_SQL} AS ek FROM wallet_activity a WHERE lower(a.wallet_address) = ? AND a.type = 'TRADE'`)
    .all(c.wallet.toLowerCase())
    .map((r) => String((r as { ek: string }).ek));
  const today = isoDate(now);
  let added = 0;
  let pending = 0;
  let undated = 0;
  for (const ek of keys) {
    if (ek.split("-")[0].toLowerCase() !== c.league.toLowerCase()) continue;
    const date = TRAILING_DATE_RE.exec(ek)?.[1];
    if (!date) undated++;
    else if (date < c.baselineFromDate) continue;
    else if (date < today) added++;
    else pending++;
  }
  const total = c.baselineEvents + added;
  const details = [
    `baseline ${c.baselineEvents} (API run) + ${added} dated ${c.league.toUpperCase()} event(s) since ${c.baselineFromDate} in wallet_activity` +
      (pending ? `; ${pending} more not yet played/resolved` : "") +
      (undated ? `; ${undated} undated (futures) not counted` : ""),
  ];
  if (!walletTracked(db, c.wallet)) details.push(`wallet not tracked by the daemon here -- this count cannot grow`);
  return { met: total >= c.threshold, value: `~${total} events`, threshold, stateKey: "met", details };
}

function evalQualityCategoryOverlap(c: Extract<WatchCondition, { kind: "qualityCategoryOverlap" }>, { db }: EvalContext): Measurement {
  const threshold = `>= ${c.threshold} shared markets in one category`;
  const missing = hasTables(db, ["wallet_activity", "wallet_scores", "wallets"]);
  if (missing.length) return noData(threshold, missingTablesNote(missing));
  const pool = confirmedQualityPool(db) ?? [];
  if (pool.length < 2) return noData(threshold, `quality pool has ${pool.length} wallet(s); overlap needs >= 2`);

  const addrs = pool.map((p) => p.address);
  const rows = db
    .prepare(
      `SELECT lower(a.wallet_address) AS wallet, a.condition_id AS cid, MAX(a.title) AS title
       FROM wallet_activity a
       WHERE a.type = 'TRADE' AND lower(a.wallet_address) IN (${addrs.map(() => "?").join(",")})
       GROUP BY lower(a.wallet_address), a.condition_id`
    )
    .all(...addrs) as { wallet: string; cid: string; title: string }[];

  const byMarket = new Map<string, { category: string; wallets: Set<string> }>();
  for (const r of rows) {
    const m = byMarket.get(r.cid) ?? { category: categorize(r.title), wallets: new Set<string>() };
    m.wallets.add(r.wallet);
    byMarket.set(r.cid, m);
  }
  const shared = new Map<string, number>();
  for (const m of byMarket.values()) if (m.wallets.size >= 2) shared.set(m.category, (shared.get(m.category) ?? 0) + 1);
  const ranked = [...shared.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const best = ranked[0] ?? ["-", 0];
  const withActivity = new Set(rows.map((r) => r.wallet)).size;

  return {
    met: best[1] >= c.threshold,
    value: `${best[1]} (${best[0]})`,
    threshold,
    stateKey: "met",
    details: [
      ranked.length
        ? `shared markets by category: ${ranked.map(([k, n]) => `${k} ${n}`).join(", ")}`
        : "no market shared by 2+ quality wallets",
      `${withActivity} of ${pool.length} quality wallets have daemon activity; daemon history only (lower bound vs. API pulls)`,
    ],
  };
}

function evalWalletResumed(c: Extract<WatchCondition, { kind: "walletResumed" }>, { db }: EvalContext): Measurement {
  const threshold = `a trade after ${isoMinute(c.lastSeenTs)}`;
  const missing = hasTables(db, ["wallets", "wallet_activity"]);
  if (missing.length) return noData(threshold, missingTablesNote(missing));
  const row = db
    .prepare(
      `SELECT MAX(timestamp) AS t, SUM(timestamp > ?) AS newer FROM wallet_activity WHERE lower(wallet_address) = ? AND type = 'TRADE'`
    )
    .get(c.lastSeenTs, c.wallet.toLowerCase()) as { t: number | null; newer: number | null };
  const details: string[] = [];
  if (!walletTracked(db, c.wallet)) details.push("wallet not tracked by the daemon here -- cannot detect new trades");
  else {
    const polled = lastPoll(db, c.wallet);
    details.push(`daemon last polled it ${polled === null ? "never" : isoMinute(polled)}`);
  }
  if (row.t === null) return { met: false, value: "no trades stored", threshold, stateKey: "", details, noData: true };
  const newer = row.newer ?? 0;
  if (newer > 0) details.unshift(`${newer} trade(s) newer than the watch baseline`);
  return { met: row.t > c.lastSeenTs, value: `last trade ${isoMinute(row.t)}`, threshold, stateKey: "met", details };
}

function evalQualityPoolChanged(c: Extract<WatchCondition, { kind: "qualityPoolChanged" }>, { db }: EvalContext): Measurement {
  const baseline = [...new Set(c.baseline.map((a) => a.toLowerCase()))].sort();
  const threshold = `!= baseline (${baseline.length} wallets)`;
  const pool = confirmedQualityPool(db);
  if (pool === null) return noData(threshold, missingTablesNote(["wallet_scores"]));
  const hasScores = (db.prepare(`SELECT COUNT(*) AS n FROM wallet_scores`).get() as { n: number }).n > 0;
  // An empty table means "nothing scored in this DB", not "everyone left
  // the pool" -- don't fire on that.
  if (!hasScores) return noData(threshold, "wallet_scores is empty");
  const current = pool.map((p) => p.address);
  const added = current.filter((a) => !baseline.includes(a));
  const removed = baseline.filter((a) => !current.includes(a));
  const name = (a: string) => walletName(db, a);
  const details: string[] = [];
  if (added.length) details.push(`added: ${added.map((a) => `${name(a)} (${a})`).join(", ")}`);
  if (removed.length) details.push(`removed: ${removed.map((a) => `${name(a)} (${a})`).join(", ")}`);
  return {
    met: added.length > 0 || removed.length > 0,
    value: `${current.length} wallets: ${current.map(name).join(", ") || "(none)"}`,
    threshold,
    stateKey: current.join(","),
    details,
  };
}

function evalPaperResolvedEvents(c: Extract<WatchCondition, { kind: "paperResolvedEvents" }>, { db }: EvalContext): Measurement {
  const threshold = `>= ${c.threshold} events`;
  const missing = hasTables(db, ["paper_orders", "wallet_activity"]);
  if (missing.length) return noData(threshold, missingTablesNote(missing));
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders, COUNT(DISTINCT p.condition_id) AS markets, COUNT(DISTINCT ${EVENT_KEY_SQL}) AS events
       FROM paper_orders p JOIN wallet_activity a ON a.id = p.source_activity_id
       WHERE p.status IN ('won', 'lost')`
    )
    .get() as { orders: number; markets: number; events: number };
  return {
    met: row.events >= c.threshold,
    value: `${row.events} events`,
    threshold,
    stateKey: "met",
    details: [`${row.orders} resolved paper order(s) on ${row.markets} market(s)`],
  };
}

export function evaluateCondition(condition: WatchCondition, ctx: EvalContext): Measurement {
  switch (condition.kind) {
    case "leagueEvents":
      return evalLeagueEvents(condition, ctx);
    case "qualityCategoryOverlap":
      return evalQualityCategoryOverlap(condition, ctx);
    case "walletResumed":
      return evalWalletResumed(condition, ctx);
    case "qualityPoolChanged":
      return evalQualityPoolChanged(condition, ctx);
    case "paperResolvedEvents":
      return evalPaperResolvedEvents(condition, ctx);
  }
}
