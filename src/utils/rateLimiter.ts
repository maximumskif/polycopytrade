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
}
