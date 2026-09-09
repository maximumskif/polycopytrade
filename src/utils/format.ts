// Shared display formatting. Extracted 2026-09-08 (code-review finding):
// src/cli/status.ts had reimplemented src/tracking/health.ts's fmtAgo
// locally rather than importing it, and had independently added a day-tier
// health.ts's copy lacked (a wallet down for 3 days used to print "72h
// ago") -- one shared version, with the more complete day-tier behavior,
// avoids the two commands silently drifting apart on the same timestamp.
export function fmtAgo(ts: number | null): string {
  if (ts === null) return "never";
  const seconds = Math.floor(Date.now() / 1000) - ts;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
