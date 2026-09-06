// Migration runner. Migrations are explicit TS modules (not scanned .sql
// files) so the same code works identically under tsx (dev) and after
// `tsc` build (dist/) with no asset-copy step. Add a new phase's tables by
// adding a new numbered module here and appending it to MIGRATIONS — never
// edit an already-applied migration's SQL after the fact.

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import * as m0001 from "./migrations/0001_init";
import * as m0002 from "./migrations/0002_paper_trading";
import * as m0003 from "./migrations/0003_orderbook_snapshots";
import * as m0004 from "./migrations/0004_drop_positions";

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [m0001, m0002, m0003, m0004];

function ensureMigrationsTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

// Idempotent — safe to call on every process start. Applies each
// not-yet-applied migration inside its own transaction so a failure partway
// through one migration's SQL can't leave the schema half-created.
export function runMigrations(db: DatabaseSync = getDb()): { applied: string[] } {
  ensureMigrationsTable(db);
  const already = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((r: any) => r.id as string));

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (already.has(migration.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, Math.floor(Date.now() / 1000));
      db.exec("COMMIT");
      applied.push(migration.id);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${migration.id} failed: ${(err as Error).message}`);
    }
  }
  return { applied };
}

if (require.main === module) {
  const { applied } = runMigrations();
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database already up to date.");
}
