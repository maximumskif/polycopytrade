// The `positions` table (0001_init) was write-only from the start -- nothing
// in the codebase has ever read it -- and un-deduped snapshotting into it hit
// 1.6M rows / 1.85GB in under 24h before writes were stopped (docs/AUDIT.md's
// Phase 3 section, 2026-08-15/16). It, `insertPositionsSnapshot`, and
// `getPositions` were left in place afterward for a hypothetical future
// dashboard to pick back up. docs/IMPROVEMENT_PLAN.md Track B.5 revisited
// that: no dashboard work is imminent, so removing dead code now beats
// carrying an unused table+schema indefinitely. If a future dashboard needs
// current-position data, re-add it then with real retention design, the same
// call the original audit deferred.

export const id = "0004_drop_positions";

export const sql = `
DROP TABLE IF EXISTS positions;
`;
