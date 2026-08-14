// Typed, idempotent read/write functions over the Phase 1 schema. Nothing
// outside src/storage/ should write raw SQL against the database — this is
// the boundary the target architecture (docs/AUDIT.md §11) calls for
// between storage and everything else (tracking daemon, research scripts).

import { getDb } from "./db";
import type { Activity, Position } from "../api/schemas";
import type { ApiErrorRecord, WalletPollResult, WalletHealth, Trackable } from "../domain/types";
import type { TrackedWallet } from "../wallets";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function upsertWallet(wallet: TrackedWallet): void {
  const db = getDb();
  const ts = nowSeconds();
  db.prepare(
    `INSERT INTO wallets (address, label, archetype, source, history_pages, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       label = excluded.label,
       archetype = excluded.archetype,
       source = excluded.source,
       history_pages = excluded.history_pages,
       updated_at = excluded.updated_at`
  ).run(wallet.address, wallet.label, wallet.archetype, wallet.source, wallet.historyPages ?? null, ts, ts);
}

// Idempotent: relies on wallet_activity's UNIQUE constraint (see
// 0001_init.ts) so re-ingesting an overlapping /activity page is a no-op
// for fills already stored, not a duplicate row (docs/AUDIT.md §8).
// Returns how many rows were newly inserted.
export function insertActivity(walletAddress: string, rows: Activity[]): number {
  const db = getDb();
  const collectedAt = nowSeconds();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO wallet_activity
       (wallet_address, transaction_hash, condition_id, outcome, side, size, usdc_size, price, type, title, slug, timestamp, collected_at, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  for (const a of rows) {
    const result = stmt.run(
      walletAddress,
      a.transactionHash,
      a.conditionId,
      a.outcome,
      a.side,
      a.size,
      a.usdcSize,
      a.price,
      a.type,
      a.title,
      a.slug,
      a.timestamp,
      collectedAt,
      JSON.stringify(a)
    );
    inserted += Number(result.changes);
  }
  return inserted;
}

// Positions are a snapshot time series, not deduped — see 0001_init.ts.
export function insertPositionsSnapshot(walletAddress: string, rows: Position[]): number {
  const db = getDb();
  const polledAt = nowSeconds();
  const stmt = db.prepare(
    `INSERT INTO positions
       (wallet_address, condition_id, outcome, asset, size, avg_price, cur_price, current_value, cash_pnl, percent_pnl, realized_pnl, title, slug, end_date, polled_at, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const p of rows) {
    stmt.run(
      walletAddress,
      p.conditionId,
      p.outcome,
      p.asset,
      p.size,
      p.avgPrice,
      p.curPrice,
      p.currentValue,
      p.cashPnl,
      p.percentPnl,
      p.realizedPnl,
      p.title,
      p.slug,
      p.endDate,
      polledAt,
      JSON.stringify(p)
    );
  }
  return rows.length;
}

export function recordApiError(err: ApiErrorRecord): void {
  getDb()
    .prepare(`INSERT INTO api_errors (occurred_at, host, url, status_code, message, attempt) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(err.occurredAt, err.host, err.url, err.statusCode, err.message, err.attempt);
}

export function recordWalletPoll(result: WalletPollResult): void {
  getDb()
    .prepare(
      `INSERT INTO wallet_polls (wallet_address, polled_at, outcome, positions_fetched, activity_fetched, activity_inserted, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      result.address,
      result.polledAt,
      result.outcome,
      result.positionsFetched,
      result.activityFetched,
      result.activityInserted,
      result.error ?? null
    );
}

export function getWalletHealth(address: string): WalletHealth | null {
  const db = getDb();
  const wallet = db.prepare(`SELECT address, label FROM wallets WHERE address = ?`).get(address) as
    | { address: string; label: string }
    | undefined;
  if (!wallet) return null;

  const lastPoll = db
    .prepare(`SELECT polled_at as polledAt, outcome FROM wallet_polls WHERE wallet_address = ? ORDER BY polled_at DESC LIMIT 1`)
    .get(address) as { polledAt: number; outcome: string } | undefined;
  const lastSuccess = db
    .prepare(`SELECT polled_at as polledAt FROM wallet_polls WHERE wallet_address = ? AND outcome = 'ok' ORDER BY polled_at DESC LIMIT 1`)
    .get(address) as { polledAt: number } | undefined;
  const totalActivityRows = db.prepare(`SELECT COUNT(*) as n FROM wallet_activity WHERE wallet_address = ?`).get(address) as { n: number };

  // Consecutive failures since the last success (or since the beginning of
  // recorded history if it never succeeded).
  const failuresSinceSuccess = db
    .prepare(
      `SELECT COUNT(*) as n FROM wallet_polls
       WHERE wallet_address = ? AND outcome != 'ok'
         AND polled_at > COALESCE((SELECT MAX(polled_at) FROM wallet_polls WHERE wallet_address = ? AND outcome = 'ok'), 0)`
    )
    .get(address, address) as { n: number };

  return {
    address: wallet.address,
    label: wallet.label,
    lastPolledAt: lastPoll?.polledAt ?? null,
    lastSuccessAt: lastSuccess?.polledAt ?? null,
    consecutiveFailures: failuresSinceSuccess.n,
    totalActivityRows: totalActivityRows.n,
  };
}

// The tracking daemon's wallet list: everything upserted from wallets.ts's
// TRACKED_WALLETS at startup, plus anything added at runtime via
// `npm run wallets:add` — satisfies "configurable wallet list rather than
// requiring source edits" (docs/AUDIT.md Phase 1 scope) without ripping out
// wallets.ts's role as the seed set / the research scripts' source of
// archetype metadata.
export function listTrackedWallets(): Trackable[] {
  return getDb().prepare(`SELECT address, label FROM wallets ORDER BY label`).all() as unknown as Trackable[];
}

export function addWallet(address: string, label: string, archetype = "unclassified"): void {
  upsertWallet({ address, label, archetype: archetype as TrackedWallet["archetype"], source: "manual (wallets:add)" });
}

export function listWalletHealth(): WalletHealth[] {
  const db = getDb();
  const addresses = db.prepare(`SELECT address FROM wallets ORDER BY label`).all() as { address: string }[];
  return addresses.map((w) => getWalletHealth(w.address)).filter((h): h is WalletHealth => h !== null);
}
