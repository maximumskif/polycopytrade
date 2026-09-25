// Track M1/M2 (docs/IMPROVEMENT_PLAN.md Tracks K-O, 2026-09-24): the
// screen -> confirm -> record -> verdict steps items 41-46 did by hand,
// shared by every script that produces a wallet verdict (confirmShallow.ts,
// sourceWallets.ts, sourceWalletsFromHolders.ts) so the truncation and
// retry rules live in exactly one place.
//
// Lessons encoded here, all from that manual workflow:
// - A shallow screen (scoreWalletShallow, backward from "now") is not a
//   result: 5 of item 41/42's 8 shallow passes failed confirmation. Any
//   shallow pass is re-scored from a PINNED anchor (reproducible) before it
//   counts.
// - qualityScore == 50 is the profitability-floor cap, not a pass (item
//   42/47) -- the bar is isQualityWallet(), never ">= 50".
// - An anchored pull that runs out of pages before the wallet's newest
//   activity describes an OLD slice (item 41's coinman2/0x32b4, item 42's
//   soccer wallets). It gets one retry from a later pinned anchor; if still
//   truncated, the wallet is UNCONFIRMED -- reported, never passed.
//
// The pipeline records every attempt in `wallet_scores` (migration 0005)
// and prints a ready-to-paste wallets.ts entry for confirmed wallets, but
// never edits wallets.ts itself: that file stays the tracking daemon's
// hand-curated seed list.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { getActivity, type Activity } from "../api/client";
import { isQualityWallet, PROFITABILITY_FLOOR_CAP, scoreWalletWithActivity } from "../scoring/walletScore";
import { insertWalletScore } from "../storage/repository";
import type { NewWalletScoreRecord, WalletScore, WalletScoreMethod } from "../domain/types";
import type { TrackedWallet } from "../wallets";

// 2026-06-24T00:00:00Z -- ~90 days before item 41's sweep. Pinned, not
// computed from Date.now(), so the fills (and therefore the score) are
// reproducible; recorded as `historyStart` in wallets.ts and wallet_scores.
export const CONFIRM_HISTORY_START = 1782259200;
export const CONFIRM_HISTORY_PAGES = 40;

// Retry anchor rule (2026-09-24). Item 42 retried truncated soccer wallets
// by hand with `--from` ~30 days back (Zzzz87 from 2026-08-25). Automated,
// the anchor is derived from the WALLET's newest activity -- not from
// Date.now() -- and snapped DOWN to the 1st or 16th of that UTC month, so
// (a) it's a stable, human-readable date many wallets and re-runs share,
// and (b) it always lands 30-46 days before the wallet's newest fill, never
// fewer than RETRY_LOOKBACK_DAYS. The anchor actually used is written to
// wallet_scores.history_start and to the printed wallets.ts entry, so the
// score stays reproducible regardless of when the rule was evaluated.
export const RETRY_LOOKBACK_DAYS = 30;

const DAY_SECONDS = 86400;

export function retryAnchorFor(latestActivityTs: number): number {
  const d = new Date((latestActivityTs - RETRY_LOOKBACK_DAYS * DAY_SECONDS) * 1000);
  const day = d.getUTCDate() >= 16 ? 16 : 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day) / 1000;
}

// The next anchor to try after a truncated pull from `currentAnchor`, or
// null when the rule can't move later (the wallet's newest activity is
// already within the lookback of the current anchor, so a retry would pull
// the same or an earlier window).
export function nextRetryAnchor(currentAnchor: number, latestActivityTs: number | null): number | null {
  if (latestActivityTs === null) return null;
  const next = retryAnchorFor(latestActivityTs);
  return next > currentAnchor ? next : null;
}

export function newestTimestamp(activity: Pick<Activity, "timestamp">[]): number | null {
  let newest: number | null = null;
  for (const a of activity) if (newest === null || a.timestamp > newest) newest = a.timestamp;
  return newest;
}

// Truncated = the wallet has activity newer than anything the pull
// returned, i.e. the page budget ended before the present (item 41's
// definition, previously duplicated in sourceWallets.ts/confirmShallow.ts).
// A wallet with no activity at all can't be truncated.
export function isTruncated(latestActivityTs: number | null, pulledNewestTs: number | null): boolean {
  return latestActivityTs !== null && (pulledNewestTs === null || pulledNewestTs < latestActivityTs);
}

