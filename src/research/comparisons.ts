// Track N2 (docs/IMPROVEMENT_PLAN.md): multiple-comparison reporting for
// research scripts that print many buckets/variants. Item 44 is the
// cautionary tale: weather-favorites' 70-85c @24h bucket looked robust
// (+10.8%, CI [7.4%, 13.9%]) but was the best of 8 post-hoc comparisons,
// and a pre-registered out-of-sample run put it at -2.3%. Item 43's
// volatility-breakout 65-85c bucket was the same shape (1 of 8 buckets).
// A 95% CI on the best of k looks like a 95% CI; it isn't one. So every
// script that reports k variants says k out loud and labels its best one
// as exploratory.
//
// The Bonferroni line is a ROUGH GUIDE, labeled as such: it widens the
// best candidate's event-clustered bootstrap CI to 1 - 0.05/k. Bonferroni
// assumes nothing about dependence between the k tests (so it's
// conservative when buckets overlap in events), the bootstrap tails at
// 99.x% are thin, and none of it substitutes for an out-of-sample test --
// which is what `npm run prereg` is for.

import { eventClusteredRoiCI, MIN_SAMPLE_SIZE } from "../backtesting/statistics";
import type { BacktestTrial, StrategyResult } from "../domain/types";

export interface ComparisonDimension {
  name: string; // plural noun for the printed summary, e.g. "buckets", "leads"
  count: number;
}

export interface ComparisonCandidate {
  label: string;
  result: StrategyResult;
  trials: BacktestTrial[]; // the trials `result` was computed from (for the adjusted CI)
}

export const FAMILY_ALPHA = 0.05;
// The adjusted interval sits far out in the bootstrap tails; 2000 resamples
// (the 95% default) would leave ~1-3 draws in each tail at k=16.
const ADJUSTED_CI_RESAMPLES = 10_000;

export function countComparisons(dims: ComparisonDimension[]): number {
  if (dims.length === 0) return 0;
  return dims.reduce((k, d) => {
    if (!Number.isInteger(d.count) || d.count < 0) throw new Error(`comparison dimension "${d.name}" has invalid count ${d.count}`);
    return k * d.count;
  }, 1);
}

// "4 buckets x 2 leads = 8 comparisons" / "5 buckets = 5 comparisons".
export function describeComparisons(dims: ComparisonDimension[]): string {
  const k = countComparisons(dims);
  const parts = dims.map((d) => `${d.count} ${d.name}`);
  return `${parts.join(" x ")} = ${k} comparison${k === 1 ? "" : "s"}`;
}

// Two-sided per-comparison confidence level that keeps the family-wise
// error at `alpha` under Bonferroni: 1 - alpha/k.
export function bonferroniConfidence(k: number, alpha = FAMILY_ALPHA): number {
  if (!(k >= 1)) throw new Error(`k must be >= 1, got ${k}`);
  return 1 - alpha / k;
}

// "Best" = highest 95% CI lower bound among candidates that have a CI (the
// number a reader's eye goes to: "the one bucket whose CI clears zero");
// falls back to highest ROI when no candidate has a CI. Ties keep the
// earlier candidate so the pick is deterministic.
export function pickBest(candidates: ComparisonCandidate[]): ComparisonCandidate | null {
  const withCi = candidates.filter((c) => c.result.roiBootstrapCI !== null);
  const pool = withCi.length > 0 ? withCi : candidates;
  let best: ComparisonCandidate | null = null;
  const score = (c: ComparisonCandidate) => (withCi.length > 0 ? c.result.roiBootstrapCI![0] : c.result.roi);
  for (const c of pool) if (best === null || score(c) > score(best)) best = c;
  return best;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function ciText(ci: [number, number] | null): string {
  return ci ? `[${pct(ci[0])}, ${pct(ci[1])}]` : "n/a";
}

export interface ComparisonReportOptions {
  // Extra context, e.g. that a single-bucket deep dive inherits the k of
  // the sweep it was chosen from.
  note?: string;
  // Overrides the adjusted-CI computation (tests pass a stub so output is
  // deterministic; the bootstrap is random).
  adjustedCI?: (trials: BacktestTrial[], confidence: number) => [number, number] | null;
}

// Lines to print after a script's per-bucket table. `dims` describes what
// was compared (their product is k); `candidates` are the k results.
export function multipleComparisonReport(
  dims: ComparisonDimension[],
  candidates: ComparisonCandidate[],
  opts: ComparisonReportOptions = {}
): string[] {
  const k = countComparisons(dims);
  const lines = [`=== Multiple comparisons: ${describeComparisons(dims)} ===`];
  if (opts.note) lines.push(`  ${opts.note}`);
  if (candidates.length !== k) {
    lines.push(`  (${candidates.length} of the ${k} had any trials; k stays ${k} -- an empty cell was still looked at)`);
  }
  const best = pickBest(candidates);
  if (!best) {
    lines.push("  no candidate had any trials");
    return lines;
  }
  const r = best.result;
  const thin = r.distinctEvents < MIN_SAMPLE_SIZE ? `, only ${r.distinctEvents} events (< MIN_SAMPLE_SIZE=${MIN_SAMPLE_SIZE})` : "";
  if (k <= 1) {
    lines.push(`  single comparison: ${best.label} roi=${pct(r.roi)} 95% CI ${ciText(r.roiBootstrapCI)}${thin}`);
    return lines;
  }
  lines.push(
    `  best by ${r.roiBootstrapCI ? "95% CI lower bound" : "ROI (no candidate has a CI)"}: ${best.label} ` +
      `roi=${pct(r.roi)} 95% CI ${ciText(r.roiBootstrapCI)}${thin}`
  );
  lines.push(
    `  -> POST HOC: best of ${k}. Exploratory only -- pre-register an out-of-sample test before trusting it ` +
      `(npm run prereg -- create ...; see docs/preregistrations/README.md).`
  );
  const confidence = bonferroniConfidence(k);
  const adjusted = (opts.adjustedCI ?? ((t, c) => eventClusteredRoiCI(t, c, ADJUSTED_CI_RESAMPLES)))(best.trials, confidence);
  const verdict = adjusted === null ? "n/a (too few trials/events)" : adjusted[0] > 0 ? "still clears zero" : "no longer clears zero";
  lines.push(
    `  rough guide only (Bonferroni, ${(confidence * 100).toFixed(2)}% = 1-${FAMILY_ALPHA}/${k} event-clustered CI): ` +
      `${ciText(adjusted)} -> ${verdict}. Not a substitute for out-of-sample data.`
  );
  return lines;
}
