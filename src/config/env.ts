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

export const config = {
  // How often the tracking daemon polls each wallet, in ms.
  pollIntervalMs: intFromEnv("POLL_INTERVAL_MS", 60_000),
  // SQLite database file. Relative paths resolve against the repo root.
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, "..", "..", "data", "polycopytrade.db"),
  // Per-request timeout for outbound API calls, in ms.
  apiTimeoutMs: intFromEnv("API_TIMEOUT_MS", 15_000),
  // Bounded retry budget for a single API call (429s and transient network
  // errors). Never retries forever — see docs/AUDIT.md §10.
  apiMaxRetries: intFromEnv("API_MAX_RETRIES", 5),
};
