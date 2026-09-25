// K5: which screen a sourcing script runs before the anchored
// confirmation. `activity` (default) is the existing path; `positions`
// (src/scoring/positionsScreen.ts) is opt-in. It is NOT the default: on
// the 30 wallets in wallet_scores (2026-09-25) it failed 3 of the 4 wallets
// whose anchored confirmation passed, and with the K1/K4 gamma cache warm
// it saved few requests (median 7 vs 10 per wallet). See the K5 commits.

import { scoreWalletPositions, POSITIONS_SCREEN_CLOSED_PAGES } from "../scoring/positionsScreen";
import type { TrackedWallet } from "../wallets";
import type { ScoringAttempt } from "./walletConfirmation";

export type ScreenMode = "activity" | "positions";

export function parseScreenMode(argv: string[]): ScreenMode {
  const raw = argv.find((a) => a.startsWith("--screen="))?.slice("--screen=".length);
  if (raw === undefined || raw === "activity") return "activity";
  if (raw === "positions") return "positions";
  throw new Error(`--screen must be "activity" or "positions", got "${raw}"`);
}

// Recorded as method "shallow" (wallet_scores' CHECK constraint allows only
// full/shallow/anchored, and it IS a newest-first, non-reproducible screen),
// with `historyPages` = closed-positions pages and `fills` = settled
// positions scored. Callers tag the `source` so these rows stay separable.
export async function positionsScreenAttempt(wallet: TrackedWallet): Promise<ScoringAttempt> {
  const r = await scoreWalletPositions(wallet, POSITIONS_SCREEN_CLOSED_PAGES);
  return {
    method: "shallow",
    historyStart: null,
    historyPages: POSITIONS_SCREEN_CLOSED_PAGES,
    truncated: false,
    fills: r.trials.length,
    score: r.score,
  };
}

export const POSITIONS_SOURCE_SUFFIX = " (positions screen)";
