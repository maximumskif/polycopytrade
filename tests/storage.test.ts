// Storage-layer tests: migration idempotency and activity deduplication —
// the two properties docs/AUDIT.md §8 flagged as missing from the old
// JSONL tracker. Runs against a throwaway in-memory SQLite database, never
// the real one.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __setDbForTests, __resetDbForTests } from "../src/storage/db";
import { runMigrations } from "../src/storage/migrate";
import {
  upsertWallet,
  insertActivity,
  listTrackedWallets,
  insertWalletScore,
  listLatestWalletScores,
  listConfirmedQualityWallets,
  listWalletScoreHistory,
  countWalletScores,
} from "../src/storage/repository";
import * as m0001 from "../src/storage/migrations/0001_init";
import * as m0002 from "../src/storage/migrations/0002_paper_trading";
import * as m0003 from "../src/storage/migrations/0003_orderbook_snapshots";
import * as m0004 from "../src/storage/migrations/0004_drop_positions";
import type { NewWalletScoreRecord } from "../src/domain/types";
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
  assert.deepEqual(first.applied, [
    "0001_init",
    "0002_paper_trading",
    "0003_orderbook_snapshots",
    "0004_drop_positions",
    "0005_wallet_scores",
  ]);
  assert.deepEqual(second.applied, []);
});

test("migrations create the expected tables", () => {
  runMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  for (const expected of ["wallets", "wallet_activity", "api_errors", "wallet_polls", "paper_orders", "orderbook_snapshots"]) {
    assert.ok(tables.includes(expected), `expected table ${expected} to exist`);
  }
});

// 0004_drop_positions (docs/IMPROVEMENT_PLAN.md Track B.5): the `positions`
// table was write-only dead data (see src/tracking/pollWallet.ts) -- confirm
// the drop migration actually removes it rather than leaving it behind.
test("migrating drops the now-unused positions table", () => {
  runMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  assert.ok(!tables.includes("positions"), "positions table should have been dropped by 0004_drop_positions");
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

// Track M2 (2026-09-24): 0005 must be purely additive -- the live tracking
// daemon's DB (already at 0004, with real data) gets it on merge.
test("0005_wallet_scores applies on a DB already at 0004 without touching existing tables or rows", () => {
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of [m0001, m0002, m0003, m0004]) {
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, 0)").run(m.id);
  }
  upsertWallet(wallet);
  insertActivity(wallet.address, [makeActivity()]);
  const schemaOf = () =>
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name != 'wallet_scores' ORDER BY name")
      .all()
      .map((r: any) => `${r.type}:${r.name}:${r.sql}`);
  const before = schemaOf();

  assert.deepEqual(runMigrations(db).applied, ["0005_wallet_scores"]);
  assert.deepEqual(schemaOf(), before, "no pre-existing table/index definition changed");
  assert.equal(listTrackedWallets().length, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as n FROM wallet_activity").get() as { n: number }).n, 1);
  assert.equal(countWalletScores(), 0);
});

function scoreRow(overrides: Partial<NewWalletScoreRecord> = {}): NewWalletScoreRecord {
  return {
    address: "0xAAA",
    label: "a",
    scoredAt: 1000,
    method: "anchored",
    historyStart: 1782259200,
    historyPages: 40,
    truncated: false,
    qualityScore: 62,
    flags: [],
    distinctEvents: 224,
    winRate: 0.719,
    roi: 0.121,
    netPnl: 1_730_000,
    medianGapSeconds: 7,
    daysSinceLastActivity: 0.5,
    isQuality: true,
    source: "test",
    gitCommit: "deadbeef",
    ...overrides,
  };
}

test("wallet_scores round-trips a row, lowercasing the address", () => {
  runMigrations(db);
  insertWalletScore(scoreRow({ flags: ["one-shot"], medianGapSeconds: null, daysSinceLastActivity: Infinity }));
  const [row] = listWalletScoreHistory("0xaaa");
  assert.equal(row.address, "0xaaa");
  assert.deepEqual(row.flags, ["one-shot"]);
  assert.equal(row.medianGapSeconds, null);
  assert.equal(row.daysSinceLastActivity, null);
  assert.equal(row.truncated, false);
  assert.equal(row.isQuality, true);
  assert.equal(row.gitCommit, "deadbeef");
});

test("wallet_scores CHECK constraints reject an unknown method", () => {
  runMigrations(db);
  assert.throws(() => insertWalletScore(scoreRow({ method: "bogus" as never })));
});

test("confirmed quality pool: latest reproducible, untruncated row per wallet decides", () => {
  runMigrations(db);
  // A: confirmed pass, then a newer SHALLOW fail -- shallow never masks the confirmation.
  insertWalletScore(scoreRow({ address: "0xA" }));
  insertWalletScore(scoreRow({ address: "0xA", method: "shallow", historyStart: null, qualityScore: 30, isQuality: false }));
  // B: confirmed pass, then a newer confirmed FAIL (==50 cap) -- drops out.
  insertWalletScore(scoreRow({ address: "0xB" }));
  insertWalletScore(scoreRow({ address: "0xB", qualityScore: 50, isQuality: false }));
  // C: only a truncated anchored pass -- never counts.
  insertWalletScore(scoreRow({ address: "0xC", truncated: true }));
  // D: full-history pass -- counts.
  insertWalletScore(scoreRow({ address: "0xD", method: "full", historyStart: null, historyPages: 10, qualityScore: 57 }));

  assert.deepEqual(
    listConfirmedQualityWallets().map((r) => r.address),
    ["0xa", "0xd"]
  );
  assert.deepEqual(
    listLatestWalletScores({ confirmedOnly: true }).map((r) => r.address),
    ["0xa", "0xd", "0xb"]
  );
  assert.equal(listLatestWalletScores().find((r) => r.address === "0xa")!.method, "shallow");
  assert.equal(listWalletScoreHistory("0xB").length, 2);
});
