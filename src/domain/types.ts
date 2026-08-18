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

// ---------------------------------------------------------------------
// Phase 2: position reconstruction (docs/AUDIT.md §6 — BUY-only bias fix)
// ---------------------------------------------------------------------

export type PositionEventKind = "opened" | "increased" | "reduced" | "closed";

export interface PositionEvent {
  kind: PositionEventKind;
  timestamp: number;
  sizeDelta: number; // positive for BUY, negative for SELL
  price: number;
  positionSizeAfter: number;
  avgCostAfter: number;
  realizedPnlDelta: number; // booked by this specific fill; 0 unless reducing/closing
}

export interface ReconstructedPosition {
  walletAddress: string;
  conditionId: string;
  outcome: string;
  events: PositionEvent[];
  openedAt: number;
  closedAt: number | null; // null if still open as of the dataset cutoff
  finalSize: number;
  avgCost: number;
  realizedPnl: number;
  holdDurationSeconds: number | null; // null if still open
  // True when this position's fill history might be incomplete — e.g. a
  // SELL exceeds every prior tracked BUY (a position that existed before
  // the pulled activity window started). Realized P&L / avg cost on a
  // flagged position should be treated as a lower bound, not a fact.
  incompleteHistory: boolean;
}

// ---------------------------------------------------------------------
// Phase 2: reusable backtest engine (docs/AUDIT.md §3/§11)
// ---------------------------------------------------------------------

export interface BacktestConfig {
  strategyName: string;
  strategyVersion: string;
  // Only fills at/before this instant are used — the frozen "as-of"
  // boundary a backtest run is reproducible against (docs/AUDIT.md §3:
  // "no dataset snapshot/version" was a named gap).
  datasetCutoff: number;
  walletAddresses: string[];
  entryRule: string;
  exitRule: string;
  observationDelaySeconds: number;
  executionDelaySeconds: number;
  feeBps: number;
  slippageBps: number;
  resolutionTreatment: "hold-to-resolution" | "mirror-exit";
}

export interface BacktestTrial {
  walletAddress: string;
  conditionId: string;
  outcome: string;
  // eventSlug when the API provided one, else the market slug — see
  // docs/AUDIT.md §7 on why grouping by event (not market or fill) matters
  // for sample-independence.
  eventKey: string;
  category: string;
  entryTimestamp: number;
  entryPrice: number;
  usdcStaked: number;
  shares: number;
  resolved: boolean;
  won: boolean | null;
  netReturn: number; // dollar P&L for this trial, after any fee/slippage the config applied
}

export interface StrategyResult {
  config: BacktestConfig;
  trialCount: number;
  distinctMarkets: number;
  distinctEvents: number;
  // Not the same as trialCount or distinctMarkets — see docs/AUDIT.md §7:
  // "do not present fill count as an independent sample count." Correlated
  // markets sharing one real-world event (e.g. every rung of one month's
  // WTI ladder) are one data point, not N.
  effectiveIndependentSampleCount: number;
  totalStaked: number;
  grossReturned: number;
  netPnl: number;
  roi: number;
  winRate: number;
  expectedValuePerDollar: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null; // null when there are no losing trials (avoid div/0)
  maxDrawdownPct: number;
  volatility: number; // stdev of per-trial return-on-stake
  // "-like" because these trials don't share a common time basis the way
  // periodic returns do — this is mean/stdev of per-trial return, not an
  // annualized Sharpe ratio. Don't compare it to a traditional asset's
  // Sharpe number.
  sharpeLike: number | null;
  sortinoLike: number | null;
  roiBootstrapCI: [number, number] | null; // null if trialCount is below the minimum sample size
  categoryBreakdown: Record<string, { n: number; netPnl: number; winRate: number }>;
  meetsMinimumSample: boolean;
}

// ---------------------------------------------------------------------
// Phase 2: wallet scoring (docs/AUDIT.md — "Wallet evaluation")
// ---------------------------------------------------------------------

export type WalletFlag =
  | "one-shot"
  | "dormant"
  | "election-only"
  | "highly-concentrated"
  | "illiquid-markets"
  | "uncopyable-high-frequency"
  | "insufficient-sample";

export interface WalletScore {
  address: string;
  label: string;
  flags: WalletFlag[];
  distinctEvents: number;
  activitySpanDays: number;
  daysSinceLastActivity: number;
  concentrationTopEventShare: number; // fraction of total stake in the single largest event
  electionShare: number; // fraction of resolved trials in the "politics" category
  medianGapSeconds: number; // median time between consecutive TRADE fills — basis for the uncopyable-high-frequency flag
  netPnl: number;
  roi: number;
  winRate: number;
  strategyResult: StrategyResult;
}

// ---------------------------------------------------------------------
// Phase 3: paper trading (docs/AUDIT.md — "Phase 3 (paper trading)")
// ---------------------------------------------------------------------

// A wallet_activity row as read back from storage — distinct from the API's
// Activity type (src/api/schemas.ts) because it carries the DB row's own
// `id`, which paper_orders.source_activity_id references.
export interface StoredActivity {
  id: number;
  walletAddress: string;
  conditionId: string;
  outcome: string;
  side: string;
  usdcSize: number;
  price: number;
  type: string;
  title: string;
  slug: string;
  timestamp: number;
}

export type PaperOrderStatus = "filled" | "unresolvable" | "won" | "lost";

export interface NewPaperOrder {
  walletAddress: string;
  sourceActivityId: number;
  conditionId: string;
  outcome: string;
  category: string;
  leaderPrice: number;
  leaderTimestamp: number;
  stakeUsdc: number;
  delaySeconds: number;
  followerEntryPrice: number | null;
  filledAt: number | null;
  status: PaperOrderStatus;
}

export interface PaperOrder extends NewPaperOrder {
  id: number;
  resolvedAt: number | null;
  payoutUsdc: number | null;
  pnlUsdc: number | null;
  createdAt: number;
}

// Raw depth-shift data capture (docs/DEPTH_SHIFT_STRATEGY_SCOPE.md) — one
// row per polled order-book snapshot. No strategy logic reads this yet.
export interface NewOrderbookSnapshot {
  marketSlug: string;
  conditionId: string;
  tokenId: string;
  capturedAt: number;
  bestBidPrice: number | null;
  bestBidSize: number | null;
  bestAskPrice: number | null;
  bestAskSize: number | null;
  bidsJson: string;
  asksJson: string;
}
