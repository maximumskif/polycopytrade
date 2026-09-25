// Track L2 (2026-09-24): weekly sourcing, run by
// ops/systemd/polycopytrade-source.timer through `npm run job`: the
// early-movers channel over the 600 largest recently settled markets
// (added 2026-09-25, item 62), then a holders pass on one gamma
// tag per ISO-ish week (days since epoch / 7, mod the list), so each
// category comes around every ROTATION.length weeks with fresh holders.
// source-wallets-holders already auto-confirms shallow passes (M1), records
// every score (M2), and skips wallets confirmed in the last 14 days, so an
// unattended run needs no human steps; results land in `npm run status`.
//
// Usage: npm run source-rotate [-- --tag=<override>] [-- --dry-run]

import { spawnSync } from "node:child_process";

// Gamma tag slugs, all eight verified live against /events?tag_slug= on
// 2026-09-24 (each returned 15 active events).
export const ROTATION = ["soccer", "nfl", "mlb", "tennis", "nba", "esports", "politics", "crypto"] as const;

export function tagForWeek(nowMs: number): string {
  const week = Math.floor(nowMs / (7 * 86400 * 1000));
  return ROTATION[week % ROTATION.length];
}

function main() {
  const override = process.argv.find((a) => a.startsWith("--tag="))?.slice("--tag=".length);
  const tag = override ?? tagForWeek(Date.now());
  console.log(`source-rotate: this week's tag is "${tag}"${override ? " (override)" : ""}`);
  console.log("source-rotate: early movers first (item 62: the only channel that has produced a quality wallet since item 41)");
  if (process.argv.includes("--dry-run")) return;
  // Both run even if one fails; the job's exit code reports the worst.
  const early = spawnSync("npm", ["run", "-s", "source-early-movers", "--", "--markets=600"], { stdio: "inherit" });
  const holders = spawnSync("npm", ["run", "-s", "source-wallets-holders", "--", `--tag=${tag}`], { stdio: "inherit" });
  process.exit(Math.max(early.status ?? 1, holders.status ?? 1));
}

if (require.main === module) main();
