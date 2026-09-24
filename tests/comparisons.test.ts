import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bonferroniConfidence,
  countComparisons,
  describeComparisons,
  multipleComparisonReport,
  pickBest,
  type ComparisonCandidate,
} from "../src/research/comparisons";
import { computeStrategyResult, eventClusteredRoiCI } from "../src/backtesting/statistics";
import { defaultBacktestConfig } from "../src/backtesting/engine";
import type { BacktestTrial, StrategyResult } from "../src/domain/types";

function candidate(label: string, roi: number, ci: [number, number] | null, distinctEvents = 50): ComparisonCandidate {
  return { label, result: { roi, roiBootstrapCI: ci, distinctEvents } as StrategyResult, trials: [] };
}

test("countComparisons / describeComparisons", () => {
  const dims = [
    { name: "buckets", count: 8 },
    { name: "leads", count: 2 },
  ];
  assert.equal(countComparisons(dims), 16);
  assert.equal(describeComparisons(dims), "8 buckets x 2 leads = 16 comparisons");
  assert.equal(describeComparisons([{ name: "buckets", count: 1 }]), "1 buckets = 1 comparison");
  assert.equal(countComparisons([]), 0);
  assert.throws(() => countComparisons([{ name: "x", count: 1.5 }]));
});

test("bonferroniConfidence", () => {
  assert.equal(bonferroniConfidence(1), 0.95);
  assert.ok(Math.abs(bonferroniConfidence(8) - 0.99375) < 1e-12);
  assert.throws(() => bonferroniConfidence(0));
});

test("pickBest prefers the highest CI lower bound, falls back to ROI, ties keep the first", () => {
  const a = candidate("a", 0.2, [-0.1, 0.5]);
  const b = candidate("b", 0.1, [0.05, 0.15]);
  const c = candidate("c", 0.5, null);
  assert.equal(pickBest([a, b, c])!.label, "b");
  assert.equal(pickBest([candidate("x", 0.1, null), candidate("y", 0.3, null)])!.label, "y");
  assert.equal(pickBest([candidate("p", 0, [0.1, 0.2]), candidate("q", 0, [0.1, 0.3])])!.label, "p");
  assert.equal(pickBest([]), null);
});

test("multipleComparisonReport flags the best of k as post hoc with a labeled rough guide", () => {
  const dims = [
    { name: "buckets", count: 4 },
    { name: "leads", count: 2 },
  ];
  const cands = [candidate("70-85 @24h", 0.108, [0.074, 0.139]), candidate("85-90 @24h", 0.01, [-0.02, 0.04])];
  const lines = multipleComparisonReport(dims, cands, { adjustedCI: () => [0.03, 0.18] });
  const text = lines.join("\n");
  assert.match(lines[0], /4 buckets x 2 leads = 8 comparisons/);
  assert.match(text, /2 of the 8 had any trials; k stays 8/);
  assert.match(text, /best by 95% CI lower bound: 70-85 @24h roi=10\.8% 95% CI \[7\.4%, 13\.9%\]/);
  assert.match(text, /POST HOC: best of 8.*pre-register/);
  assert.match(text, /rough guide only \(Bonferroni, 99\.38% = 1-0\.05\/8.*\[3\.0%, 18\.0%\] -> still clears zero/);

  const gone = multipleComparisonReport(dims, cands, { adjustedCI: () => [-0.01, 0.2] }).join("\n");
  assert.match(gone, /no longer clears zero/);
});

test("multipleComparisonReport: thin samples, a single comparison, notes, no candidates", () => {
  const thin = multipleComparisonReport([{ name: "buckets", count: 9 }], [candidate("65-85c", 0.151, [0.043, 0.26], 19)], {
    adjustedCI: () => null,
  }).join("\n");
  assert.match(thin, /only 19 events \(< MIN_SAMPLE_SIZE=20\)/);
  assert.match(thin, /n\/a \(too few trials\/events\)/);

  const single = multipleComparisonReport([{ name: "buckets", count: 1 }], [candidate("80-85c", 0.029, [-0.039, 0.092])], {
    note: "inherits k=5",
  });
  assert.match(single.join("\n"), /inherits k=5/);
  assert.match(single.join("\n"), /single comparison: 80-85c/);
  assert.doesNotMatch(single.join("\n"), /POST HOC/);

  assert.match(multipleComparisonReport([{ name: "buckets", count: 3 }], []).join("\n"), /no candidate had any trials/);
});

function trial(eventKey: string, won: boolean): BacktestTrial {
  return {
    walletAddress: "t",
    conditionId: eventKey,
    outcome: "Yes",
    eventKey,
    category: "x",
    entryTimestamp: 0,
    entryPrice: 0.5,
    usdcStaked: 1,
    shares: 2,
    resolved: true,
    won,
    netReturn: won ? 1 : -1,
  };
}

test("eventClusteredRoiCI: gating, degenerate data, and wider at higher confidence", () => {
  assert.equal(eventClusteredRoiCI([trial("a", true)], 0.95), null); // < MIN_SAMPLE_SIZE
  const oneEvent = Array.from({ length: 25 }, () => trial("same", true));
  assert.equal(eventClusteredRoiCI(oneEvent, 0.95), null); // one cluster
  const allWins = Array.from({ length: 25 }, (_, i) => trial(`e${i}`, true));
  assert.deepEqual(eventClusteredRoiCI(allWins, 0.99), [1, 1]);
  assert.throws(() => eventClusteredRoiCI(allWins, 1));

  const mixed = Array.from({ length: 60 }, (_, i) => trial(`e${i}`, i % 3 !== 0));
  const ci95 = eventClusteredRoiCI(mixed, 0.95, 20_000)!;
  const ci999 = eventClusteredRoiCI(mixed, 0.999, 20_000)!;
  assert.ok(ci999[0] < ci95[0] && ci999[1] > ci95[1]);
  // computeStrategyResult's CI is the 95% case of the same bootstrap
  const r = computeStrategyResult(mixed, defaultBacktestConfig());
  assert.ok(Math.abs(r.roiBootstrapCI![0] - ci95[0]) < 0.08 && Math.abs(r.roiBootstrapCI![1] - ci95[1]) < 0.08);
});

test("multipleComparisonReport says 'does not clear zero' when the 95% CI didn't either", () => {
  const text = multipleComparisonReport([{ name: "buckets", count: 4 }], [candidate("90-95", -0.03, [-0.08, 0.02])], {
    adjustedCI: () => [-0.1, 0.03],
  }).join("\n");
  assert.match(text, /does not clear zero \(nor does the 95% CI\)/);
});
