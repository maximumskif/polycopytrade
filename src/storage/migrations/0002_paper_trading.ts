// Phase 3 schema: paper_orders, the only new table Phase 3 needs. One row
// per copied leader fill — a paper order is created the moment a follower
// entry price can be observed (or marked 'unresolvable' if it can't) and
// later updated in place once the underlying market resolves. See
// docs/AUDIT.md's "Phase 3 (paper trading)" section for the engine that
// writes/reads this table.

export const id = "0002_paper_trading";

export const sql = `
-- UNIQUE(source_activity_id) is what makes re-processing a wallet's
-- activity idempotent: the paper-trading engine re-scans wallet_activity
-- for uncopied fills every cycle, and INSERT OR IGNORE on this constraint
-- means a fill already turned into a paper order is never turned into a
-- second one, and never needs its own separate "already processed" table.
CREATE TABLE paper_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL REFERENCES wallets(address),
  source_activity_id INTEGER NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  category TEXT NOT NULL,
  leader_price REAL NOT NULL,
  leader_timestamp INTEGER NOT NULL,
  stake_usdc REAL NOT NULL,
  delay_seconds INTEGER NOT NULL,
  -- null only when status = 'unresolvable' (no CLOB price point was found
  -- at leader_timestamp + delay_seconds -- thin/illiquid market, or a fill
  -- too close to market close for a later tick to exist).
  follower_entry_price REAL,
  filled_at INTEGER,
  status TEXT NOT NULL DEFAULT 'filled', -- 'filled' | 'unresolvable' | 'won' | 'lost'
  resolved_at INTEGER,
  payout_usdc REAL,
  pnl_usdc REAL,
  created_at INTEGER NOT NULL,
  UNIQUE (source_activity_id)
);
CREATE INDEX idx_paper_orders_wallet ON paper_orders(wallet_address);
CREATE INDEX idx_paper_orders_status ON paper_orders(status);
`;
