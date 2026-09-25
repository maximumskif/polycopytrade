// Track L1 (docs/IMPROVEMENT_PLAN.md): run-directory bookkeeping for the
// background job runner (`npm run job` / `npm run jobs`, src/cli/job.ts and
// src/cli/jobs.ts). Long research jobs (30 min - 3 h of rate-limited API
// pulls) used to run as ad-hoc background shells logging to /tmp -- item
// 40's 3-hour sweep log was lost to a WSL reboot that way. Each run now gets
// a durable directory under data/runs/ holding its output, what was run
// (command + git commit), and how it ended.
//
// Everything here except listRuns()/readRun()/tailFile() (plain fs reads) is
// pure, so naming, parsing and state derivation are unit-testable without
// launching real systemd units (tests/jobs.test.ts).

import fs from "node:fs";
import path from "node:path";

export const RUNS_SUBDIR = path.join("data", "runs");
// Prefix for the transient systemd unit names, so `systemctl --user
// list-units 'pct-job-*'` finds every job-runner unit and nothing else.
export const UNIT_PREFIX = "pct-job-";

export interface RunMeta {
  name: string;
  // Display form of argv (shell-quoted where needed) -- informational only;
  // the unit runs `argv` directly, never through a shell.
  command: string;
  argv: string[];
  cwd: string;
  git: { commit: string | null; dirty: boolean | null };
  startedAt: string; // ISO-8601 UTC
  startedAtEpoch: number; // unix seconds
  unit: string;
  runDir: string;
}

export interface RunExit {
  exitCode: number | null;
  // Set when the wrapper was told to stop (SIGTERM/SIGINT from `systemctl
  // stop` / `npm run job:stop`) rather than the command finishing on its own.
  signal?: string | null;
  endedAt: string;
  endedAtEpoch?: number;
  durationSeconds: number | null;
  // Set by the launcher (not the wrapper) when systemd-run itself failed,
  // so the command never started at all.
  launchError?: string;
}

// "unknown": no exit.json and the unit's state couldn't be queried.
// "lost": no exit.json and the unit is gone -- the wrapper never got to
// record an ending (SIGKILL, OOM kill, `wsl --shutdown`/reboot mid-run).
export type RunState = "running" | "succeeded" | "failed" | "stopped" | "lost" | "unknown";

export interface RunInfo {
  dirName: string;
  dir: string;
  meta: RunMeta;
  exit: RunExit | null;
}

// Prefix of the lines ops/jobs/run-job.sh itself writes to output.log.
export const WRAPPER_LOG_PREFIX = "[run-job] ";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// Job names end up in a directory name and a systemd unit name -- restrict
// to characters that are safe in both without escaping.
export function validateJobName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return `invalid job name "${name}": use 1-64 chars of [A-Za-z0-9_.-], starting with a letter or digit`;
  }
  return null;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

// Local time, not UTC (2026-09-24): the directory name is what a human scans
// in `ls data/runs/`, and this box's clock/`date` are local. The exact UTC
// instant is in meta.json's startedAt. Sort order is by name, so a DST
// fall-back hour can misorder runs by at most an hour -- harmless here.
export function runTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function runDirName(d: Date, name: string, attempt = 0): string {
  const base = `${runTimestamp(d)}-${name}`;
  return attempt === 0 ? base : `${base}-${attempt + 1}`;
}

export function unitNameFor(dirName: string): string {
  // Dir names are already [A-Za-z0-9_.-] plus the timestamp's "T"/"-", all
  // valid in unit names.
  return `${UNIT_PREFIX}${dirName}.service`;
}

// Shell-quote for display only (meta.json's `command`, `npm run jobs`).
export function shellQuote(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

// argv after npm strips its own `--`: `<name> [--] <command...>`. The inner
// `--` is optional but recommended -- without it, npm would try to parse
// flags meant for the command (e.g. `npm run job -- x npm run foo -- --bar`).
export function parseJobArgs(args: string[]): { name: string; argv: string[] } | { error: string } {
  if (args.length === 0) return { error: "missing job name" };
  const [name, ...rest] = args;
  const nameErr = validateJobName(name);
  if (nameErr) return { error: nameErr };
  const argv = rest[0] === "--" ? rest.slice(1) : rest;
  if (argv.length === 0) return { error: "missing command to run" };
  return { name, argv };
}

export function parseMeta(raw: string): RunMeta | null {
  try {
    const m = JSON.parse(raw);
    if (typeof m?.name !== "string" || !Array.isArray(m?.argv) || typeof m?.unit !== "string" || typeof m?.startedAtEpoch !== "number") {
      return null;
    }
    return m as RunMeta;
  } catch {
    return null;
  }
}

export function parseExit(raw: string): RunExit | null {
  try {
    const e = JSON.parse(raw);
    if (e === null || typeof e !== "object" || !("exitCode" in e)) return null;
    return e as RunExit;
  } catch {
    return null;
  }
}

const LIVE_UNIT_STATES = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);

