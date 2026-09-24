// Child process for tests/sharedRateLimiter.test.ts's multi-process check
// (K2, 2026-09-24). Not a *.test.ts file, so the test glob never runs it
// directly. Waits until a common start instant so every worker contends
// at once, then makes N rate-limited requests to a local stub server and
// prints one JSON line with the instants it actually sent them.
//
//   limiter <url> <n> <startAtMs> <gapMs> <slotFile>
//     the real RateLimiter + SharedSlotStore, at a test-sized gap
//   client <url> <n> <startAtMs>
//     the real src/api/client.ts wiring (1.1s gap, slot file from
//     POLYCOPY_SHARED_RATELIMIT_PATH) via fetchRaw

import { RateLimiter } from "../../src/utils/rateLimiter";
import { SharedSlotStore } from "../../src/utils/sharedSlots";

async function main() {
  const [mode, url, nRaw, startAtRaw, gapRaw, slotFile] = process.argv.slice(2);
  const n = Number(nRaw);
  const delay = Number(startAtRaw) - Date.now();
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));

  const sent: number[] = [];
  if (mode === "limiter") {
    const store = new SharedSlotStore(slotFile);
    const limiter = new RateLimiter(Number(gapRaw), () => store);
    const host = new URL(url).host;
    for (let i = 0; i < n; i++) {
      await limiter.wait(host);
      sent.push(Date.now());
      await fetch(`${url}?pid=${process.pid}&i=${i}`);
    }
  } else {
    const { fetchRaw } = await import("../../src/api/client");
    for (let i = 0; i < n; i++) {
      await fetchRaw(`${url}?pid=${process.pid}&i=${i}`);
      sent.push(Date.now());
    }
  }
  console.log(JSON.stringify({ pid: process.pid, sent }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
