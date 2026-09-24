// Track M3: `npm run watch:check` -- evaluate the research watchlist
// (src/watch/watchlist.ts) against the tracking daemon's DB. Zero API calls.
//
//   npm run watch:check                      # report every entry
//   npm run watch:check -- --run             # also launch each FIRED entry's action via `npm run job`
//   npm run watch:check -- --ack <id>        # mark a FIRED entry handled without running anything
//   npm run watch:check -- --db <path>       # read another DB, opened read-only (e.g. the main checkout's)
//
// DB: `--db` if given (read-only), else DB_PATH / data/polycopytrade.db via
// the shared connection helper. Fired/actioned state: data/watch-state.json
// (POLYCOPY_WATCH_STATE_PATH overrides), keyed by DB path. On-demand only --
// no timer runs this (Track L2 timers are gated on the user's OK).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config/env";
import { getDb } from "../storage/db";
import { REPO_ROOT } from "../jobs/systemd";
import { ackEntry, countLine, DEFAULT_STATE_PATH, evaluateWatchlist, formatResults, runFired, type Launcher } from "../watch/check";
import { loadState, saveState } from "../watch/state";
import { WATCHLIST } from "../watch/watchlist";

// Env a launched job should inherit: systemd-run only passes PATH (see
// src/cli/job.ts), so the shared rate limiter / cache paths a worktree
// session exported (docs/AGENTS.md) would otherwise be dropped.
const FORWARDED_ENV = ["POLYCOPY_SHARED_RATELIMIT_PATH", "POLYCOPY_API_CACHE_PATH", "DB_PATH"];

const launchViaJobRunner: Launcher = (jobName, argv) => {
  const env = FORWARDED_ENV.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
  const cmd = env.length ? ["env", ...env, ...argv] : argv;
  const res = spawnSync("npm", ["run", "--silent", "job", "--", jobName, "--", ...cmd], { cwd: REPO_ROOT, encoding: "utf8" });
  process.stdout.write(res.stdout ?? "");
  if (res.status !== 0) return { ok: false, error: (res.stderr || res.error?.message || `exit ${res.status}`).trim() };
  const runDir = /run dir:\s*(\S+)/.exec(res.stdout ?? "")?.[1];
  return { ok: true, runDir };
};

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: npm run watch:check [-- --run | --ack <id>] [--db <path>]");
  process.exit(2);
}

export function main(args = process.argv.slice(2)) {
  let run = false;
  let ack: string | undefined;
  let dbArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--run") run = true;
    else if (a === "--ack") ack = args[++i] ?? usage("--ack needs an entry id");
    else if (a === "--db") dbArg = args[++i] ?? usage("--db needs a path");
    else if (a === "-h" || a === "--help") usage();
    else usage(`unknown argument "${a}"`);
  }
  if (run && ack) usage("use --run or --ack, not both");

  let db: DatabaseSync;
  let dbPath: string;
  if (dbArg) {
    dbPath = path.resolve(dbArg);
    if (!fs.existsSync(dbPath)) usage(`no database at ${dbPath}`);
    db = new DatabaseSync(dbPath, { readOnly: true });
  } else {
    dbPath = config.dbPath;
    db = getDb();
  }

  const now = Math.floor(Date.now() / 1000);
  const nowIso = new Date(now * 1000).toISOString();
  const state = loadState(DEFAULT_STATE_PATH);
  const before = state.byDb[dbPath] ?? {};
  const evaluated = evaluateWatchlist(WATCHLIST, db, now, before);
  let records = evaluated.records;

  console.log(`=== watchlist: ${WATCHLIST.length} entries, db ${dbPath}${dbArg ? " (read-only)" : ""} ===`);
  for (const line of formatResults(evaluated.results)) console.log(line);
  console.log(`\n${countLine(evaluated.results)}`);

  let exitCode = 0;
  if (ack) {
    const res = ackEntry(evaluated.results, records, ack, nowIso);
    if (res.error) {
      console.error(`--ack: ${res.error}`);
      exitCode = 1;
    } else console.log(`acked ${ack}; it re-fires on the next state change`);
    records = res.records;
  } else if (run) {
    console.log("\n=== --run ===");
    const res = runFired(evaluated.results, records, launchViaJobRunner, nowIso);
    for (const line of res.lines.length ? res.lines : ["nothing FIRED -- nothing launched"]) console.log(line);
    records = res.records;
  } else if (evaluated.results.some((r) => r.status === "FIRED")) {
    console.log("(`-- --run` launches the fired actions as background jobs; `-- --ack <id>` marks one handled)");
  }

  if (JSON.stringify(records) !== JSON.stringify(before)) {
    state.byDb[dbPath] = records;
    saveState(DEFAULT_STATE_PATH, state);
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  main();
}
