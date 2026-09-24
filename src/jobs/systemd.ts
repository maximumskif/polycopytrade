// Track L1: the systemd side of the job runner -- querying transient unit
// state and loading runs with their derived state. Shared by `npm run jobs`
// (src/cli/jobs.ts) and `npm run status` (src/cli/status.ts).

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deriveState, listRuns, RUNS_SUBDIR, type RunInfo, type RunState } from "./runs";

const execFileAsync = promisify(execFile);

// src/jobs/ -> repo root. Runs live under the checkout that launched them
// (a worktree has its own data/runs/).
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const RUNS_DIR = path.join(REPO_ROOT, RUNS_SUBDIR);

// `systemctl --user is-active <unit>` output, or null if systemctl itself
// couldn't be run. Non-zero exit with stdout ("inactive", "failed") is a
// valid answer, same as src/cli/status.ts's systemdStatus(). Units are
// launched with --collect, so a finished one is unloaded and reads
// "inactive".
export async function queryUnitState(unit: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["--user", "is-active", unit]);
    return stdout.trim();
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    return stdout ? stdout.trim() : null;
  }
}

export interface RunWithState extends RunInfo {
  state: RunState;
}

// Only runs without exit.json need a systemctl round-trip; finished runs'
// state comes straight from exit.json.
export async function loadRunsWithState(runsDir = RUNS_DIR, limit?: number): Promise<RunWithState[]> {
  const runs = listRuns(runsDir).slice(0, limit ?? Infinity);
  return Promise.all(
    runs.map(async (r) => ({
      ...r,
      state: deriveState(r.exit, r.exit ? null : await queryUnitState(r.meta.unit)),
    }))
  );
}
