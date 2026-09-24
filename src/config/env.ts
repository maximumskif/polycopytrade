// Typed config loading. Centralizes everything that used to be read ad-hoc
// (or, in POLL_INTERVAL_MS's case, declared in .env.example and never read
// at all — see docs/AUDIT.md §8) so every consumer agrees on defaults and
// units.

import "dotenv/config";
import path from "node:path";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a positive number)`);
  }
  return n;
}

// On unless explicitly switched off ("0"/"false"/"off") -- the K1/K2 API
// cache and shared rate limiter are safe defaults, so opting OUT is the
// deliberate act.
function flagFromEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

const DATA_DIR = path.join(__dirname, "..", "..", "data");

export const config = {
  // How often the tracking daemon polls each wallet, in ms.
  pollIntervalMs: intFromEnv("POLL_INTERVAL_MS", 60_000),
  // SQLite database file. Relative paths resolve against the repo root.
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, "polycopytrade.db"),
  // Per-request timeout for outbound API calls, in ms.
  apiTimeoutMs: intFromEnv("API_TIMEOUT_MS", 15_000),
  // Bounded retry budget for a single API call (429s and transient network
  // errors). Never retries forever — see docs/AUDIT.md §10.
  apiMaxRetries: intFromEnv("API_MAX_RETRIES", 5),
  // K1 (2026-09-24): persistent cache of provably-immutable API responses
  // (src/api/cachePolicy.ts). Its own SQLite file, NOT dbPath, so research
  // jobs' cache writes never contend with the tracking daemon's db lock.
  apiCacheEnabled: flagFromEnv("POLYCOPY_API_CACHE"),
  apiCachePath: process.env.POLYCOPY_API_CACHE_PATH
    ? path.resolve(process.env.POLYCOPY_API_CACHE_PATH)
    : path.join(DATA_DIR, "api-cache.db"),
  // K2 (2026-09-24): per-host rate-limit slots shared by every process on
  // this machine that points at the same file. A separate file from the
  // cache: slot reservations are tiny, hot write transactions and shouldn't
  // queue behind a large cache INSERT. Defaults to this checkout's data/ --
  // processes run from a different checkout (e.g. a git worktree) only
  // coordinate with each other if they share this path, so point
  // POLYCOPY_SHARED_RATELIMIT_PATH at one file when mixing checkouts.
  sharedRateLimitEnabled: flagFromEnv("POLYCOPY_SHARED_RATELIMIT"),
  sharedRateLimitPath: process.env.POLYCOPY_SHARED_RATELIMIT_PATH
    ? path.resolve(process.env.POLYCOPY_SHARED_RATELIMIT_PATH)
    : path.join(DATA_DIR, "api-ratelimit.db"),
  // K3 (2026-09-24): score wallets from the daemon's stored wallet_activity
  // (dbPath), fetching only the missing ranges from /activity
  // (src/scoring/activitySource.ts). POLYCOPY_SCORE_FROM_DB=0 restores the
  // pure-API pull.
  scoreFromDb: flagFromEnv("POLYCOPY_SCORE_FROM_DB"),
};
