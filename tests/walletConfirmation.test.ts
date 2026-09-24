// Track M1/M2 (2026-09-24): the pure parts of the screen -> confirm ->
// record pipeline (anchor rule, truncation, verdict classification incl.
// the ==50 profitability-cap case, row mapping), plus the retry
// orchestration with fake network deps and an in-memory DB for recording.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __setDbForTests, __resetDbForTests } from "../src/storage/db";
import { runMigrations } from "../src/storage/migrate";
import { listWalletScoreHistory } from "../src/storage/repository";
import {
  CONFIRM_HISTORY_PAGES,
  CONFIRM_HISTORY_START,
  RETRY_LOOKBACK_DAYS,
  classifyConfirmation,
  confirmWallet,
  formatWalletsTsEntry,
  isTruncated,
  newestTimestamp,
  nextRetryAnchor,
  qualityFailureReason,
  retryAnchorFor,
  screenAndConfirm,
  toWalletScoreRecord,
  type ConfirmDeps,
  type ScoringAttempt,
} from "../src/research/walletConfirmation";
import type { WalletFlag, WalletScore } from "../src/domain/types";
import type { TrackedWallet } from "../src/wallets";

const DAY = 86400;
const utc = (s: string) => Date.parse(`${s}T00:00:00Z`) / 1000;

function makeScore(overrides: Partial<WalletScore> = {}): WalletScore {
  return {
    address: "0xABC",
    label: "w",
    flags: [],
    distinctEvents: 100,
    activitySpanDays: 60,
    daysSinceLastActivity: 1,
    concentrationTopEventShare: 0.1,
    profitConcentrationTopEventShare: 0.1,
    profitConcentrationTop3EventShare: 0.2,
    electionShare: 0,
    medianGapSeconds: 30,
    consistencyScore: 0.6,
    netPnl: 1000,
    roi: 0.1,
    winRate: 0.6,
    qualityScore: 62,
    qualityScoreComponents: {
      roiLowerBound: 0.6,
      riskAdjustedReturn: 0.6,
      consistency: 0.6,
      profitConcentration: 0.9,
      drawdown: 0.8,
      sampleSize: 1,
    },
    strategyResult: {} as WalletScore["strategyResult"],
    ...overrides,
  };
}

function attempt(overrides: Partial<ScoringAttempt> = {}, score: Partial<WalletScore> = {}): ScoringAttempt {
  return {
    method: "anchored",
    historyStart: CONFIRM_HISTORY_START,
    historyPages: CONFIRM_HISTORY_PAGES,
    truncated: false,
    fills: 500,
    score: makeScore(score),
    ...overrides,
  };
}

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  __setDbForTests(db);
  runMigrations(db);
});
afterEach(() => {
  db.close();
  __resetDbForTests();
});

// --- anchor rule ---

test("retryAnchorFor snaps (newest activity - 30d) down to the 1st or 16th, UTC midnight", () => {
  assert.equal(retryAnchorFor(utc("2026-09-24") + 3600), utc("2026-08-16")); // -30d = 08-25 -> 16th
  assert.equal(retryAnchorFor(utc("2026-09-10")), utc("2026-08-01")); // -30d = 08-11 -> 1st
  assert.equal(retryAnchorFor(utc("2026-09-15")), utc("2026-08-16")); // -30d = 08-16 exactly
  assert.equal(retryAnchorFor(utc("2026-03-02")), utc("2026-01-16")); // crosses a month boundary
});

test("retryAnchorFor always lands 30-46 days before the newest activity", () => {
  for (let ts = utc("2026-01-01"); ts < utc("2027-01-01"); ts += 7 * 3600) {
    const anchor = retryAnchorFor(ts);
    assert.ok(anchor <= ts - RETRY_LOOKBACK_DAYS * DAY, `too recent for ${ts}`);
    assert.ok(anchor > ts - 47 * DAY, `too old for ${ts}`);
    assert.equal(anchor % DAY, 0);
  }
});

test("nextRetryAnchor only ever moves later", () => {
  assert.equal(nextRetryAnchor(CONFIRM_HISTORY_START, null), null);
  assert.equal(nextRetryAnchor(CONFIRM_HISTORY_START, utc("2026-09-24")), utc("2026-08-16"));
  // A caller-supplied anchor already later than the rule's -> no retry.
  assert.equal(nextRetryAnchor(utc("2026-09-01"), utc("2026-09-24")), null);
  assert.equal(nextRetryAnchor(utc("2026-08-16"), utc("2026-09-24")), null);
});

// --- truncation ---

test("isTruncated: pull ended before the wallet's newest activity", () => {
  assert.equal(isTruncated(null, null), false); // no activity at all
  assert.equal(isTruncated(100, 100), false);
  assert.equal(isTruncated(100, 150), false);
  assert.equal(isTruncated(100, 99), true);
  assert.equal(isTruncated(100, null), true); // wallet active, pull empty
  assert.equal(newestTimestamp([{ timestamp: 5 }, { timestamp: 9 }, { timestamp: 7 }]), 9);
  assert.equal(newestTimestamp([]), null);
});

