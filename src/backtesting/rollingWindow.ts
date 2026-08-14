// Rolling-window / walk-forward backtesting: breaks a trial set into
// fixed-size time buckets (by entryTimestamp) and runs statistics.ts's
// computeStrategyResult on each bucket independently. Turns Phase 1f's
// hand-built "net P&L by week" table (README, 0x_exit's wallet: wk0 +49.5%,
// wk1 +13.8%, wk2 +1.7%, wk3 -17.6% -- a decaying edge the whole-history
// blended number hid) into a reusable, generic check any wallet/strategy in
// the new engine can run, instead of a one-off script.
//
// Deliberately NOT a parameter-fit walk-forward (there's no strategy
// parameter here to fit per window) -- this answers "is performance stable
// across time," which is the question this project has actually needed
// twice now (docs/AUDIT.md's Phase 1e/1f findings).

import { computeStrategyResult } from "./statistics";
import type { BacktestConfig, BacktestTrial, StrategyResult } from "../domain/types";

export interface RollingWindowResult {
  windowStart: number; // unix seconds, inclusive
  windowEnd: number; // unix seconds, exclusive
  result: StrategyResult;
}

// `windowSeconds` sizes each bucket; `stepSeconds` (defaults to
// `windowSeconds`, i.e. non-overlapping buckets) advances the start of the
// next bucket -- pass something smaller than `windowSeconds` for
// overlapping/sliding windows.
export function computeRollingWindowResults(
  trials: BacktestTrial[],
  config: BacktestConfig,
  windowSeconds: number,
  stepSeconds: number = windowSeconds
): RollingWindowResult[] {
  const resolved = trials.filter((t) => t.resolved);
  if (resolved.length === 0 || windowSeconds <= 0 || stepSeconds <= 0) return [];

  const firstTs = Math.min(...resolved.map((t) => t.entryTimestamp));
  const lastTs = Math.max(...resolved.map((t) => t.entryTimestamp));

  const windows: RollingWindowResult[] = [];
  for (let windowStart = firstTs; windowStart <= lastTs; windowStart += stepSeconds) {
    const windowEnd = windowStart + windowSeconds;
    const windowTrials = resolved.filter((t) => t.entryTimestamp >= windowStart && t.entryTimestamp < windowEnd);
    if (windowTrials.length === 0) continue;
    windows.push({ windowStart, windowEnd, result: computeStrategyResult(windowTrials, config) });
  }
  return windows;
}