export function fmtDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// Why a score does NOT pass isQualityWallet(), or null if it does. The cap
// case gets its own wording because it's the one that looked like a pass
// under the old ">= 50" bar (item 42: 6 of 12 "clean" soccer wallets).
export function qualityFailureReason(score: Pick<WalletScore, "flags" | "qualityScore" | "roi">): string | null {
  if (isQualityWallet(score)) return null;
  if (score.flags.length) return `vetoed: ${score.flags.join(", ")}`;
  if (score.roi <= 0) return `net ROI ${pct(score.roi)} -- lost money over the window (qualityScore=${score.qualityScore})`;
  const cap = PROFITABILITY_FLOOR_CAP * 100;
  if (score.qualityScore === cap) return `qualityScore=${cap} is the profitability-floor cap (both profitability terms weak), not a pass`;
  return `qualityScore=${score.qualityScore} <= ${cap}`;
}

export interface ScoringAttempt {
  method: WalletScoreMethod;
  historyStart: number | null;
  historyPages: number;
  truncated: boolean;
  fills: number;
  score: WalletScore;
}

export function describeWindow(a: Pick<ScoringAttempt, "method" | "historyStart" | "historyPages">): string {
  if (a.method === "anchored") return `anchored from ${a.historyStart !== null ? fmtDate(a.historyStart) : "?"}, ${a.historyPages} pages`;
  if (a.method === "full") return `full history, ${a.historyPages} pages`;
  return `shallow, newest ${a.historyPages} pages`;
}

export function describeScore(score: WalletScore): string {
  const gap = Number.isFinite(score.medianGapSeconds) ? score.medianGapSeconds.toFixed(1) : "n/a";
  return (
    `qualityScore=${score.qualityScore}/100${score.flags.length ? ` (flags: ${score.flags.join(", ")})` : " clean"}  ` +
    `events=${score.distinctEvents}  winRate=${pct(score.winRate)}  roi=${pct(score.roi)}  netPnl=$${score.netPnl.toFixed(2)}  ` +
    `medianGapSeconds=${gap}  daysSinceLastActivity=${score.daysSinceLastActivity.toFixed(1)}`
  );
}

export type ConfirmationVerdict =
  | { kind: "confirmed-quality"; attempt: ScoringAttempt }
  | { kind: "failed-confirmation"; attempt: ScoringAttempt; reason: string }
  | { kind: "unconfirmed-truncated"; attempt: ScoringAttempt; reason: string };

// Decided by the LAST reproducible attempt only: earlier attempts are the
// truncated ones that triggered a retry, and a truncated attempt's score
// describes an old slice, so it can neither pass nor fail the wallet.
export function classifyConfirmation(attempts: ScoringAttempt[]): ConfirmationVerdict {
  const attempt = attempts[attempts.length - 1];
  if (!attempt) throw new Error("classifyConfirmation: no attempts");
  if (attempt.method === "shallow") throw new Error("classifyConfirmation: a shallow screen can't confirm anything");
  if (attempt.truncated) {
    const windows = attempts.map((a) => (a.historyStart !== null ? fmtDate(a.historyStart) : "first fill")).join(" and ");
    // `dormant` is an artifact of the truncation itself, not information.
    const informative = attempt.score.flags.filter((f) => f !== "dormant");
    const partial = informative.length ? `; the truncated window already shows ${informative.join(", ")}` : "";
    return {
      kind: "unconfirmed-truncated",
      attempt,
      reason: `still truncated from ${windows} (${attempt.historyPages} pages ended before the wallet's newest activity)${partial}`,
    };
  }
  const failure = qualityFailureReason(attempt.score);
  return failure === null ? { kind: "confirmed-quality", attempt } : { kind: "failed-confirmation", attempt, reason: failure };
}

// Network seams, injectable so the retry logic is testable without the API.
export interface ConfirmDeps {
  getLatestActivityTs(address: string): Promise<number | null>;
  scoreAnchored(wallet: TrackedWallet): Promise<{ score: WalletScore; activity: Pick<Activity, "timestamp">[] }>;
}

export const liveConfirmDeps: ConfirmDeps = {
  async getLatestActivityTs(address) {
    const latest = await getActivity(address, { limit: 1 });
    return latest.length ? latest[0].timestamp : null;
  },
  scoreAnchored: scoreWalletWithActivity,
};

