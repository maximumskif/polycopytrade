// Depth-shift strategy scoping (docs/DEPTH_SHIFT_STRATEGY_SCOPE.md): the
// project has no historical order-book data anywhere, and Polymarket's
// CLOB exposes no historical order-book endpoint -- the only way to ever
// test a depth-shift rule is to start collecting live snapshots now. This
// table is pure raw data capture; no strategy logic reads it yet.

export const id = "0003_orderbook_snapshots";

export const sql = `
CREATE TABLE orderbook_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_slug TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  best_bid_price REAL,
  best_bid_size REAL,
  best_ask_price REAL,
  best_ask_size REAL,
  -- Full ladder, not just best bid/ask -- the depth-shift signal this is
  -- for is about liquidity vanishing further down the book, not just the
  -- top price. Stored as JSON (same "raw payload retention" reasoning
  -- flagged as a gap in docs/AUDIT.md Section 8 for the old JSONL
  -- tracker) rather than a normalized levels table, since nothing reads
  -- this yet and premature normalization would be guessing at an access
  -- pattern before one exists.
  bids_json TEXT NOT NULL,
  asks_json TEXT NOT NULL
);
CREATE INDEX idx_orderbook_snapshots_token_time ON orderbook_snapshots(token_id, captured_at);
`;
