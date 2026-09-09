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

import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runMigrations } from "../storage/migrate";
import { listWalletHealth, getDepthCollectorHealth } from "../storage/repository";
import { main as paperReportMain } from "./paperReport";
import { fmtAgo } from "../utils/format";

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

  console.log("\n=== paper trading ===");
  await paperReportMain();

  console.log("\n(wallet-score is not re-run here -- it costs live API calls. Use `npm run wallet-score -- <filter>|all`.)");
}

if (require.main === module) {
  main();
}