// Anchored pull from `historyStart` (default CONFIRM_HISTORY_START); if
// truncated, ONE retry from nextRetryAnchor(). `onAttempt` fires after each
// pull (callers record + print it there, so a long run shows progress).
export async function confirmWallet(
  wallet: { address: string; label: string },
  opts: {
    historyStart?: number;
    historyPages?: number;
    onAttempt?: (attempt: ScoringAttempt) => void;
    deps?: ConfirmDeps;
  } = {}
): Promise<{ verdict: ConfirmationVerdict; attempts: ScoringAttempt[]; latestActivityTs: number | null }> {
  const deps = opts.deps ?? liveConfirmDeps;
  const historyPages = opts.historyPages ?? CONFIRM_HISTORY_PAGES;
  const latestActivityTs = await deps.getLatestActivityTs(wallet.address);
  const attempts: ScoringAttempt[] = [];
  let anchor: number | null = opts.historyStart ?? CONFIRM_HISTORY_START;
  while (anchor !== null && attempts.length < 2) {
    const { score, activity } = await deps.scoreAnchored({
      address: wallet.address,
      label: wallet.label,
      archetype: "unclassified",
      source: "walletConfirmation",
      historyPages,
      historyStart: anchor,
    });
    const attempt: ScoringAttempt = {
      method: "anchored",
      historyStart: anchor,
      historyPages,
      truncated: isTruncated(latestActivityTs, newestTimestamp(activity)),
      fills: activity.length,
      score,
    };
    attempts.push(attempt);
    opts.onAttempt?.(attempt);
    anchor = attempt.truncated ? nextRetryAnchor(anchor, latestActivityTs) : null;
  }
  return { verdict: classifyConfirmation(attempts), attempts, latestActivityTs };
}

// ---------------------------------------------------------------------
// Recording (wallet_scores)
// ---------------------------------------------------------------------

export function toWalletScoreRecord(
  attempt: ScoringAttempt,
  meta: { source: string; label?: string | null; scoredAt?: number; gitCommit?: string | null }
): NewWalletScoreRecord {
  const s = attempt.score;
  return {
    address: s.address.toLowerCase(),
    label: meta.label ?? null,
    scoredAt: meta.scoredAt ?? Math.floor(Date.now() / 1000),
    method: attempt.method,
    historyStart: attempt.historyStart,
    historyPages: attempt.historyPages,
    truncated: attempt.truncated,
    qualityScore: s.qualityScore,
    flags: [...s.flags],
    distinctEvents: s.distinctEvents,
    winRate: s.winRate,
    roi: s.roi,
    netPnl: s.netPnl,
    medianGapSeconds: Number.isFinite(s.medianGapSeconds) ? s.medianGapSeconds : null,
    daysSinceLastActivity: Number.isFinite(s.daysSinceLastActivity) ? s.daysSinceLastActivity : null,
    isQuality: isQualityWallet(s),
    source: meta.source,
    gitCommit: meta.gitCommit ?? null,
  };
}

let cachedCommit: string | null | undefined;
function currentGitCommit(): string | null {
  if (cachedCommit !== undefined) return cachedCommit;
  try {
    cachedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).trim() || null;
  } catch {
    cachedCommit = null;
  }
  return cachedCommit;
}

