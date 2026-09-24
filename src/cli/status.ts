// Track D (docs/IMPROVEMENT_PLAN.md): one command that answers "is
// everything running and what does it look like right now" without
// grepping logs or querying SQLite by hand. Composes existing, narrower
// tools rather than duplicating their logic:
//   - wallets:health (per-wallet freshness) stays its own command for
//     detailed per-wallet debugging; this prints a rollup instead.
//   - paper:report's reporting is reused directly (imported main()).
//   - wallet-score is deliberately NOT re-run here: scoring a wallet means
//     pulling its live activity from the Polymarket API (real, rate-limited
//     network cost), which doesn't belong in a "quick status check" -- this
//     just points at the command instead.
//
// Daemon liveness is read two ways and shown together: `systemctl --user
// is-active` (is the process actually running, per Track A.3's systemd
// units) and the freshness of what it's actually written to storage (is it
// still making progress). A daemon can be "active" but stuck, or not
// running under systemd at all (started manually) but still writing fresh
// data -- showing both avoids trusting either signal alone.
//
// Track L3 (2026-09-24) added two sections: a background-jobs rollup (from
// Track L1's data/runs/, see src/cli/jobs.ts) and the quality-pool size.

import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runMigrations } from "../storage/migrate";
import { listWalletHealth, getDepthCollectorHealth, countWalletScores, listLatestWalletScores } from "../storage/repository";
import { main as paperReportMain } from "./paperReport";
import { fmtAgo } from "../utils/format";
import { TRACKED_WALLETS } from "../wallets";
import { loadRunsWithState, RUNS_DIR } from "../jobs/systemd";
import { formatRunRow, RUN_ROW_HEADER } from "./jobs";

const execFileAsync = promisify(execFile);

// Async + run via Promise.all at the call site (code-review finding,
// 2026-09-09) -- the track/depth checks are unrelated to each other, so
// there's no reason to pay two sequential subprocess round-trips in a
// command whose whole point is being a quick status check.
async function systemdStatus(unit: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["--user", "is-active", unit]);
    return stdout.trim();
  } catch (err) {
    // is-active exits non-zero for "inactive"/"failed" (still valid output
    // on stdout) as well as genuinely missing systemctl/unit -- distinguish
    // by whether we got stdout at all.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) return stdout.trim();
    return "unknown (systemctl unavailable)";
  }
}

// Quality-pool membership is read from recorded scores, not computed:
// isQualityWallet() (src/scoring/walletScore.ts) needs a fresh score, i.e.
// live, rate-limited /activity pulls -- the same reason wallet-score isn't
// re-run here. Since Track M2 (2026-09-24) the source is the
// `wallet_scores` table: each wallet's latest CONFIRMED row (reproducible
// method, not truncated -- see listConfirmedQualityWallets) with
// is_quality set. Only while that table is still empty (e.g. a DB that
// predates migration 0005 and hasn't had a scoring run since) does this
// fall back to the old convention of "QUALITY WALLET" in wallets.ts
// labels. Negated phrasings ("not a QUALITY WALLET") are excluded so a
// label noting a failed bar isn't counted.
// Display name for a wallet_scores row: its recorded label if that isn't
// just the address, else the wallets.ts name (rows recorded before
// confirm-shallow looked names up only carry the address).
function walletName(address: string, label: string | null): string {
  if (label && label !== address) return `  ${label.split(" ")[0]}`;
  const tracked = TRACKED_WALLETS.find((w) => w.address.toLowerCase() === address.toLowerCase());
  return tracked ? `  ${tracked.label.split(" ")[0]}` : "";
}

export function isLabeledQualityWallet(label: string): boolean {
  return /QUALITY WALLET/.test(label) && !/\bnot\s+(a\s+)?QUALITY WALLET/i.test(label);
}

// How many finished runs to show beneath any running ones.
const RECENT_FINISHED_JOBS = 3;

