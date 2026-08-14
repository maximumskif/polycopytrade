// SQLite connection. Uses node:sqlite (built into Node 22.5+, stable in the
// Node 24 this project runs on) instead of a native-compiled dependency
// like better-sqlite3 — zero added install surface for a project this size.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

// Test seam so storage tests can point every repository function (which all
// call getDb() internally) at a throwaway in-memory database instead of the
// real one — see tests/storage.test.ts.
export function __setDbForTests(customDb: DatabaseSync): void {
  db = customDb;
}
export function __resetDbForTests(): void {
  db = null;
}
