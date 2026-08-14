// Phase 1 schema: only the tables Phase 1 (wallet tracking) actually uses.
// Markets/events/price-snapshots/signals/paper-orders/backtest-run tables
// are deliberately NOT created here — they belong to the phases that
// introduce them (Phase 2 research engine, Phase 3 paper trading), per
// docs/AUDIT.md §12's "don't build everything at once." Each phase should
// add its own numbered migration.

export const id = "0001_init";

export const sql = `
CREATE TABLE wallets (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  archetype TEXT NOT NULL,
  source TEXT,
  history_pages INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per real fill, deduped on the same key used by the pre-SQLite
-- getActivityFromStart() window-reopen logic (transaction hash + market +
-- outcome + side + size + price + timestamp) so idempotent re-ingestion of
-- an overlapping /activity page is a no-op, not a duplicate row. This is
-- the fix for docs/AUDIT.md §8 (the old JSONL tracker had no dedup logic
-- at all).
CREATE TABLE wallet_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL REFERENCES wallets(address),
  transaction_hash TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  side TEXT NOT NULL,
  size REAL NOT NULL,
  usdc_size REAL NOT NULL,
  price REAL NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  collected_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'polymarket-data-api',
  raw_payload TEXT NOT NULL,
  UNIQUE (wallet_address, transaction_hash, condition_id, outcome, side, size, price, timestamp)
);
CREATE INDEX idx_wallet_activity_wallet ON wallet_activity(wallet_address);
CREATE INDEX idx_wallet_activity_timestamp ON wallet_activity(timestamp);
CREATE INDEX idx_wallet_activity_condition ON wallet_activity(condition_id);

-- Positions are a legitimate time series (size/value/pnl change between
-- polls), not an immutable fact like a fill — kept as one snapshot row per
-- poll rather than deduped, matching the original tracker's intent.
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL REFERENCES wallets(address),
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  asset TEXT NOT NULL,
  size REAL NOT NULL,
  avg_price REAL NOT NULL,
  cur_price REAL NOT NULL,
  current_value REAL NOT NULL,
  cash_pnl REAL NOT NULL,
  percent_pnl REAL NOT NULL,
  realized_pnl REAL NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  end_date TEXT,
  polled_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'polymarket-data-api',
  raw_payload TEXT NOT NULL
);
CREATE INDEX idx_positions_wallet_polled ON positions(wallet_address, polled_at);

CREATE TABLE api_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  host TEXT NOT NULL,
  url TEXT NOT NULL,
  status_code INTEGER,
  message TEXT NOT NULL,
  attempt INTEGER NOT NULL
);
CREATE INDEX idx_api_errors_occurred ON api_errors(occurred_at);

-- One row per (wallet, poll attempt) — what the daemon's health view and
-- "avoid overlapping polls" logic both read from.
CREATE TABLE wallet_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL REFERENCES wallets(address),
  polled_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  positions_fetched INTEGER NOT NULL,
  activity_fetched INTEGER NOT NULL,
  activity_inserted INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX idx_wallet_polls_wallet_polled ON wallet_polls(wallet_address, polled_at);
`;
