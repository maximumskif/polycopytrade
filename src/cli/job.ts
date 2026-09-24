// Track L1 (docs/IMPROVEMENT_PLAN.md): launch a long-running command as a
// transient systemd user unit, so it outlives the terminal / Claude session
// that started it and its output lands in data/runs/ instead of /tmp.
//
//   npm run job -- <name> -- <command...>
//   e.g. npm run job -- sweep -- npm run confirm-shallow -- --from 2026-06-24
//
// See docs/OPERATIONS.md ("Background jobs") and src/jobs/runs.ts.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseJobArgs, runDirName, shellQuote, unitNameFor, type RunExit, type RunMeta } from "../jobs/runs";
import { REPO_ROOT, RUNS_DIR } from "../jobs/systemd";

const WRAPPER = path.join(REPO_ROOT, "ops", "jobs", "run-job.sh");

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// PATH for the unit: systemd doesn't inherit this shell's nvm-sourced PATH
// (same problem ops/systemd/*.service solve with Environment=PATH=). Rather
// than hardcoding the nvm version like those unit files do, put the bin dir
// of the Node running this launcher first -- it's by definition a working
// Node -- then the caller's PATH, so the job sees what an interactive run
// from this shell would.
function jobPath(): string {
  const nodeBin = path.dirname(process.execPath);
  const rest = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter((p) => p && p !== nodeBin);
  return [nodeBin, ...rest].join(":");
}

// mkdir without `recursive` fails if the dir exists -- retry with a suffix so
// two same-name jobs launched in the same second don't share a directory.
function createRunDir(now: Date, name: string): string {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const dirName = runDirName(now, name, attempt);
    try {
      fs.mkdirSync(path.join(RUNS_DIR, dirName));
      return dirName;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("could not allocate a run directory");
}

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: npm run job -- <name> -- <command...>");
  console.error("  e.g. npm run job -- sweep -- npm run source-wallets");
  process.exit(2);
}

export function main(args = process.argv.slice(2)) {
  if (args[0] === "-h" || args[0] === "--help") usage();
  const parsed = parseJobArgs(args);
  if ("error" in parsed) usage(parsed.error);
  const { name, argv } = parsed;

  const now = new Date();
  const dirName = createRunDir(now, name);
  const runDir = path.join(RUNS_DIR, dirName);
  const unit = unitNameFor(dirName);
  const logFile = path.join(runDir, "output.log");

  // Dirty ignores untracked files (2026-09-24): in an Agent worktree the
  // symlinked node_modules is always untracked (`node_modules/` in
  // .gitignore doesn't match a symlink), which would flag every run dirty.
  // What matters for reproducing a run is uncommitted edits to tracked code.
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  const meta: RunMeta = {
    name,
    command: shellQuote(argv),
    argv,
    cwd: REPO_ROOT,
    git: { commit: git(["rev-parse", "HEAD"]), dirty: status === null ? null : status.length > 0 },
    startedAt: now.toISOString(),
    startedAtEpoch: Math.floor(now.getTime() / 1000),
    unit,
    runDir,
  };
  fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  fs.writeFileSync(logFile, "");

  // --collect: unload the unit once it ends even if it failed, so failed
  // jobs don't pile up as failed units needing `reset-failed` -- the run
  // dir is the durable record, not the unit.
  const res = spawnSync(
    "systemd-run",
    [
      "--user",
      "--collect",
      "--quiet",
      `--unit=${unit}`,
      `--description=polycopytrade job ${name} (${dirName})`,
      `--working-directory=${REPO_ROOT}`,
      `--setenv=PATH=${jobPath()}`,
      `--property=StandardOutput=append:${logFile}`,
      `--property=StandardError=append:${logFile}`,
      "/bin/bash",
      WRAPPER,
      runDir,
      "--",
      ...argv,
    ],
    { encoding: "utf8" }
  );

  if (res.status !== 0) {
    const launchError = (res.error?.message ?? res.stderr ?? "").trim() || `systemd-run exited ${res.status}`;
    const exit: RunExit = {
      exitCode: null,
      endedAt: new Date().toISOString(),
      durationSeconds: 0,
      launchError,
    };
    fs.writeFileSync(path.join(runDir, "exit.json"), JSON.stringify(exit, null, 2) + "\n");
    console.error(`failed to launch job: ${launchError}`);
    process.exit(1);
  }

  const rel = path.relative(process.cwd(), runDir) || runDir;
  console.log(`started job "${name}" as ${unit}`);
  console.log(`  run dir: ${rel}`);
  console.log(`  command: ${meta.command}`);
  console.log(`  commit:  ${meta.git.commit?.slice(0, 7) ?? "?"}${meta.git.dirty ? " (dirty)" : ""}`);
  console.log(`follow:  tail -f ${path.join(rel, "output.log")}   |   npm run jobs   |   npm run job:stop -- ${name}`);
}

if (require.main === module) {
  main();
}
