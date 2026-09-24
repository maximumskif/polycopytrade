// Opens (creating if needed) a SQLite file in WAL mode that several
// processes may open at the same instant -- shared by the K1 API cache
// (src/api/responseCache.ts) and K2 rate-limit slots (sharedSlots.ts).
//
// Found by tests/sharedRateLimiter.test.ts's 3-process run (2026-09-24):
// when several processes open a FRESH file together, `PRAGMA journal_mode
// = WAL` can fail with "database is locked" even with busy_timeout set --
// SQLite doesn't run the busy handler for the lock the journal-mode switch
// needs. So the switch is skipped when the file is already WAL (the normal
// case after first creation) and otherwise retried briefly.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const WAL_SWITCH_ATTEMPTS = 40;
const WAL_SWITCH_RETRY_MS = 25;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ":memory:" for tests -- never touches a real file (and can't be WAL,
// which is fine for a single connection).
export function openWalDb(file: string, busyTimeoutMs: number): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (file !== ":memory:") {
      for (let attempt = 1; ; attempt++) {
        try {
          const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
          if (row.journal_mode.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL");
          break;
        } catch (err) {
          if (attempt >= WAL_SWITCH_ATTEMPTS || !/locked|busy/i.test((err as Error).message)) throw err;
          sleepSync(WAL_SWITCH_RETRY_MS);
        }
      }
    }
    // NORMAL sync is crash-consistent in WAL mode (a power loss can drop
    // the last few commits, never corrupt) and skips an fsync per commit --
    // right for both callers, whose rows are a cache and ephemeral slots.
    db.exec("PRAGMA synchronous = NORMAL");
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
