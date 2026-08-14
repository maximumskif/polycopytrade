// Bounded exponential backoff with jitter. Nothing in this project should
// ever retry forever — see docs/AUDIT.md §10, which flagged the previous
// client's unconditional 429-retry recursion as a reliability risk.

export interface BackoffOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

// Attempt 1 is the first try, not a retry. Delay grows as
// baseDelayMs * 2^(attempt-1), capped at maxDelayMs, with +/-25% jitter so a
// burst of simultaneously-failing requests doesn't retry in lockstep.
export function backoffDelayMs(attempt: number, opts: Pick<BackoffOptions, "baseDelayMs" | "maxDelayMs"> = {}): number {
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 10_000;
  const raw = Math.min(base * 2 ** (attempt - 1), max);
  const jitter = raw * 0.25 * (Math.random() * 2 - 1); // +/-25%
  return Math.max(0, Math.round(raw + jitter));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
