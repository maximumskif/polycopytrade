import { test } from "node:test";
import assert from "node:assert/strict";
import { currentSlotSlug } from "../src/depthShift/snapshotCollector";

test("currentSlotSlug floors to the start of the current 15-minute window", () => {
  // 2026-08-18T01:00:00Z landing exactly on a slot boundary.
  const slotStart = 1787029200;
  assert.equal(currentSlotSlug("btc", slotStart), "btc-updown-15m-1787029200");
  // A few minutes into the same window should floor to the same slug.
  assert.equal(currentSlotSlug("btc", slotStart + 400), "btc-updown-15m-1787029200");
  // One second before the window ends is still the same slug.
  assert.equal(currentSlotSlug("btc", slotStart + 899), "btc-updown-15m-1787029200");
  // The next second rolls over to the next slot.
  assert.equal(currentSlotSlug("btc", slotStart + 900), "btc-updown-15m-" + (slotStart + 900));
});

test("currentSlotSlug is asset-specific", () => {
  const slotStart = 1787029200;
  assert.equal(currentSlotSlug("eth", slotStart), "eth-updown-15m-1787029200");
});
