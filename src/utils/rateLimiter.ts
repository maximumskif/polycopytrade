// Per-key (per-API-host) minimum-gap rate limiter. Each host gets its own
// timer so a burst of calls to gamma-api doesn't block calls to data-api
// behind it — see docs/AUDIT.md §10 ("Separate rate limits by API host").

export class RateLimiter {
  private lastCallAt = new Map<string, number>();

  constructor(private readonly minGapMs: number) {}

  async wait(key: string): Promise<void> {
    const last = this.lastCallAt.get(key) ?? 0;
    const wait = last + this.minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt.set(key, Date.now());
  }

  // Test seam (code-review finding, 2026-09-09): with no way to clear
  // lastCallAt, tests sharing one module-level RateLimiter instance across
  // many `test()` blocks each pay a real setTimeout wait once enough calls
  // accumulate against the same key -- confirmed live,
  // tests/markets-solana-client.test.ts's 13 tests took 6.2s before this
  // existed. Purely additive; nothing in the real request path calls this.
  resetForTests(): void {
    this.lastCallAt.clear();
  }
}
