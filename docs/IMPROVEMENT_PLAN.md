# Improvement plan (2026-09-05)

Drafted after a full review of the repo (`README.md`, `docs/AUDIT.md`,
`docs/DEPTH_SHIFT_STRATEGY_SCOPE.md`, source, tests). Baseline verified
locally before writing this: `npm install` / `npm run typecheck` / `npm test`
all pass clean (83/83) on Node 22 — the repo is in the state the docs claim.

This is an **engineering/ops roadmap**, distinct from the project's own
research-phase numbering (README's Phase 0-4, `docs/AUDIT.md`'s Phase
0-3-with-sub-letters). Referred to as "Track A/B/..." below so the two
numbering schemes never collide in conversation.

Nothing here is started yet — this is the plan to review before any of it
begins.

## Track A — Safety net (do first, low risk)

1. **Add CI.** Zero CI exists today despite 83 passing tests and clean
   typecheck/build — a GitHub Actions workflow running `npm ci`,
   `npm run typecheck`, `npm run build`, `npm test` on push/PR is pure
   upside with no behavior change.
2. **Document the Node version requirement in `README.md` setup**, not just
   `docs/AUDIT.md` — `node:sqlite` needs Node 22.5+/24; this WSL box had no
   Node at all until nvm+22 was installed for this session. A fresh clone
   should not have to reverse-engineer the version from the audit doc.
3. **Decide the fate of the two long-running background daemons
   (`track:daemon`, `depth:collector`).** `docs/AUDIT.md` already recorded
   them dying silently once with no supervisor and no alerting. Options:
   a lightweight process manager (pm2) vs. systemd user units vs. a thin
   wrapper script + heartbeat check. Needs a decision before Track E
   (resuming research) restarts them, so it doesn't just die silently again.

## Track B — Close self-identified gaps (low risk, no new features)

4. **Add the tests `docs/AUDIT.md` §9 flags as still missing**:
   `walletStats.ts` fill-clustering edge cases (fills exactly 120s apart,
   across a clustering boundary), and `src/tracking/` daemon loop/signal
   handling (inject a fake clock instead of real sleeps).
5. **Resolve the `positions` table's status.** Confirmed dead/unused
   (write-only, nothing reads it) and already stopped being written to
   — the audit left the table and its dead code in place on purpose for a
   future Track D dashboard. Revisit: either commit to that plan explicitly
   or remove the dead code now if no dashboard work is imminent.
6. **Decide on the legacy/engine duplication.** `walletBacktest.ts`/
   `walletBreakdown.ts`/`backtestLadder(Narrow).ts` still hand-roll their own
   trial loops alongside the proper `src/backtesting/` engine, deliberately
   not merged (to avoid silently changing cited README numbers). Worth an
   explicit one-time decision: keep both permanently (rename for clarity,
   e.g. `legacy/`) vs. do the migration now while the diff is still
   traceable, rather than leaving it an open question indefinitely.

## Track C — Architecture cleanup (medium risk, no behavior change)

7. **Move the flat research scripts** (`categorize.ts`, `consensusSignal.ts`,
   `ouOverBias.ts`, `sportSegmentation.ts`, `ladderScanner.ts`,
   `indicators.ts`, `walletStats.ts`, and the legacy backtest scripts above)
   into a `src/research/` (or `src/strategies/`) directory per the layout
   `docs/AUDIT.md` §11 already agreed on but never finished — pure file
   moves, verified by typecheck+tests passing unchanged.
8. **Finish extracting domain types** out of any remaining inline interfaces
   into `src/domain/` (§11 point 1 — partially done already).
9. Optional: add lint/format tooling (none exists today) — only if you want
   it; not blocking anything.

## Track D — Observability

10. **Expand `wallets:health` into a real status view**: daemon liveness
    (PID + last-write-timestamp for both `wallet_polls` and
    `orderbook_snapshots`), paper-trading P&L summary, wallet-score status
    — so this doesn't require grepping logs or querying SQLite by hand.
11. **Heartbeat alerting** for the two daemons (ties into Track A.3) — a
    cron-checked script that flags/pages when either table goes stale
    beyond a threshold, since silent death has already happened once.

## Track E — Research continuation (the actual "find a strategy" work)

12. **Resume tracking `0x1b20a0...`'s paper trading.** It's the only
    candidate that has ever cleared every bar; restart the daemon (once
    Track A.3 is decided) and let real forward evidence accumulate — the
    `distinctEvents` counter needs to grow well past the current sample
    before `paper:report`'s win-rate/ROI numbers mean anything.
13. **New wallet sourcing.** Four leaderboard windows (all-time/monthly/
    weekly profit + volume) are exhausted with nothing new. Needs a
    different channel: per-market "top holders," a curated/social source
    beyond one-off X posts, or a systematic pass over a category this
    project hasn't swept yet (politics-specialist non-one-shot wallets,
    live-sports beyond MLB/tennis).
14. **Revisit the flagged-but-unfiled thin-sample sub-signals** once more
    data accrues: the O/U "Over"-only sub-filter (96.7% win but n=12
    markets), the WNBA bucket (+45.2% net, n=4 events) — re-check with
    `computeStrategyResult` rather than acting on them now.
15. **Depth-shift strategy**: still just a scoping doc + a passive collector
    with ~0 accumulated history. Before any strategy code, do the open
    research task from `docs/DEPTH_SHIFT_STRATEGY_SCOPE.md` §2 — whether
    Polymarket's CLOB exposes a WebSocket order-book feed (would replace
    REST polling entirely). No strategy/execution code until that's
    answered and a real snapshot dataset exists.

## Track F — Live-readiness (documentation only)

16. **Write `docs/LIVE_READINESS.md`**: signer custody options (raw `.env`
    key was flagged as a real risk — evaluate a low-balance hot wallet with
    on-chain limits, HSM/hardware signer, or a relayer that never exposes
    the raw key), kill-switch design, position/exposure limits,
    `.env`/`.env.production` separation.
17. **No execution code** (CLOB order placement) gets written until a
    separate, explicit go-ahead after Track F.16 exists — this repeats the
    project's own existing rule, not a new one.

---

Suggested order: **A → B → C → D**, then **E and F in parallel** (research
continuation doesn't block on live-readiness docs, and vice versa) —
everything in A-D is low-risk hygiene with no behavior change, worth
clearing before spending effort on the higher-uncertainty research/live
tracks.
