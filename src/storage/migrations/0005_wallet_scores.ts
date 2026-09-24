// Track M2 (docs/IMPROVEMENT_PLAN.md Tracks K-O, 2026-09-24): one row per
// scoring run per wallet, replacing hand-written verdicts in wallets.ts
// labels ("QUALITY WALLET", "RULED OUT", ...) as the record of what a
// wallet scored, on what window, and when. Append-only -- a re-score is a
// new row, never an update -- so a wallet's history (e.g. item 42's Zzzz87:
// shallow 71 -> anchored 50) stays visible instead of being overwritten.
//
// Purely additive: no existing table is touched, and there is deliberately
// NO foreign key to `wallets` -- most scored wallets are sourcing
// candidates that never enter the tracking daemon's seed list.

export const id = "0005_wallet_scores";

export const sql = `
CREATE TABLE wallet_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL, -- lowercased, so rows from different channels group together
  label TEXT,            -- display name at scoring time (username / leaderboard rank), not a verdict
  scored_at INTEGER NOT NULL,
  -- 'full'     = getActivityFromStart from the wallet's first fill (reproducible)
  -- 'shallow'  = getActivityDeep backward from now (screen only, NOT reproducible)
  -- 'anchored' = getActivityFromStart from a pinned history_start (reproducible)
  method TEXT NOT NULL CHECK (method IN ('full', 'shallow', 'anchored')),
  history_start INTEGER, -- unix seconds; null for 'full' (first fill) and 'shallow' (now-relative)
  history_pages INTEGER NOT NULL,
  -- 1 when the pull's newest fill is older than the wallet's actual newest
  -- activity (page budget ran out before the present) -- the score then
  -- describes an old slice and must not be trusted as current.
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  quality_score INTEGER NOT NULL,
  flags TEXT NOT NULL, -- JSON array of WalletFlag
  distinct_events INTEGER NOT NULL,
  win_rate REAL NOT NULL,
  roi REAL NOT NULL,
  net_pnl REAL NOT NULL,
  median_gap_seconds REAL,       -- null when undefined (<2 trades; Infinity in WalletScore)
  days_since_last_activity REAL, -- null when the pull had no activity at all
  is_quality INTEGER NOT NULL CHECK (is_quality IN (0, 1)), -- isQualityWallet() at scoring time
  source TEXT NOT NULL,          -- which script/channel produced the row
  git_commit TEXT
);
CREATE INDEX idx_wallet_scores_address_scored_at ON wallet_scores(address, scored_at);
`;