// --- verdict classification ---

test("qualityFailureReason: == cap is called out as the cap, > cap passes", () => {
  assert.equal(qualityFailureReason({ flags: [], qualityScore: 51 }), null);
  assert.match(qualityFailureReason({ flags: [], qualityScore: 50 })!, /profitability-floor cap/);
  assert.match(qualityFailureReason({ flags: [], qualityScore: 42 })!, /qualityScore=42 <= 50/);
  assert.match(qualityFailureReason({ flags: ["uncopyable-high-frequency"], qualityScore: 80 })!, /vetoed: uncopyable-high-frequency/);
});

test("classifyConfirmation: untruncated pass is confirmed; ==50 fails confirmation", () => {
  assert.equal(classifyConfirmation([attempt()]).kind, "confirmed-quality");
  const capped = classifyConfirmation([attempt({}, { qualityScore: 50 })]);
  assert.equal(capped.kind, "failed-confirmation");
  assert.ok("reason" in capped && /cap/.test(capped.reason));
  assert.equal(classifyConfirmation([attempt({}, { flags: ["one-shot"] })]).kind, "failed-confirmation");
});

test("classifyConfirmation: a truncated final attempt is unconfirmed even with a passing score", () => {
  const v = classifyConfirmation([
    attempt({ truncated: true }, { qualityScore: 80, flags: ["dormant"] }),
    attempt({ truncated: true, historyStart: utc("2026-08-16") }, { qualityScore: 80, flags: ["dormant", "uncopyable-high-frequency"] }),
  ]);
  assert.equal(v.kind, "unconfirmed-truncated");
  assert.ok("reason" in v);
  assert.match(v.reason, /2026-06-24 and 2026-08-16/);
  assert.match(v.reason, /uncopyable-high-frequency/);
  assert.doesNotMatch(v.reason, /dormant/); // truncation artifact, not information
});

test("classifyConfirmation: truncated first attempt + untruncated retry is decided by the retry", () => {
  const v = classifyConfirmation([attempt({ truncated: true }, { qualityScore: 20 }), attempt({ historyStart: utc("2026-08-16") })]);
  assert.equal(v.kind, "confirmed-quality");
  assert.equal(v.attempt.historyStart, utc("2026-08-16"));
});

test("classifyConfirmation refuses a shallow screen", () => {
  assert.throws(() => classifyConfirmation([attempt({ method: "shallow", historyStart: null })]));
});

// --- confirmWallet retry orchestration (fake network) ---

function fakeDeps(latestTs: number | null, pulls: { newest: number | null; score?: Partial<WalletScore> }[]) {
  const calls: TrackedWallet[] = [];
  const deps: ConfirmDeps = {
    getLatestActivityTs: async () => latestTs,
    scoreAnchored: async (wallet) => {
      const pull = pulls[calls.length];
      calls.push(wallet);
      return {
        score: makeScore({ address: wallet.address, ...pull.score }),
        activity: pull.newest === null ? [] : [{ timestamp: pull.newest }],
      };
    },
  };
  return { deps, calls };
}

test("confirmWallet: no retry when the first anchored pull reaches the present", async () => {
  const latest = utc("2026-09-24");
  const { deps, calls } = fakeDeps(latest, [{ newest: latest }]);
  const { verdict, attempts } = await confirmWallet({ address: "0xa", label: "a" }, { deps });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].historyStart, CONFIRM_HISTORY_START);
  assert.equal(calls[0].historyPages, CONFIRM_HISTORY_PAGES);
  assert.equal(attempts.length, 1);
  assert.equal(verdict.kind, "confirmed-quality");
});

test("confirmWallet: truncated -> exactly one retry from the pinned rule's anchor", async () => {
  const latest = utc("2026-09-24");
  const { deps, calls } = fakeDeps(latest, [{ newest: utc("2026-07-10") }, { newest: latest, score: { qualityScore: 50 } }]);
  const seen: ScoringAttempt[] = [];
  const { verdict } = await confirmWallet({ address: "0xa", label: "a" }, { deps, onAttempt: (a) => seen.push(a) });
  assert.deepEqual(
    calls.map((c) => c.historyStart),
    [CONFIRM_HISTORY_START, utc("2026-08-16")]
  );
  assert.deepEqual(
    seen.map((a) => a.truncated),
    [true, false]
  );
  assert.equal(verdict.kind, "failed-confirmation"); // retry reached present, but 50 is the cap
});

test("confirmWallet: still truncated after the retry -> unconfirmed, no third pull", async () => {
  const latest = utc("2026-09-24");
  const { deps, calls } = fakeDeps(latest, [{ newest: utc("2026-07-01") }, { newest: utc("2026-08-30") }, { newest: latest }]);
  const { verdict } = await confirmWallet({ address: "0xa", label: "a" }, { deps });
  assert.equal(calls.length, 2);
  assert.equal(verdict.kind, "unconfirmed-truncated");
});

