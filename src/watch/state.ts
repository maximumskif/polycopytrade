// Track M3: fired-state bookkeeping and the re-arm rule for watch entries.
//
// Rule: an entry fires once per state. When `watch:check --run` launches an
// entry's action (or `--ack <id>` marks a human-review entry handled), the
// measurement's stateKey is recorded. While the condition stays met with
// the SAME stateKey, the entry shows "actioned", not FIRED, so it doesn't
// re-fire on every check. It fires again when:
//   - the condition stops being met and later becomes met again (a real
//     "not met" measurement deletes the record -- re-armed), or
//   - it is met with a DIFFERENT stateKey (e.g. the quality pool changed
//     membership again: the key is the sorted member list).
// Threshold conditions use a constant key ("met"), so they fire once per
// crossing. An evaluation error or a no-data measurement never re-arms: a
// missing/fresh DB must not make every entry fire again later.
//
// State lives in data/watch-state.json (gitignored), keyed by DB path so
// checking another checkout's DB with `--db` doesn't mix records. Plain
// checks only write it to re-arm; `--run`/`--ack` add records.

import fs from "node:fs";
import path from "node:path";
import type { Measurement } from "./conditions";

export interface ActionRecord {
  stateKey: string;
  actionedAt: string; // ISO-8601
  how: "run" | "ack";
  runDir?: string;
}

export interface WatchState {
  version: 1;
  // db path -> entry id -> record
  byDb: Record<string, Record<string, ActionRecord>>;
}

export type WatchStatus = "not-yet" | "FIRED" | "actioned" | "error";

export function emptyState(): WatchState {
  return { version: 1, byDb: {} };
}

export function loadState(file: string): WatchState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === 1 && parsed.byDb && typeof parsed.byDb === "object") return parsed as WatchState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`warning: ignoring unreadable ${file}: ${(err as Error).message}`);
  }
  return emptyState();
}

export function saveState(file: string, state: WatchState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// Pure: status for one entry and whether its record should be dropped.
export function decide(measurement: Measurement | null, record: ActionRecord | undefined): { status: WatchStatus; rearm: boolean } {
  if (measurement === null) return { status: "error", rearm: false };
  if (!measurement.met) return { status: "not-yet", rearm: record !== undefined && !measurement.noData };
  if (record && record.stateKey === measurement.stateKey) return { status: "actioned", rearm: false };
  return { status: "FIRED", rearm: false };
}
