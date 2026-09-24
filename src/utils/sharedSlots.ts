// K2 (2026-09-24): cross-process rate-limit slots. RateLimiter's own
// per-host timer only spaces requests within ONE process -- with 2-3
// research jobs (plus the tracking daemon) running at once, each kept its
// own ~1.1s gap, so the combined rate against one host was 2-3x what any
// one process thought it was sending. Here every process reserves its
// request's time slot in a shared SQLite row per host instead.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// A stored slot this far past "now" can't be a real backlog (that would
// take hundreds of processes queued on one host) -- it's a stale row from
// a skewed clock or a much larger gap in an old build. Treat it as absent
// rather than parking every process behind it.
export const MAX_PLAUSIBLE_BACKLOG_MS = 10 * 60_000;

// Pure slot math: the next request may go at `now`, or one gap after the
// last reserved slot, whichever is later. Reserving a FUTURE slot (rather
// than recording "last call happened now") is what makes N concurrent
// waiters queue up at gap-spaced instants instead of all waking together.
export function nextSlotMs(nowMs: number, lastSlotMs: number | null, gapMs: number): number {
  if (lastSlotMs === null || lastSlotMs > nowMs + MAX_PLAUSIBLE_BACKLOG_MS) return nowMs;
  return Math.max(nowMs, lastSlotMs + gapMs);
}

export interface SlotReserver {
  // Returns the unix-ms instant this request may be sent. Throws if the
  // shared store can't be reached in time -- RateLimiter falls back.
  reserve(key: string, gapMs: number): number;
}

export class SharedSlotStore implements SlotReserver {
  private readonly db: DatabaseSync;
  private readonly selectStmt: StatementSync;
  private readonly upsertStmt: StatementSync;
  private readonly now: () => number;

  constructor(file: string, opts: { busyTimeoutMs?: number; now?: () => number } = {}) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.now = opts.now ?? Date.now;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    // Slots are worthless after a crash anyway, so skip the per-commit
    // fsync -- WAL + NORMAL is still consistent after an application crash.
    this.db.exec("PRAGMA synchronous = NORMAL");
    // Short on purpose: node:sqlite is synchronous, so waiting on the lock
    // blocks this process's event loop. A reservation transaction holds the
    // lock for well under a millisecond; 500ms of contention means
    // something is wrong, and RateLimiter should fall back instead.
    this.db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 500}`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS rate_limit_slots (
      host         TEXT PRIMARY KEY,
      last_slot_ms INTEGER NOT NULL
    )`);
    this.selectStmt = this.db.prepare("SELECT last_slot_ms FROM rate_limit_slots WHERE host = ?");
    this.upsertStmt = this.db.prepare(
      "INSERT INTO rate_limit_slots (host, last_slot_ms) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET last_slot_ms = excluded.last_slot_ms"
    );
  }

  // BEGIN IMMEDIATE takes the write lock up front, so the read-compute-
  // write below is atomic across processes (a plain BEGIN would let two
  // processes read the same last slot, then one fail to upgrade). `now` is
  // read only after the lock is held, so time spent waiting for it can't
  // produce a slot that's already in the past relative to a competitor's.
  reserve(key: string, gapMs: number): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.selectStmt.get(key) as { last_slot_ms: number } | undefined;
      const slot = nextSlotMs(this.now(), row?.last_slot_ms ?? null, gapMs);
      this.upsertStmt.run(key, slot);
      this.db.exec("COMMIT");
      return slot;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back by SQLite (e.g. on SQLITE_FULL) -- the
        // original error is the one worth surfacing
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