async function printJobs() {
  const runs = await loadRunsWithState(RUNS_DIR);
  const running = runs.filter((r) => r.state === "running");
  const finished = runs.filter((r) => r.state !== "running").slice(0, RECENT_FINISHED_JOBS);
  if (runs.length === 0) {
    console.log("no job runs yet (`npm run job -- <name> -- <command...>`)");
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  console.log(`${running.length} running, ${runs.length} runs total in data/runs/ -- \`npm run jobs\` for more`);
  console.log(RUN_ROW_HEADER);
  for (const r of [...running, ...finished]) console.log(formatRunRow(r, now));
}

function printQualityPool() {
  if (countWalletScores() === 0) {
    console.log("\n=== quality pool (wallet_scores empty -- falling back to wallets.ts labels; not re-scored here) ===");
    const quality = TRACKED_WALLETS.filter((w) => isLabeledQualityWallet(w.label));
    console.log(`${quality.length} of ${TRACKED_WALLETS.length} wallets in src/wallets.ts labeled QUALITY WALLET`);
    for (const w of quality) console.log(`  ${w.label.split(" ")[0]} (${w.archetype})`);
    return;
  }
  console.log("\n=== quality pool (latest confirmed wallet_scores row per wallet -- not re-scored here) ===");
  const confirmed = listLatestWalletScores({ confirmedOnly: true });
  const quality = confirmed.filter((r) => r.isQuality);
  console.log(`${quality.length} of ${confirmed.length} wallets with a confirmed score pass isQualityWallet`);
  for (const r of quality) {
    const window =
      r.method === "anchored" && r.historyStart !== null
        ? `anchored ${new Date(r.historyStart * 1000).toISOString().slice(0, 10)}`
        : r.method;
    console.log(
      `  ${r.address}  ${r.qualityScore}/100  win ${(r.winRate * 100).toFixed(1)}%  roi ${(r.roi * 100).toFixed(1)}%  ` +
        `${r.distinctEvents} events  [${window}, ${r.historyPages}p, scored ${fmtAgo(r.scoredAt)}]${walletName(r.address, r.label)}`
    );
  }
}

export async function main() {
  runMigrations();

  console.log("=== daemons ===");
  const [trackState, depthState] = await Promise.all([
    systemdStatus("polycopytrade-track.service"),
    systemdStatus("polycopytrade-depth.service"),
  ]);

  const health = listWalletHealth();
  const lastWalletPoll = health.reduce<number | null>((latest, h) => {
    if (h.lastPolledAt === null) return latest;
    return latest === null || h.lastPolledAt > latest ? h.lastPolledAt : latest;
  }, null);
  console.log(`track:daemon    systemd=${trackState}   last wallet poll: ${fmtAgo(lastWalletPoll)}   (${health.length} wallets tracked)`);

  const depth = getDepthCollectorHealth();
  console.log(
    `depth:collector systemd=${depthState}   last snapshot: ${fmtAgo(depth.lastCapturedAt)}   (${depth.totalSnapshots} total snapshots)`
  );

  console.log("\n=== wallet health (unhealthy only — run `npm run wallets:health` for all) ===");
  const unhealthy = health.filter((h) => h.consecutiveFailures > 0 || h.lastPolledAt === null);
  if (unhealthy.length === 0) {
    console.log("all tracked wallets healthy");
  } else {
    for (const h of unhealthy) {
      console.log(`[${h.label}] last polled ${fmtAgo(h.lastPolledAt)} — ${h.consecutiveFailures} consecutive failures`);
    }
  }

  console.log("\n=== background jobs ===");
  await printJobs();

  printQualityPool();

  console.log("\n=== paper trading ===");
  await paperReportMain();

  console.log("\n(wallet-score is not re-run here -- it costs live API calls. Use `npm run wallet-score -- <filter>|all`.)");
}

if (require.main === module) {
  main();
}
