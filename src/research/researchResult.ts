// Track N1 (docs/IMPROVEMENT_PLAN.md): machine-readable research results.
// A script run with --json=<path> writes one of these next to its console
// table, and `npm run prereg -- evaluate <slug> --result <path>` checks it
// against a pre-registered pass rule (src/research/preregistration.ts).
//
// Shape: one flat row per reported cell, keyed by the dimensions that
// identify it (e.g. {bucket: "70-85", leadHours: 24, slippageBps: 50,
// grouping: "event"}). A pre-registered rule selects exactly one row per
// clause by those keys, so a cell can't be picked after the fact.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BacktestTrial, StrategyResult } from "../domain/types";

export const RESULT_SCHEMA_ID = "polycopytrade.research-result/v1";
export const REPO_ROOT = path.resolve(__dirname, "../..");

const KeyValueSchema = z.union([z.string(), z.number()]);

export const ResultRowSchema = z.object({
  key: z.record(z.string(), KeyValueSchema),
  metrics: z.object({
    trials: z.number(),
    events: z.number(),
    winRate: z.number(),
    roi: z.number(),
    netPnl: z.number(),
    ciLowerBound: z.number().nullable(),
    ciUpperBound: z.number().nullable(),
    meetsMinimumSample: z.boolean(),
  }),
});
export type ResultRow = z.infer<typeof ResultRowSchema>;

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const WindowSchema = z.object({ start: DateSchema, end: DateSchema });
export type DateWindow = z.infer<typeof WindowSchema>;

export const ResearchResultSchema = z.object({
  schema: z.literal(RESULT_SCHEMA_ID),
  script: z.string(),
  argv: z.array(z.string()),
  args: z.record(z.string(), z.unknown()),
  // The window the run asked for (null when the script selects its data by
  // count, e.g. "newest N closed ladders") and the one its data actually
  // spans. A pre-registration checks both.
  requestedWindow: WindowSchema.nullable(),
  observedWindow: WindowSchema.nullable(),
  generatedAt: z.string(),
  gitCommit: z.string().nullable(),
  gitDirty: z.boolean().nullable(),
  comparisons: z.object({ k: z.number(), description: z.string() }).nullable(),
  rows: z.array(ResultRowSchema),
});
export type ResearchResult = z.infer<typeof ResearchResultSchema>;

export function resultRow(key: Record<string, string | number>, r: StrategyResult): ResultRow {
  return {
    key,
    metrics: {
      trials: r.trialCount,
      events: r.distinctEvents,
      winRate: r.winRate,
      roi: r.roi,
      netPnl: r.netPnl,
      ciLowerBound: r.roiBootstrapCI ? r.roiBootstrapCI[0] : null,
      ciUpperBound: r.roiBootstrapCI ? r.roiBootstrapCI[1] : null,
      meetsMinimumSample: r.meetsMinimumSample,
    },
  };
}

// Re-prices a $1-stake, hold-to-resolution trial at `slippageBps` worse
// than its quoted entryPrice (the same "slippage worsens the price" rule as
// engine.ts's applyCosts). For scripts that build cost-free trials and want
// a slippage-sensitivity row without rebuilding them.
export function withSlippage(trial: BacktestTrial, slippageBps: number): BacktestTrial {
  if (slippageBps === 0) return trial;
  const effectivePrice = Math.min(1, trial.entryPrice * (1 + slippageBps / 10_000));
  const shares = trial.usdcStaked / effectivePrice;
  return { ...trial, shares, netReturn: trial.won ? shares - trial.usdcStaked : -trial.usdcStaked };
}

// "150,300" -> [150, 300]; empty/absent -> [].
export function parseBpsList(raw: string | undefined, flag: string): number[] {
  if (raw === undefined || raw === "") return [];
  const out = raw.split(",").map(Number);
  if (out.some((v) => !Number.isFinite(v) || v < 0)) throw new Error(`--${flag} must be a comma list of non-negative bps, got "${raw}"`);
  return out;
}

export function isoDate(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error(`expected YYYY-MM-DD, got "${s}"`);
  return s;
}

// Min/max of a list of YYYY-MM-DD dates, or null for an empty list.
export function spanOf(dates: string[]): DateWindow | null {
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  return { start: sorted[0], end: sorted[sorted.length - 1] };
}

export function gitState(): { commit: string | null; dirty: boolean | null } {
  const git = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return { commit: git(["rev-parse", "HEAD"]), dirty: status === null ? null : status.length > 0 };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Builds, validates and writes a result file. Returns the parsed result.
export function writeResearchResult(
  file: string,
  fields: Omit<ResearchResult, "schema" | "generatedAt" | "gitCommit" | "gitDirty">
): ResearchResult {
  const { commit, dirty } = gitState();
  const result = ResearchResultSchema.parse({
    schema: RESULT_SCHEMA_ID,
    ...fields,
    generatedAt: new Date().toISOString(),
    gitCommit: commit,
    gitDirty: dirty,
  });
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nWrote machine-readable result (${result.rows.length} rows) to ${file}`);
  return result;
}
