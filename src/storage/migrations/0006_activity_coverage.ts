// Track K3 (docs/IMPROVEMENT_PLAN.md Tracks K-O, 2026-09-24): scoring reads
// a wallet's stored wallet_activity rows instead of re-pulling its whole
// history from /activity, fetching only what's missing. That needs to know
// WHICH time ranges the table holds completely -- the rows alone can't say:
// the daemon polls only the newest 200 rows per cycle, so a wallet that
// trades >200 times between polls leaves a silent hole, and the table
// starts wherever the daemon (or the last DB reset, 2026-09-22) began.
//
// One row per verified-complete interval [from_ts, to_ts] (inclusive unix
// seconds): every row the API returns for this wallet with a timestamp in
// that range is present in wallet_activity. Written only by code that can
// prove it (src/scoring/activitySource.ts's contiguous ASC gap-fill pages,
// and pollWallet's DESC batch -- see addActivityCoverage), merged on write
// so a wallet normally has one or two rows.
//
// Additive only. `source` in wallet_activity (0001, default
// 'polymarket-data-api') now also takes 'scoring-gap-fill' for rows the
// scorer backfilled; see listUncopiedBuyFills for why that matters.

export const id = "0006_activity_coverage";

export const sql = `
CREATE TABLE wallet_activity_coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL REFERENCES wallets(address),
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  CHECK (from_ts <= to_ts)
);
CREATE INDEX idx_wallet_activity_coverage_wallet ON wallet_activity_coverage(wallet_address);
CREATE INDEX idx_wallet_activity_wallet_ts ON wallet_activity(wallet_address, timestamp);
`;
