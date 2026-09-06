// Regression tests for trackDaemon.ts's loop control flow, flagged as
// untested in docs/AUDIT.md §9 ("daemon loop timing, no-overlap behavior,
// signal handling ... a future session should add [tests], likely by
// injecting a fake clock/wallet-poll function rather than actually
// sleeping"). runLoop()/sleepInterruptible() were extracted from main() so
// this behavior can be verified with injected fakes instead of the real
// DB/API/paper-trading calls main() wires up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoop, sleepInterruptible } from "../src/tracking/trackDaemon";

test("runLoop runs cycles sequentially and stops right after the cycle that flips isStopping, without sleeping after it", async () => {
  const events: string[] = [];
  let stopping = false;
  const cycles = await runLoop({
    intervalMs: 100,
    isStopping: () => stopping,
    runCycle: async (cycle) => {
      events.push(`cycle-${cycle}`);
      if (cycle === 3) stopping = true;
    },
    sleep: async () => {
      events.push("sleep");
    },
  });

  assert.equal(cycles, 3);
  assert.deepEqual(events, ["cycle-1", "sleep", "cycle-2", "sleep", "cycle-3"]);
});

test("runLoop never starts a new cycle before the previous cycle's work (and its sleep) has resolved", async () => {
  const events: string[] = [];
  let stopping = false;
  await runLoop({
    intervalMs: 10,
    isStopping: () => stopping,
    runCycle: async (cycle) => {
      events.push(`start-${cycle}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end-${cycle}`);
      if (cycle === 2) stopping = true;
    },
    sleep: async () => {
      events.push("sleep");
    },
  });

  assert.deepEqual(events, ["start-1", "end-1", "sleep", "start-2", "end-2"]);
});

test("runLoop runs zero cycles if isStopping is already true before the first iteration", async () => {
  let runCycleCalls = 0;
  const cycles = await runLoop({
    intervalMs: 100,
    isStopping: () => true,
    runCycle: async () => {
      runCycleCalls++;
    },
    sleep: async () => {},
  });

  assert.equal(cycles, 0);
  assert.equal(runCycleCalls, 0);
});

test("sleepInterruptible waits out the full duration in steps when never told to stop", async () => {
  const started = Date.now();
  await sleepInterruptible(15, () => false, 5);
  assert.ok(Date.now() - started >= 14, "should wait roughly the full duration (allowing tiny scheduling slack)");
});

test("sleepInterruptible stops early, mid-wait, once isStopping flips true", async () => {
  let calls = 0;
  const isStopping = () => {
    calls++;
    return calls >= 3; // false, false, true -- stops after 2 steps instead of running to completion
  };
  await sleepInterruptible(1000, isStopping, 5);
  assert.equal(calls, 3, "should re-check isStopping before every step and exit as soon as it flips, not run all steps");
});

test("sleepInterruptible never waits at all if isStopping is already true", async () => {
  const started = Date.now();
  await sleepInterruptible(1000, () => true, 5);
  assert.ok(Date.now() - started < 50, "should return immediately without entering the wait loop");
});