test("confirmWallet: explicit later --from with no later retry anchor -> single attempt", async () => {
  const latest = utc("2026-09-24");
  const { deps, calls } = fakeDeps(latest, [{ newest: utc("2026-09-05") }]);
  const { verdict } = await confirmWallet({ address: "0xa", label: "a" }, { deps, historyStart: utc("2026-09-01") });
  assert.equal(calls.length, 1);
  assert.equal(verdict.kind, "unconfirmed-truncated");
});

// --- screenAndConfirm (sourcing pipeline) ---

const candidate = { address: "0xCand", label: "cand (test)", provenance: "test" };
const quiet = () => {};

test("screenAndConfirm: a shallow ==50 is screened out, never confirmed", async () => {
  const { deps, calls } = fakeDeps(utc("2026-09-24"), []);
  const o = await screenAndConfirm(
    candidate,
    attempt({ method: "shallow", historyStart: null, historyPages: 4 }, { address: candidate.address, qualityScore: 50 }),
    {
      source: "t",
      deps,
      log: quiet,
    }
  );
  assert.equal(o.kind, "screened-out");
  assert.match(o.reason!, /cap/);
  assert.equal(calls.length, 0);
  assert.equal(listWalletScoreHistory("0xcand").length, 1); // the screen itself is recorded
});

test("screenAndConfirm: a shallow pass is auto-confirmed and every attempt recorded", async () => {
  const latest = utc("2026-09-24");
  const { deps } = fakeDeps(latest, [{ newest: utc("2026-07-01") }, { newest: latest, score: { qualityScore: 58 } }]);
  const o = await screenAndConfirm(
    candidate,
    attempt({ method: "shallow", historyStart: null, historyPages: 4 }, { address: candidate.address, qualityScore: 71 }),
    {
      source: "t",
      deps,
      log: quiet,
    }
  );
  assert.equal(o.kind, "confirmed-quality");
  assert.equal(o.decidingAttempt!.historyStart, utc("2026-08-16"));
  const rows = listWalletScoreHistory("0xCAND");
  assert.deepEqual(
    rows.map((r) => [r.method, r.truncated, r.historyStart, r.source]),
    [
      ["shallow", false, null, "t"],
      ["anchored", true, CONFIRM_HISTORY_START, "t (auto-confirm)"],
      ["anchored", false, utc("2026-08-16"), "t (auto-confirm)"],
    ]
  );
  assert.ok(formatWalletsTsEntry({ ...o, attempt: o.decidingAttempt! }).includes(`historyStart: ${utc("2026-08-16")}`));
});

test("screenAndConfirm: a full, untruncated pass needs no confirmation", async () => {
  const { deps, calls } = fakeDeps(utc("2026-09-24"), []);
  const o = await screenAndConfirm(candidate, attempt({ method: "full", historyStart: null, historyPages: 10 }), {
    source: "t",
    deps,
    log: quiet,
  });
  assert.equal(o.kind, "confirmed-quality");
  assert.equal(calls.length, 0);
});

// --- row mapping + wallets.ts entry ---

test("toWalletScoreRecord maps Infinity to null, lowercases, and applies isQualityWallet", () => {
  const r = toWalletScoreRecord(
    attempt({ truncated: true }, { medianGapSeconds: Infinity, daysSinceLastActivity: Infinity, qualityScore: 50 }),
    {
      source: "s",
      label: "L",
      scoredAt: 123,
      gitCommit: "abc",
    }
  );
  assert.equal(r.address, "0xabc");
  assert.equal(r.medianGapSeconds, null);
  assert.equal(r.daysSinceLastActivity, null);
  assert.equal(r.isQuality, false); // ==50 is the cap
  assert.equal(r.truncated, true);
  assert.deepEqual(
    [r.method, r.historyStart, r.historyPages, r.scoredAt, r.gitCommit, r.label],
    ["anchored", CONFIRM_HISTORY_START, 40, 123, "abc", "L"]
  );
  const flags: WalletFlag[] = ["one-shot"];
  assert.deepEqual(toWalletScoreRecord(attempt({}, { flags }), { source: "s" }).flags, flags);
  assert.equal(toWalletScoreRecord(attempt({}, { qualityScore: 51 }), { source: "s" }).isQuality, true);
});

test("formatWalletsTsEntry is a pasteable TrackedWallet with the pinned anchor and QUALITY WALLET label", () => {
  const entry = formatWalletsTsEntry({
    address: "0xabc",
    label: 'ndb1 "x"',
    provenance: "src",
    attempt: attempt(),
    confirmedAt: utc("2026-09-24"),
  });
  assert.match(entry, /address: "0xabc",/);
  assert.match(entry, /historyPages: 40,/);
  assert.match(entry, new RegExp(`historyStart: ${CONFIRM_HISTORY_START}, // 2026-06-24`));
  assert.match(entry, /QUALITY WALLET"/);
  assert.match(entry, /ndb1 \\"x\\"/); // JSON-escaped
  // Full pulls have no anchor line.
  assert.doesNotMatch(
    formatWalletsTsEntry({ address: "0x1", label: "f", provenance: "p", attempt: attempt({ method: "full", historyStart: null }) }),
    /historyStart/
  );
});
