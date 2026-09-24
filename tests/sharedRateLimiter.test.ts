// K2 (2026-09-24): cross-process rate limiting -- slot math
// (src/utils/sharedSlots.ts), RateLimiter's shared path and its fallback,
// and a real 3-process run against a local stub server. Slot files live in
// a temp dir; the real data/api-ratelimit.db is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nextSlotMs, SharedSlotStore, MAX_PLAUSIBLE_BACKLOG_MS } from "../src/utils/sharedSlots";
import { RateLimiter } from "../src/utils/rateLimiter";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "polycopy-slots-"));
}

test("nextSlotMs: now when idle, else one gap after the last reserved slot", () => {
  assert.equal(nextSlotMs(1000, null, 100), 1000, "first ever request goes now");
  assert.equal(nextSlotMs(1000, 500, 100), 1000, "last slot long past");
  assert.equal(nextSlotMs(1000, 900, 100), 1000, "exactly one gap ago");
  assert.equal(nextSlotMs(1000, 950, 100), 1050, "inside the gap -> wait out the rest");
  assert.equal(nextSlotMs(1000, 1300, 100), 1400, "queued behind future reservations");
  assert.equal(nextSlotMs(1000, 1000 + MAX_PLAUSIBLE_BACKLOG_MS + 1, 100), 1000, "implausible future slot ignored");
});

test("SharedSlotStore: consecutive reservations at one instant are spaced by the gap, per host", () => {
  const store = new SharedSlotStore(":memory:", { now: () => 10_000 });
  assert.deepEqual(
    [store.reserve("a", 100), store.reserve("a", 100), store.reserve("b", 100), store.reserve("a", 100)],
    [10_000, 10_100, 10_000, 10_200]
  );
  store.close();
});

test("SharedSlotStore: two handles on one file share slots (the cross-process mechanism)", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "slots.db");
    const a = new SharedSlotStore(file, { now: () => 5_000 });
    const b = new SharedSlotStore(file, { now: () => 5_000 });
    assert.deepEqual([a.reserve("h", 1100), b.reserve("h", 1100), a.reserve("h", 1100)], [5_000, 6_100, 7_200]);
    a.close();
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RateLimiter: sleeps until the shared slot it was given", async () => {
  const slotAt = Date.now() + 80;
  const limiter = new RateLimiter(1100, () => ({ reserve: () => slotAt }));
  await limiter.wait("h");
  assert.ok(Date.now() >= slotAt - 1, "didn't send before its slot");
});

test("RateLimiter: falls back to the in-process gap (logged once) when the slot file is locked", async () => {
  const dir = tempDir();
  const errors: string[] = [];
  const origError = console.error;
  console.error = (msg: string) => errors.push(msg);
  try {
    const file = path.join(dir, "slots.db");
    const store = new SharedSlotStore(file, { busyTimeoutMs: 20 });
    // Another "process" holds the write lock and never lets go.
    const holder = new DatabaseSync(file);
    holder.exec("BEGIN IMMEDIATE");

    const limiter = new RateLimiter(60, () => store);
    const t0 = Date.now();
    await limiter.wait("h");
    await limiter.wait("h");
    await limiter.wait("h");
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 2 * 60 - 2, `in-process gap still enforced (${elapsed}ms)`);
    assert.equal(errors.filter((e) => e.includes("[rate-limit]")).length, 1, "fallback logged once");

    holder.exec("ROLLBACK");
    holder.close();
    store.close();
  } finally {
    console.error = origError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RateLimiter: no shared getter, or a getter returning null, is the plain in-process limiter", async () => {
  for (const limiter of [new RateLimiter(50), new RateLimiter(50, () => null)]) {
    const t0 = Date.now();
    await limiter.wait("h");
    await limiter.wait("h");
    assert.ok(Date.now() - t0 >= 48);
  }
});

// --- real multi-process check --------------------------------------------

interface GapStats {
  count: number;
  min: number;
  median: number;
}
function gapStats(times: number[]): GapStats {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]);
  const byValue = [...gaps].sort((a, b) => a - b);
  return { count: gaps.length, min: byValue[0], median: byValue[Math.floor(byValue.length / 2)] };
}

function runWorker(args: string[]): Promise<{ pid: number; sent: number[] }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(__dirname, "helpers", "rateLimitWorker.ts"), ...args], {
      env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop()!)) : reject(new Error(err))));
  });
}

test("3 concurrent processes sharing one slot file never send closer than the gap", async () => {
  const dir = tempDir();
  const arrivals: number[] = [];
  const server = http.createServer((_req, res) => {
    arrivals.push(Date.now());
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stub`;
    const GAP = 150;
    const N = 6;
    const startAt = Date.now() + 3000; // time for all three tsx children to boot
    const slotFile = path.join(dir, "slots.db");
    const results = await Promise.all([0, 1, 2].map(() => runWorker(["limiter", url, String(N), String(startAt), String(GAP), slotFile])));

    const sent = results.flatMap((r) => r.sent);
    assert.equal(sent.length, 3 * N);
    assert.equal(arrivals.length, 3 * N);
    const s = gapStats(sent);
    const a = gapStats(arrivals);
    console.log(`  multi-process gap=${GAP}ms: sent min=${s.min} median=${s.median}; arrived min=${a.min} median=${a.median}`);
    // Reserved slots are exactly GAP apart; an actual send can only land
    // LATER than its slot (event-loop lag in a busy child), which can
    // shorten the gap to the next process's on-time send. So both bounds
    // get a small lag allowance.
    const span = Math.max(...sent) - Math.min(...sent);
    assert.ok(span >= (3 * N - 1) * GAP - 25, `combined span ${span}ms is shorter than ${3 * N - 1} gaps`);
    assert.ok(s.min >= GAP - 25, `min send gap ${s.min}ms << ${GAP}ms`);
    // Every process really did interleave (not three serial runs).
    const byPid = results.map((r) => [Math.min(...r.sent), Math.max(...r.sent)]);
    assert.ok(Math.max(...byPid.map(([lo]) => lo)) < Math.min(...byPid.map(([, hi]) => hi)), "processes overlapped");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
