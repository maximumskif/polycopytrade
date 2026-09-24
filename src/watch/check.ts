// Track M3: evaluate the watchlist, render the report, and act on fired
// entries. Pure apart from the injected DB and launcher, so tests drive it
// with an in-memory DB and a fake launcher (tests/watch.test.ts). The CLI
// is src/cli/watchCheck.ts; `npm run status` prints watchSummaryLines().

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { shellQuote } from "../jobs/runs";
import { REPO_ROOT } from "../jobs/systemd";
import { evaluateCondition, type Measurement } from "./conditions";
import { decide, loadState, type ActionRecord, type WatchStatus } from "./state";
import { WATCHLIST, type WatchEntry } from "./watchlist";

export const DEFAULT_STATE_PATH = process.env.POLYCOPY_WATCH_STATE_PATH
  ? path.resolve(process.env.POLYCOPY_WATCH_STATE_PATH)
  : path.join(REPO_ROOT, "data", "watch-state.json");

export interface WatchResult {
  entry: WatchEntry;
  status: WatchStatus;
  measurement: Measurement | null;
  error?: string;
  record?: ActionRecord;
}

export function jobNameFor(entry: WatchEntry): string {
  return `watch-${entry.id}`;
}

// Evaluates every entry. Returns the results plus the records to keep
// (re-armed entries dropped); the caller decides whether to persist them.
export function evaluateWatchlist(
  entries: WatchEntry[],
  db: DatabaseSync,
  now: number,
  records: Record<string, ActionRecord>
): { results: WatchResult[]; records: Record<string, ActionRecord> } {
  const next = { ...records };
  const results = entries.map((entry): WatchResult => {
    let measurement: Measurement | null = null;
    let error: string | undefined;
    try {
      measurement = evaluateCondition(entry.condition, { db, now });
    } catch (err) {
      error = (err as Error).message;
    }
    const { status, rearm } = decide(measurement, records[entry.id]);
    if (rearm) delete next[entry.id];
    return { entry, status, measurement, error, record: next[entry.id] };
  });
  return { results, records: next };
}

function statusLabel(r: WatchResult): string {
  return { "not-yet": "not-yet", FIRED: "FIRED", actioned: "fired (actioned)", error: "ERROR" }[r.status];
}

function actionLine(entry: WatchEntry): string {
  return entry.action ? `npm run job -- ${jobNameFor(entry)} -- ${shellQuote(entry.action)}` : "(human review -- see note)";
}

export function formatResults(results: WatchResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const m = r.measurement;
    lines.push(`[${statusLabel(r)}] ${r.entry.id}  (${r.entry.planRef})`);
    lines.push(`    ${r.entry.description}`);
    if (m) lines.push(`    now: ${m.value}   need: ${m.threshold}`);
    if (r.error) lines.push(`    error: ${r.error}`);
    for (const d of m?.details ?? []) lines.push(`    - ${d}`);
    if (r.status === "FIRED") {
      lines.push(`    action: ${actionLine(r.entry)}`);
      if (r.entry.note) lines.push(`    note: ${r.entry.note}`);
    } else if (r.status === "actioned" && r.record) {
      lines.push(
        `    actioned ${r.record.actionedAt.slice(0, 16).replace("T", " ")} by ${r.record.how === "run" ? `--run${r.record.runDir ? ` (${r.record.runDir})` : ""}` : "--ack"}; re-fires on the next state change`
      );
    }
  }
  return lines;
}

export function countLine(results: WatchResult[]): string {
  const n = (s: WatchStatus) => results.filter((r) => r.status === s).length;
  return `${results.length} watches: ${n("FIRED")} FIRED, ${n("error")} error, ${n("actioned")} actioned, ${n("not-yet")} not-yet`;
}

// For `npm run status`: the count plus only the entries needing attention.
export function watchSummaryLines(results: WatchResult[]): string[] {
  const lines = [countLine(results)];
  for (const r of results) {
    if (r.status === "FIRED")
      lines.push(`  FIRED  ${r.entry.id}: ${r.measurement?.value} (need ${r.measurement?.threshold}) -> ${actionLine(r.entry)}`);
    if (r.status === "error") lines.push(`  ERROR  ${r.entry.id}: ${r.error}`);
  }
  return lines;
}

export type Launcher = (jobName: string, argv: string[]) => { ok: true; runDir?: string } | { ok: false; error: string };

// `--run`: launch each FIRED entry's action through the job runner and
// record it (so it won't fire again for the same state). Entries without an
// action are left FIRED for a human (`--ack`). A failed launch records
// nothing, so the entry stays FIRED and the next --run retries.
export function runFired(
  results: WatchResult[],
  records: Record<string, ActionRecord>,
  launch: Launcher,
  nowIso: string
): { records: Record<string, ActionRecord>; lines: string[] } {
  const next = { ...records };
  const lines: string[] = [];
  for (const r of results) {
    if (r.status !== "FIRED" || !r.measurement) continue;
    if (!r.entry.action) {
      lines.push(`${r.entry.id}: no command (human review) -- left FIRED; \`npm run watch:check -- --ack ${r.entry.id}\` once handled`);
      continue;
    }
    const res = launch(jobNameFor(r.entry), r.entry.action);
    if (res.ok) {
      next[r.entry.id] = {
        stateKey: r.measurement.stateKey,
        actionedAt: nowIso,
        how: "run",
        ...(res.runDir ? { runDir: res.runDir } : {}),
      };
      lines.push(`${r.entry.id}: launched ${jobNameFor(r.entry)}${res.runDir ? ` (${res.runDir})` : ""}`);
    } else {
      lines.push(`${r.entry.id}: launch FAILED, not recorded: ${res.error}`);
    }
  }
  return { records: next, lines };
}

// `--ack <id>`: mark the entry's current fired state handled without
// running anything. Only a FIRED entry can be acked.
export function ackEntry(
  results: WatchResult[],
  records: Record<string, ActionRecord>,
  id: string,
  nowIso: string
): { records: Record<string, ActionRecord>; error?: string } {
  const r = results.find((x) => x.entry.id === id);
  if (!r) return { records, error: `no watch entry "${id}"` };
  if (r.status !== "FIRED" || !r.measurement) return { records, error: `"${id}" is ${r.status}, not FIRED -- nothing to ack` };
  return { records: { ...records, [id]: { stateKey: r.measurement.stateKey, actionedAt: nowIso, how: "ack" } } };
}

// The `npm run status` section. Never throws: a broken watchlist must not
// take the status command down with it. Read-only (no re-arm write).
export function printWatchSummary(db: DatabaseSync, dbPath: string): void {
  console.log("\n=== watchlist (fired/errored only -- `npm run watch:check` for all) ===");
  try {
    const records = loadState(DEFAULT_STATE_PATH).byDb[dbPath] ?? {};
    const { results } = evaluateWatchlist(WATCHLIST, db, Math.floor(Date.now() / 1000), records);
    for (const line of watchSummaryLines(results)) console.log(line);
  } catch (err) {
    console.log(`watchlist check failed: ${(err as Error).message}`);
  }
}
