import { test } from "node:test";
import assert from "node:assert/strict";
import { recentlyConfirmed, RESCORE_AFTER_DAYS } from "../src/research/recentlyScored";

test("recentlyConfirmed keeps wallets confirmed within the window, lowercased, and drops older ones", () => {
  const now = 2_000_000_000;
  const rows = [
    { address: "0xAbC", scoredAt: now - 3600 },
    { address: "0xdef", scoredAt: now - RESCORE_AFTER_DAYS * 86400 },
    { address: "0x123", scoredAt: now - (RESCORE_AFTER_DAYS * 86400 + 1) },
  ];
  assert.deepEqual([...recentlyConfirmed(rows, now)].sort(), ["0xabc", "0xdef"]);
});
