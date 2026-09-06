// Typed, idempotent read/write functions over the Phase 1 schema. Nothing
// outside src/storage/ should write raw SQL against the database — this is
// the boundary the target architecture (docs/AUDIT.md §11) calls for
// between storage and everything else (tracking daemon, research scripts).

import { getDb } from "./db";
import type { Activity } from "../api/schemas";
import type {
  ApiErrorRecord,
  WalletPollResult,
  WalletHealth,
  Trackable,
  StoredActivity,
  NewPaperOrder,
  PaperOrder,
  PaperOrderStatus,
  NewOrderbookSnapshot,
} from "../domain/types";
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
    { address: string; label: string } | undefined;
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

// ---------------------------------------------------------------------
// Phase 3: paper trading
// ---------------------------------------------------------------------

// Every stored BUY/TRADE fill for a wallet that doesn't have a paper_orders
// row yet — the paper-trading engine's "what's new since last cycle" query.
// A LEFT JOIN...IS NULL rather than NOT IN, so it stays index-friendly as
// paper_orders grows.
export function listUncopiedBuyFills(walletAddress: string): StoredActivity[] {
  const rows = getDb()
    .prepare(
      `SELECT wa.id, wa.wallet_address as walletAddress, wa.condition_id as conditionId, wa.outcome, wa.side,
              wa.usdc_size as usdcSize, wa.price, wa.type, wa.title, wa.slug, wa.timestamp
       FROM wallet_activity wa
       LEFT JOIN paper_orders po ON po.source_activity_id = wa.id
       WHERE wa.wallet_address = ? AND wa.type = 'TRADE' AND wa.side = 'BUY' AND po.id IS NULL
       ORDER BY wa.timestamp ASC`
    )
    .all(walletAddress);
  return rows as unknown as StoredActivity[];
}

// INSERT OR IGNORE on the UNIQUE(source_activity_id) constraint — same
// idempotency pattern as insertActivity: re-scanning a fill that already
// became a paper order is a no-op, not a duplicate.
export function insertPaperOrder(order: NewPaperOrder): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO paper_orders
       (wallet_address, source_activity_id, condition_id, outcome, category, leader_price, leader_timestamp,
        stake_usdc, delay_seconds, follower_entry_price, filled_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    order.walletAddress,
    order.sourceActivityId,
    order.conditionId,
    order.outcome,
    order.category,
    order.leaderPrice,
    order.leaderTimestamp,
    order.stakeUsdc,
    order.delaySeconds,
    order.followerEntryPrice,
    order.filledAt,
    order.status,
    nowSeconds()
  );
}

function mapPaperOrderRow(r: any): PaperOrder {
  return {
    id: r.id,
    walletAddress: r.walletAddress,
    sourceActivityId: r.sourceActivityId,
    conditionId: r.conditionId,
    outcome: r.outcome,
    category: r.category,
    leaderPrice: r.leaderPrice,
    leaderTimestamp: r.leaderTimestamp,
    stakeUsdc: r.stakeUsdc,
    delaySeconds: r.delaySeconds,
    followerEntryPrice: r.followerEntryPrice,
    filledAt: r.filledAt,
    status: r.status,
    resolvedAt: r.resolvedAt,
    payoutUsdc: r.payoutUsdc,
    pnlUsdc: r.pnlUsdc,
    createdAt: r.createdAt,
  };
}

const PAPER_ORDER_COLUMNS = `id, wallet_address as walletAddress, source_activity_id as sourceActivityId, condition_id as conditionId,
       outcome, category, leader_price as leaderPrice, leader_timestamp as leaderTimestamp, stake_usdc as stakeUsdc,
       delay_seconds as delaySeconds, follower_entry_price as followerEntryPrice, filled_at as filledAt, status,
       resolved_at as resolvedAt, payout_usdc as payoutUsdc, pnl_usdc as pnlUsdc, created_at as createdAt`;

// Orders awaiting resolution — status 'filled' (a follower price was
// observed but the market hasn't settled yet). 'unresolvable' orders are
// deliberately excluded: there's no price to resolve a P&L against, ever.
export function listOpenPaperOrders(): PaperOrder[] {
  const rows = getDb()
    .prepare(`SELECT ${PAPER_ORDER_COLUMNS} FROM paper_orders WHERE status = 'filled' ORDER BY leader_timestamp ASC`)
    .all();
  return rows.map(mapPaperOrderRow);
}

export function resolvePaperOrder(id: number, status: PaperOrderStatus, payoutUsdc: number, pnlUsdc: number): void {
  getDb()
    .prepare(`UPDATE paper_orders SET status = ?, payout_usdc = ?, pnl_usdc = ?, resolved_at = ? WHERE id = ?`)
    .run(status, payoutUsdc, pnlUsdc, nowSeconds(), id);
}

export function listPaperOrders(walletAddress?: string): PaperOrder[] {
  const db = getDb();
  const rows = walletAddress
    ? db
        .prepare(`SELECT ${PAPER_ORDER_COLUMNS} FROM paper_orders WHERE wallet_address = ? ORDER BY leader_timestamp ASC`)
        .all(walletAddress)
    : db.prepare(`SELECT ${PAPER_ORDER_COLUMNS} FROM paper_orders ORDER BY leader_timestamp ASC`).all();
  return rows.map(mapPaperOrderRow);
}

// Pure raw capture for the depth-shift scoping work (docs/DEPTH_SHIFT_STRATEGY_SCOPE.md)
// -- no dedup/idempotency needed, every call is a genuinely new point in
// time, unlike insertActivity's re-fetched-fill problem.
export function insertOrderbookSnapshot(snapshot: NewOrderbookSnapshot): void {
  getDb()
    .prepare(
      `INSERT INTO orderbook_snapshots
         (market_slug, condition_id, token_id, captured_at, best_bid_price, best_bid_size, best_ask_price, best_ask_size, bids_json, asks_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      snapshot.marketSlug,
      snapshot.conditionId,
      snapshot.tokenId,
      snapshot.capturedAt,
      snapshot.bestBidPrice,
      snapshot.bestBidSize,
      snapshot.bestAskPrice,
      snapshot.bestAskSize,
      snapshot.bidsJson,
      snapshot.asksJson
    );
}
