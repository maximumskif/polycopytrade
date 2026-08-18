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
  // WAL still serializes writers -- without a busy_timeout, a writer that
  // finds the db locked by another process's in-flight write fails
  // immediately with SQLITE_BUSY instead of waiting. Found live 2026-08-17:
  // running track:daemon and depth:collector as two separate processes
  // against the same db file crashed track:daemon with "database is
  // locked" within the hour. 5s is comfortably longer than any single
  // write this project does.
  db.exec("PRAGMA busy_timeout = 5000");
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
