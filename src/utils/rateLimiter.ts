// Per-key (per-API-host) minimum-gap rate limiter. Each host gets its own
// timer so a burst of calls to gamma-api doesn't block calls to data-api
// behind it — see docs/AUDIT.md §10 ("Separate rate limits by API host").
//
// K2 (2026-09-24): optionally backed by a cross-process SlotReserver
// (src/utils/sharedSlots.ts) so the gap holds across every process sharing
// one slot file, not just within this one. wait(key) is unchanged for
// callers. If the shared store is unavailable or locked past its short
// busy timeout, this falls back to the in-process timer (logged once) and
// retries the shared store after SHARED_RETRY_AFTER_MS -- a broken slot
// file degrades to the old per-process behavior, never to an error.

import type { SlotReserver } from "./sharedSlots";

const SHARED_RETRY_AFTER_MS = 30_000;

export class RateLimiter {
  private lastCallAt = new Map<string, number>();
  private sharedDisabledUntil = 0;
  private warnedFallback = false;

  // `shared` is a getter, not an instance, so the store can be opened
  // lazily (and swapped in tests) -- returning null means "in-process only".
  constructor(
    private readonly minGapMs: number,
    private readonly shared?: () => SlotReserver | null
  ) {}

  async wait(key: string): Promise<void> {
    const slot = this.reserveShared(key);
    if (slot !== null) {
      const wait = slot - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt.set(key, Date.now());
      return;
    }
    const last = this.lastCallAt.get(key) ?? 0;
    const wait = last + this.minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt.set(key, Date.now());
  }

  private reserveShared(key: string): number | null {
    if (!this.shared || Date.now() < this.sharedDisabledUntil) return null;
    const reserver = this.shared();
    if (!reserver) return null;
    try {
      return reserver.reserve(key, this.minGapMs);
    } catch (err) {
      if (!this.warnedFallback) {
        console.error(
          `[rate-limit] shared slot store unavailable (${(err as Error).message}); using in-process limiter, retrying shared in ${SHARED_RETRY_AFTER_MS / 1000}s`
        );
        this.warnedFallback = true;
      }
      this.sharedDisabledUntil = Date.now() + SHARED_RETRY_AFTER_MS;
      return null;
    }
  }

  // Test seam (code-review finding, 2026-09-09): with no way to clear
  // lastCallAt, tests sharing one module-level RateLimiter instance across
  // many `test()` blocks each pay a real setTimeout wait once enough calls
  // accumulate against the same key -- confirmed live,
  // tests/markets-solana-client.test.ts's 13 tests took 6.2s before this
  // existed. Purely additive; nothing in the real request path calls this.
  resetForTests(): void {
    this.lastCallAt.clear();
    this.sharedDisabledUntil = 0;
    this.warnedFallback = false;
  }
}
