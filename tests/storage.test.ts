// Storage-layer tests: migration idempotency and activity deduplication —
// the two properties docs/AUDIT.md §8 flagged as missing from the old
// JSONL tracker. Runs against a throwaway in-memory SQLite database, never
// the real one.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __setDbForTests, __resetDbForTests } from "../src/storage/db";
import { runMigrations } from "../src/storage/migrate";
import { upsertWallet, insertActivity, listTrackedWallets } from "../src/storage/repository";
import type { Activity } from "../src/api/schemas";
import type { TrackedWallet } from "../src/wallets";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  __setDbForTests(db);
  // Tests that assert on migration behavior itself run against a fresh,
  // unmigrated db and call runMigrations() explicitly; every other test
  // needs the schema to already exist.
});

afterEach(() => {
  db.close();
  __resetDbForTests();
});

const wallet: TrackedWallet = {
  address: "0xabc",
  label: "test wallet",
  archetype: "unclassified",
  source: "test",
};

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    timestamp: 1000,
    conditionId: "c1",
    type: "TRADE",
    size: 10,
    usdcSize: 5,
    price: 0.5,
    side: "BUY",
    outcome: "Yes",
    title: "t",
    slug: "s",
    proxyWallet: wallet.address,
    transactionHash: "tx-1",
    ...overrides,
  };
}

test("running migrations twice is a no-op the second time", () => {
  const first = runMigrations(db);
  const second = runMigrations(db);
  assert.deepEqual(first.applied, ["0001_init", "0002_paper_trading"]);
  assert.deepEqual(second.applied, []);
});

test("migrations create the expected tables", () => {
  runMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  for (const expected of ["wallets", "wallet_activity", "positions", "api_errors", "wallet_polls", "paper_orders"]) {
    assert.ok(tables.includes(expected), `expected table ${expected} to exist`);
  }
});

test("upsertWallet is idempotent and updates mutable fields", () => {
  runMigrations(db);
  upsertWallet(wallet);
  upsertWallet({ ...wallet, label: "renamed" });
  const rows = listTrackedWallets();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "renamed");
});

test("insertActivity deduplicates identical fills across repeated ingestion", () => {
  runMigrations(db);
  upsertWallet(wallet);
  const rows = [makeActivity({ transactionHash: "tx-1" }), makeActivity({ transactionHash: "tx-2" })];

  const firstInsert = insertActivity(wallet.address, rows);
  const secondInsert = insertActivity(wallet.address, rows); // re-ingesting the same page

  assert.equal(firstInsert, 2, "both rows are new the first time");
  assert.equal(secondInsert, 0, "both rows are duplicates the second time");

  const count = db.prepare("SELECT COUNT(*) as n FROM wallet_activity WHERE wallet_address = ?").get(wallet.address) as { n: number };
  assert.equal(count.n, 2, "no duplicate rows were stored");
});

test("insertActivity treats a genuinely different fill (different price) as new, not a duplicate", () => {
  runMigrations(db);
  upsertWallet(wallet);
  insertActivity(wallet.address, [makeActivity({ transactionHash: "tx-1", price: 0.5 })]);
  const inserted = insertActivity(wallet.address, [makeActivity({ transactionHash: "tx-1", price: 0.6 })]);
  assert.equal(inserted, 1, "same tx hash but a different price is a distinct fill, not a duplicate");
});
