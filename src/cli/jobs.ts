// Track L1 (docs/IMPROVEMENT_PLAN.md): inspect background jobs launched with
// `npm run job` (src/cli/job.ts).
//
//   npm run jobs                          recent runs (default 15; --all, --limit N)
//   npm run jobs -- --tail <name|dir>     a run's recent output (--lines N, default 40)
//   npm run job:stop -- <name|dir>        stop a running job (its most recent run)
//
// <name|dir> is a run directory name, a job name (-> its most recent run),
// or a unique-enough prefix of a directory name.

import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileMtimeEpoch, fmtLocalTime, formatDuration, lastLogLine, resolveRun, runDuration, tailFile } from "../jobs/runs";
import { loadRunsWithState, RUNS_DIR, type RunWithState } from "../jobs/systemd";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

export function formatRunRow(r: RunWithState, nowEpoch: number): string {
  const code = r.exit ? (r.exit.launchError ? "launch-err" : `exit=${r.exit.exitCode}`) : "";
  const log = path.join(r.dir, "output.log");
  const started = fmtLocalTime(r.meta.startedAtEpoch);
  const dur = formatDuration(runDuration(r.meta, r.exit, r.state, nowEpoch, fileMtimeEpoch(log)));
  const last = lastLogLine(tailFile(log, 8192), 70);
  return `${pad(r.meta.name, 18)} ${pad(r.state, 9)} ${pad(code, 10)} ${pad(started, 19)} ${pad(dur, 7)} ${last}`;
}

export const RUN_ROW_HEADER = `${pad("NAME", 18)} ${pad("STATE", 9)} ${pad("EXIT", 10)} ${pad("STARTED", 19)} ${pad("DUR", 7)} LAST LOG LINE`;

async function list(args: string[]) {
  const limit = args.includes("--all") ? undefined : Number(flagValue(args, "--limit") ?? 15);
  const runs = await loadRunsWithState(RUNS_DIR, limit);
  if (runs.length === 0) {
    console.log(`no runs in ${RUNS_DIR} -- start one with: npm run job -- <name> -- <command...>`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  console.log(RUN_ROW_HEADER);
  for (const r of runs) console.log(formatRunRow(r, now));
}

// preferRunning: for job:stop, a job name should match its running run even
// if a newer run of the same name has already finished.
async function resolveOrExit(query: string | undefined, preferRunning = false): Promise<RunWithState> {
  if (!query) {
    console.error("error: missing <name|dir>");
    process.exit(2);
  }
  const runs = await loadRunsWithState(RUNS_DIR);
  const running = preferRunning ? runs.filter((r) => r.state === "running") : [];
  const run = (resolveRun(query, running) ?? resolveRun(query, runs)) as RunWithState | null;
  if (!run) {
    console.error(`error: no run matches "${query}" in ${RUNS_DIR}`);
    process.exit(1);
  }
  return run;
}

async function tail(args: string[]) {
  const run = await resolveOrExit(flagValue(args, "--tail"));
  const lines = Number(flagValue(args, "--lines") ?? 40);
  const log = path.join(run.dir, "output.log");
  const now = Math.floor(Date.now() / 1000);
  console.log(
    `== ${run.dirName}  [${run.state}${run.exit ? `, exit=${run.exit.exitCode}` : ""}, ${formatDuration(runDuration(run.meta, run.exit, run.state, now, fileMtimeEpoch(log)))}]`
  );
  console.log(`== ${run.meta.command}`);
  console.log(`== ${log}\n`);
  const text = tailFile(log, 256 * 1024).replace(/\n$/, "");
  console.log(text.split("\n").slice(-lines).join("\n"));
}

async function stop(args: string[]) {
  const run = await resolveOrExit(flagValue(args, "--stop"), true);
  if (run.state !== "running") {
    console.log(`${run.dirName} is not running (state: ${run.state}) -- nothing to stop`);
    return;
  }
  // systemd SIGTERMs the whole unit cgroup; the wrapper waits for the
  // command to exit and records exit.json with signal=SIGTERM.
  execFileSync("systemctl", ["--user", "stop", run.meta.unit], { stdio: "inherit" });
  console.log(`stopped ${run.meta.unit} (${run.dirName})`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--stop")) return stop(args);
  if (args.includes("--tail")) return tail(args);
  return list(args);
}

if (require.main === module) {
  main();
}
