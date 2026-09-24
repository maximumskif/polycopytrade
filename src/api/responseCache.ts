// K1 (2026-09-24): persistent, cross-process cache for API responses that
// src/api/cachePolicy.ts has proven immutable. Before this, every research
// job re-fetched the same settled markets and price histories on every
// re-run (30-40 min jobs paying the full rate-limited cost each time), and
// the only cache was engine.ts's per-process in-memory map.
//
// Storage only -- this module never decides WHAT is cacheable; callers in
// src/api/client.ts consult cachePolicy.ts before calling set(). Its own
// SQLite file (config.apiCachePath), never the daemon's db, so a research
// job's cache writes can't hold the lock the tracking daemon needs.

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openWalDb } from "../utils/openWalDb";

// Two URLs asking the same question must map to one row: params sorted
// (by name, then value), host lower-cased and default port dropped (both
// done by URL itself), fragment ignored. Param VALUES are kept verbatim --
// the API may treat them case-sensitively, and a spurious miss is harmless
// where a spurious hit would not be.
export function normalizeCacheKey(url: string): string {
  const u = new URL(url);
  const params = [...u.searchParams.entries()].sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const qs = new URLSearchParams(params).toString();
  return `${u.protocol}//${u.host}${u.pathname}${qs ? `?${qs}` : ""}`;
}

export interface CachedResponse {
  body: unknown;
  fetchedAt: number; // unix ms
}

export class ApiResponseCache {
  private readonly db: DatabaseSync;
  private readonly getStmt: StatementSync;
  private readonly setStmt: StatementSync;
  private broken = false;

  // ":memory:" for tests -- never touches a real file.
  constructor(file: string) {
    // WAL: concurrent research processes read while one writes.
    // busy_timeout: a writer that finds another process mid-write waits
    // briefly instead of failing -- same lesson as src/storage/db.ts.
    this.db = openWalDb(file, 2000);
    this.db.exec(`CREATE TABLE IF NOT EXISTS api_responses (
      cache_key  TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`);
    this.getStmt = this.db.prepare("SELECT body, fetched_at FROM api_responses WHERE cache_key = ?");
    this.setStmt = this.db.prepare("INSERT OR REPLACE INTO api_responses (cache_key, body, fetched_at) VALUES (?, ?, ?)");
  }

  // A cache failure (disk full, corrupt file, lock held past busy_timeout)
  // must never fail the request it's accelerating: log once, then behave
  // as a permanently-missing cache for the rest of the process.
  private fail(op: string, err: unknown): void {
    if (!this.broken) console.error(`[api-cache] ${op} failed, continuing uncached: ${(err as Error).message}`);
    this.broken = true;
  }

  get(url: string): CachedResponse | null {
    if (this.broken) return null;
    try {
      const row = this.getStmt.get(normalizeCacheKey(url)) as { body: string; fetched_at: number } | undefined;
      return row ? { body: JSON.parse(row.body), fetchedAt: row.fetched_at } : null;
    } catch (err) {
      this.fail("read", err);
      return null;
    }
  }

  set(url: string, body: unknown, fetchedAt: number = Date.now()): void {
    if (this.broken) return;
    try {
      this.setStmt.run(normalizeCacheKey(url), JSON.stringify(body), fetchedAt);
    } catch (err) {
      this.fail("write", err);
    }
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM api_responses").get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