// exit.json is authoritative when present. Without it, the unit's own state
// (`systemctl --user is-active`) decides: a job whose process died without
// writing exit.json must not show as "running" forever just because the
// ending was never recorded. `unitState` null means it couldn't be queried.
export function deriveState(exit: RunExit | null, unitState: string | null): RunState {
  if (exit) {
    if (exit.launchError) return "failed";
    if (exit.signal) return "stopped";
    return exit.exitCode === 0 ? "succeeded" : "failed";
  }
  if (unitState === null) return "unknown";
  return LIVE_UNIT_STATES.has(unitState) ? "running" : "lost";
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "?";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
}

// Duration for display: the recorded duration if finished, elapsed so far if
// running. A lost run has no recorded end, so "now - start" would grow
// forever -- use the output log's last write as the best estimate of when
// it died (null -> "?" if that isn't available either).
export function runDuration(
  meta: RunMeta,
  exit: RunExit | null,
  state: RunState,
  nowEpoch: number,
  logMtimeEpoch?: number | null
): number | null {
  if (exit) return exit.durationSeconds ?? null;
  if (state === "running") return nowEpoch - meta.startedAtEpoch;
  return logMtimeEpoch != null ? logMtimeEpoch - meta.startedAtEpoch : null;
}

// Last non-empty line of a log chunk, as a terminal would show it: progress
// output that redraws with \r keeps only the text after the last \r, and
// ANSI color codes are stripped. The wrapper's own "[run-job] ..."
// start/finish lines are skipped unless the command printed nothing -- the
// ending is already shown via state/exit code, and the command's last words
// (e.g. an error message) are the useful part.
// Lines that are never the useful "last words": node's SQLite
// ExperimentalWarning pair, API retry chatter, and cache stats.
const NOISE_LINE = /ExperimentalWarning|node --trace-warnings|^\[api\]|^\[api-cache\]|^\[rate-limit\]/;
const SUMMARY_LINE = /^Summary:/;
function isNoiseLine(l: string): boolean {
  return NOISE_LINE.test(l.trim());
}

export function lastLogLine(chunk: string, maxLen = 100): string {
  const lines = chunk
    .split("\n")
    .map((l) => {
      const afterCr =
        l
          .split("\r")
          .filter((p) => p.length > 0)
          .pop() ?? "";
      // eslint-disable-next-line no-control-regex
      return afterCr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
    })
    .filter((l) => l.trim().length > 0);
  const own = lines.filter((l) => !l.startsWith(WRAPPER_LOG_PREFIX) && !isNoiseLine(l));
  // A script's own one-line result beats whatever it printed last
  // (2026-09-25, to keep check-ins cheap: `npm run jobs` should answer
  // "what did it find" without opening the log).
  const summary = [...own].reverse().find((l) => SUMMARY_LINE.test(l));
  const last = summary ?? own.pop() ?? lines.pop() ?? "";
  return last.length > maxLen ? `${last.slice(0, maxLen - 1)}…` : last;
}

// Resolve a `--tail`/`job:stop` argument: an exact run directory name (or
// path), else the most recent run with that job name, else the most recent
// run whose directory name starts with it. `runs` must be newest-first.
export function resolveRun(query: string, runs: RunInfo[]): RunInfo | null {
  const base = path.basename(query.replace(/\/+$/, ""));
  return (
    runs.find((r) => r.dirName === base) ?? runs.find((r) => r.meta.name === query) ?? runs.find((r) => r.dirName.startsWith(base)) ?? null
  );
}

// ---- fs helpers (thin, not unit-tested beyond the pure parts above) ----

export function readRun(runsDir: string, dirName: string): RunInfo | null {
  const dir = path.join(runsDir, dirName);
  let meta: RunMeta | null;
  try {
    meta = parseMeta(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
  if (!meta) return null;
  let exit: RunExit | null;
  try {
    exit = parseExit(fs.readFileSync(path.join(dir, "exit.json"), "utf8"));
  } catch {
    exit = null;
  }
  return { dirName, dir, meta, exit };
}

// Local "YYYY-MM-DD HH:MM:SS" for display.
export function fmtLocalTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fileMtimeEpoch(file: string): number | null {
  try {
    return Math.floor(fs.statSync(file).mtimeMs / 1000);
  } catch {
    return null;
  }
}

// Newest first (directory names start with a sortable timestamp).
export function listRuns(runsDir: string): RunInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .map((n) => readRun(runsDir, n))
    .filter((r): r is RunInfo => r !== null);
}

// Last `bytes` of a file (whole file if smaller) -- output logs of multi-hour
// jobs can be large, and only the tail is ever shown.
export function tailFile(file: string, bytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
