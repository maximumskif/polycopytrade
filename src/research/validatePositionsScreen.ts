// K5 validation: does the positions screen (src/scoring/positionsScreen.ts)
// reach the same pass/fail as the activity screen (scoreWalletShallow) and
// the anchored confirmation, on the wallets real sourcing runs recorded in
// `wallet_scores`? For each wallet with a shallow or anchored row it runs
// BOTH screens now (so drift since the recorded run shows up as activity-
// now vs activity-recorded disagreement, not as a positions-screen error),
// counting requests and wall time for each.
//
// Opens the DB read-only and writes nothing to it.
//
// Usage: npm run validate-positions-screen -- [--db=<path>] [--out=<json>] [--limit=N]

import "./requestCounter";
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { getApiCacheStats } from "../api/client";
import { isQualityWallet, scoreWalletShallow } from "../scoring/walletScore";
import { scoreWalletPositions } from "../scoring/positionsScreen";
import { config } from "../config/env";
import { requestCounts, totalRequests } from "./requestCounter";
import type { WalletScore } from "../domain/types";

interface Row {
  address: string;
  method: "shallow" | "anchored";
  truncated: number;
  quality_score: number;
  flags: string;
  is_quality: number;
  scored_at: number;
}

type Verdict = "pass" | "fail" | "unconfirmed";

interface ScreenRun {
  pass: boolean;
  qualityScore: number;
  flags: string[];
  distinctEvents: number;
  trials: number;
  roi: number;
  requests: number;
  requestsByHost: Record<string, number>;
  cacheHits: number;
  ms: number;
  extra?: Record<string, unknown>;
}

function arg(name: string): string | undefined {
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; requests: number; requestsByHost: Record<string, number>; cacheHits: number; ms: number }> {
  const before = new Map(requestCounts);
  const beforeTotal = totalRequests();
  const hitsBefore = getApiCacheStats().hits;
  const t0 = Date.now();
  const value = await fn();
  const ms = Date.now() - t0;
  const requestsByHost: Record<string, number> = {};
  for (const [host, n] of requestCounts) {
    const d = n - (before.get(host) ?? 0);
    if (d) requestsByHost[host] = d;
  }
  return { value, requests: totalRequests() - beforeTotal, requestsByHost, cacheHits: getApiCacheStats().hits - hitsBefore, ms };
}

function summarize(score: WalletScore, trials: number): Pick<ScreenRun, "pass" | "qualityScore" | "flags" | "distinctEvents" | "trials" | "roi"> {
  return {
    pass: isQualityWallet(score),
    qualityScore: score.qualityScore,
    flags: [...score.flags],
    distinctEvents: score.distinctEvents,
    trials,
    roi: score.roi,
  };
}

function fmt(r: ScreenRun | null): string {
  if (!r) return "error";
  return `${r.pass ? "PASS" : "fail"} ${r.qualityScore}${r.flags.length ? ` [${r.flags.join(",")}]` : ""} ev=${r.distinctEvents} n=${r.trials} roi=${(r.roi * 100).toFixed(1)}% req=${r.requests} ${(r.ms / 1000).toFixed(1)}s`;
}