// A DB write failing must not kill a multi-hour sourcing run, but it must
// not be silent either -- the printed verdicts are still complete.
export function recordAttempt(attempt: ScoringAttempt, meta: { source: string; label?: string | null }): void {
  try {
    insertWalletScore(toWalletScoreRecord(attempt, { ...meta, gitCommit: currentGitCommit() }));
  } catch (err) {
    console.warn(`  WARNING: failed to record ${attempt.score.address} in wallet_scores: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------
// Sourcing pipeline: screen result -> (auto-confirm) -> outcome
// ---------------------------------------------------------------------

export type OutcomeKind = "confirmed-quality" | "failed-confirmation" | "unconfirmed-truncated" | "screened-out" | "error";

export interface PipelineOutcome {
  kind: OutcomeKind;
  address: string;
  label: string; // display name + channel context, used for the wallets.ts entry
  provenance: string; // wallets.ts `source`
  reason?: string;
  screen?: ScoringAttempt;
  decidingAttempt?: ScoringAttempt;
}

// Takes a candidate's screen (a shallow pull, or a full pull that reached
// the present) and decides it, auto-confirming any shallow pass. A full,
// untruncated pull is already reproducible and needs no confirmation.
// Every attempt, screen included, is recorded under `source`.
export async function screenAndConfirm(
  candidate: { address: string; label: string; provenance: string },
  screen: ScoringAttempt,
  opts: { source: string; log?: (line: string) => void; deps?: ConfirmDeps }
): Promise<PipelineOutcome> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const base = { address: candidate.address, label: candidate.label, provenance: candidate.provenance, screen };
  recordAttempt(screen, { source: opts.source, label: candidate.label });

  const screenFailure = qualityFailureReason(screen.score);
  if (screenFailure !== null) return { ...base, kind: "screened-out", reason: `${screen.method} screen: ${screenFailure}` };
  if (screen.method !== "shallow" && !screen.truncated) return { ...base, kind: "confirmed-quality", decidingAttempt: screen };

  log(`    shallow pass (${screen.score.qualityScore}/100) -- auto-confirming from pinned anchor...`);
  const { verdict } = await confirmWallet(candidate, {
    deps: opts.deps,
    onAttempt: (a) => {
      recordAttempt(a, { source: `${opts.source} (auto-confirm)`, label: candidate.label });
      log(`    [${describeWindow(a)}] fills=${a.fills}${a.truncated ? " TRUNCATED" : ""}  ${describeScore(a.score)}`);
    },
  });
  return verdictToOutcome(base, verdict);
}

export function verdictToOutcome(
  base: Pick<PipelineOutcome, "address" | "label" | "provenance" | "screen">,
  verdict: ConfirmationVerdict
): PipelineOutcome {
  if (verdict.kind === "confirmed-quality") return { ...base, kind: verdict.kind, decidingAttempt: verdict.attempt };
  return { ...base, kind: verdict.kind, decidingAttempt: verdict.attempt, reason: verdict.reason };
}

function fmtUsd(x: number): string {
  const abs = Math.abs(x);
  const sign = x < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// Ready-to-paste TrackedWallet literal. The label keeps the "QUALITY
// WALLET" convention so status.ts's label-scan fallback still counts it.
export function formatWalletsTsEntry(o: {
  address: string;
  label: string;
  provenance: string;
  attempt: ScoringAttempt;
  confirmedAt?: number;
}): string {
  const s = o.attempt.score;
  const gap = Number.isFinite(s.medianGapSeconds) ? `${Math.round(s.medianGapSeconds)}` : "n/a";
  const label =
    `${o.label} — CONFIRMED ${fmtDate(o.confirmedAt ?? Math.floor(Date.now() / 1000))} on ${describeWindow(o.attempt)} (reached present): ` +
    `${s.qualityScore}/100 clean, ${pct(s.winRate)} win, ROI ${pct(s.roi)}, ${s.distinctEvents} events, netPnl=${fmtUsd(s.netPnl)}, ` +
    `medianGapSeconds=${gap} — QUALITY WALLET`;
  const lines = [
    "  {",
    `    address: ${JSON.stringify(o.address)},`,
    `    label: ${JSON.stringify(label)},`,
    `    archetype: "unclassified",`,
    `    source: ${JSON.stringify(o.provenance)},`,
    `    historyPages: ${o.attempt.historyPages},`,
  ];
  if (o.attempt.historyStart !== null)
    lines.push(`    historyStart: ${o.attempt.historyStart}, // ${fmtDate(o.attempt.historyStart)} -- auto-confirm anchor`);
  lines.push("  },");
  return lines.join("\n");
}

const SECTIONS: { kind: OutcomeKind; title: string }[] = [
  { kind: "confirmed-quality", title: "CONFIRMED QUALITY (reproducible pull reached the present, passes isQualityWallet)" },
  { kind: "failed-confirmation", title: "FAILED CONFIRMATION (reproducible pull reached the present, does not pass)" },
  { kind: "unconfirmed-truncated", title: "UNCONFIRMED -- TRUNCATED (not a pass: every anchored pull ended before the present)" },
  { kind: "screened-out", title: "SCREENED OUT" },
  { kind: "error", title: "ERRORS" },
];

export function printVerdicts(outcomes: PipelineOutcome[]): void {
  console.log("\n=== verdicts ===");
  for (const { kind, title } of SECTIONS) {
    const group = outcomes.filter((o) => o.kind === kind);
    if (group.length === 0 && (kind === "error" || kind === "screened-out")) continue;
    console.log(`\n${title}: ${group.length}`);
    const sortKey = (o: PipelineOutcome) => (o.decidingAttempt ?? o.screen)?.score.qualityScore ?? -1;
    group.sort((a, b) => sortKey(b) - sortKey(a));
    for (const o of group) {
      console.log(`  [${o.address}] ${o.label}`);
      const deciding = o.decidingAttempt ?? o.screen;
      if (o.screen && o.decidingAttempt && o.decidingAttempt !== o.screen) {
        console.log(`    screen:  [${describeWindow(o.screen)}] ${o.screen.score.qualityScore}/100`);
      }
      if (deciding)
        console.log(
          `    ${deciding === o.screen ? "score:  " : "confirm:"} [${describeWindow(deciding)}] ${describeScore(deciding.score)}`
        );
      if (o.reason) console.log(`    reason:  ${o.reason}`);
    }
  }
  const confirmed = outcomes.filter((o) => o.kind === "confirmed-quality" && o.decidingAttempt);
  if (confirmed.length) {
    console.log("\nwallets.ts entries for confirmed quality wallets (paste by hand -- the pipeline never edits wallets.ts):\n");
    for (const o of confirmed) console.log(formatWalletsTsEntry({ ...o, attempt: o.decidingAttempt! }));
  }
}
