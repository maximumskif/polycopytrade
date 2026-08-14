// Domain types introduced by the Phase 1 data foundation (SQLite storage +
// tracking daemon). Raw Polymarket API response shapes (Activity, Position,
// GammaMarket, GammaEvent) live in src/api/types.ts instead, since they're
// validated 1:1 against the real API by src/api/schemas.ts — these are this
// project's own concepts, not mirrors of an external shape.

// Minimal shape the tracking daemon needs to poll a wallet — both
// wallets.ts's TrackedWallet and a bare DB row satisfy this structurally.
export interface Trackable {
  address: string;
  label: string;
}

export interface ApiErrorRecord {
  occurredAt: number; // unix seconds
  host: string;
  url: string;
  statusCode: number | null; // null for network-level failures (timeout, DNS, etc.)
  message: string;
  attempt: number; // 1-indexed retry attempt at which this error occurred
}

export type PollOutcome = "ok" | "partial" | "failed";

export interface WalletPollResult {
  address: string;
  polledAt: number; // unix seconds
  outcome: PollOutcome;
  positionsFetched: number;
  activityFetched: number;
  activityInserted: number; // post-dedup count actually new to storage
  error?: string;
}

// Per-wallet freshness/health, derived from storage — what the daemon (or a
// future dashboard) needs to answer "is this wallet's data current."
export interface WalletHealth {
  address: string;
  label: string;
  lastPolledAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  totalActivityRows: number;
}