async function main() {
  const dbPath = arg("db") ?? config.dbPath;
  const outPath = arg("out");
  const limit = Number(arg("limit") ?? Infinity);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      "SELECT address, method, truncated, quality_score, flags, is_quality, scored_at FROM wallet_scores WHERE method IN ('shallow','anchored') ORDER BY scored_at"
    )
    .all() as unknown as Row[];
  db.close();

  const byWallet = new Map<string, { shallow: Row[]; anchored: Row[] }>();
  for (const r of rows) {
    const w = byWallet.get(r.address) ?? { shallow: [], anchored: [] };
    (r.method === "shallow" ? w.shallow : w.anchored).push(r);
    byWallet.set(r.address, w);
  }
  console.log(`${rows.length} rows, ${byWallet.size} wallets from ${dbPath}`);

  const results: Record<string, unknown>[] = [];
  for (const [address, w] of [...byWallet.entries()].slice(0, limit)) {
    const recordedShallow: Verdict | null = w.shallow.length ? (w.shallow[w.shallow.length - 1].is_quality ? "pass" : "fail") : null;
    const shallowVerdicts = w.shallow.map((r) => (r.is_quality ? "pass" : "fail"));
    // The anchored verdict is the LAST attempt's (classifyConfirmation): a
    // truncated last attempt is unconfirmed, never a pass or a fail.
    const lastAnchored = w.anchored[w.anchored.length - 1];
    const anchored: Verdict | null = lastAnchored ? (lastAnchored.truncated ? "unconfirmed" : lastAnchored.is_quality ? "pass" : "fail") : null;
    const wallet = { address, label: address, archetype: "unclassified" as const, source: "validate-positions-screen" };

    let positions: ScreenRun | null = null;
    let activity: ScreenRun | null = null;
    try {
      const m = await measure(() => scoreWalletPositions(wallet));
      const v = m.value;
      positions = {
        ...summarize(v.score, v.trials.length),
        requests: m.requests,
        requestsByHost: m.requestsByHost,
        cacheHits: m.cacheHits,
        ms: m.ms,
        extra: {
          closed: v.closedCount,
          redeemable: v.redeemableCount,
          redeemableIncluded: v.redeemableIncluded,
          unsettledSkipped: v.unsettledSkipped,
          windowStart: v.windowStart,
          redeemableCapped: v.redeemableCapped,
          daysSinceLastActivity: v.score.daysSinceLastActivity,
          medianGapSeconds: v.score.medianGapSeconds,
        },
      };
    } catch (err) {
      console.log(`  positions screen failed: ${(err as Error).message}`);
    }
    try {
      const m = await measure(() => scoreWalletShallow(wallet, 4));
      activity = {
        ...summarize(m.value.score, m.value.trials.length),
        requests: m.requests,
        requestsByHost: m.requestsByHost,
        cacheHits: m.cacheHits,
        ms: m.ms,
        extra: { fills: m.value.activity.length },
      };
    } catch (err) {
      console.log(`  activity screen failed: ${(err as Error).message}`);
    }
    console.log(
      `${address}  recorded shallow=${shallowVerdicts.join("/") || "-"} anchored=${anchored ?? "-"}\n` +
        `    positions: ${fmt(positions)}\n    activity:  ${fmt(activity)}`
    );
    results.push({ address, recordedShallow, shallowVerdicts, anchored, positions, activity });
    if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 2));
  }

  // Agreement tables (counts). "agree" = same pass/fail; anchored
  // "unconfirmed" is reported separately, it's neither.
  const table = (label: string, ref: (r: Record<string, unknown>) => Verdict | null, screen: "positions" | "activity") => {
    const cells = { "pass/pass": 0, "pass/fail": 0, "fail/pass": 0, "fail/fail": 0, "unconfirmed/pass": 0, "unconfirmed/fail": 0 };
    for (const r of results) {
      const refV = ref(r);
      const s = r[screen] as ScreenRun | null;
      if (!refV || !s) continue;
      cells[`${refV}/${s.pass ? "pass" : "fail"}` as keyof typeof cells]++;
    }
    console.log(`${label} (reference/screen): ${JSON.stringify(cells)}`);
  };
  console.log("\n=== agreement ===");
  table("recorded shallow vs positions", (r) => r.recordedShallow as Verdict | null, "positions");
  table("recorded shallow vs activity-now", (r) => r.recordedShallow as Verdict | null, "activity");
  table("activity-now vs positions", (r) => ((r.activity as ScreenRun | null) ? ((r.activity as ScreenRun).pass ? "pass" : "fail") : null), "positions");
  table("anchored vs positions", (r) => r.anchored as Verdict | null, "positions");
  table("anchored vs activity-now", (r) => r.anchored as Verdict | null, "activity");

  const sum = (screen: "positions" | "activity", key: "requests" | "ms") =>
    results.reduce((s, r) => s + ((r[screen] as ScreenRun | null)?.[key] ?? 0), 0);
  const n = results.length;
  console.log(
    `\nSummary: ${n} wallets; positions screen ${sum("positions", "requests")} requests / ${(sum("positions", "ms") / 1000).toFixed(0)}s; ` +
      `activity screen ${sum("activity", "requests")} requests / ${(sum("activity", "ms") / 1000).toFixed(0)}s.`
  );
}

if (require.main === module) {
  main();
}
