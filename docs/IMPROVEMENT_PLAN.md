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

1. ✅ **Done 2026-09-05.** **Add CI.** Zero CI exists today despite 83 passing
   tests and clean typecheck/build — a GitHub Actions workflow running
   `npm ci`, `npm run typecheck`, `npm run build`, `npm test` on push/PR is
   pure upside with no behavior change.
2. ✅ **Done 2026-09-05.** **Document the Node version requirement in
   `README.md` setup**, not just `docs/AUDIT.md` — `node:sqlite` needs Node
   22.5+/24; this WSL box had no Node at all until nvm+22 was installed for
   this session. A fresh clone should not have to reverse-engineer the
   version from the audit doc.
3. ✅ **Done 2026-09-05.** **Decide the fate of the two long-running
   background daemons (`track:daemon`, `depth:collector`).** Chose systemd
   user services (systemd is actually running on this box) over pm2/a custom
   script — `Restart=always`, installed+enabled via `ops/systemd/`, see
   `docs/OPERATIONS.md`. Left **stopped**, not started — actually starting
   them resumes live tracking, a Track E decision, not a side effect of
   supervision infrastructure.

## Track B — Close self-identified gaps (low risk, no new features)

4. ✅ **Done 2026-09-05.** **Add the tests `docs/AUDIT.md` §9 flags as still
   missing**: `walletStats.ts` fill-clustering edge cases (9 tests, incl. the
   120s boundary) and `src/tracking/` daemon loop/signal handling (6 tests,
   via an extracted `runLoop()` + injectable-step `sleepInterruptible()`
   instead of a real fake-clock library).
5. ✅ **Done 2026-09-05.** **Resolve the `positions` table's status.**
   Decided: remove now rather than keep for a hypothetical dashboard.
   Removed `getPositions`/`insertPositionsSnapshot`/`PositionSchema`
   entirely; new migration `0004_drop_positions` drops the table.
   `wallet_polls.positions_fetched` (small, bounded, harmlessly-always-0)
   left alone — only the actually-dead write path was removed.
6. ✅ **Done 2026-09-05.** **Decide on the legacy/engine duplication.** Chose
   "keep both, rename for clarity" over migrating. `walletBacktest.ts`,
   `walletBreakdown.ts`, `backtestLadder.ts`, `backtestLadderNarrow.ts`
   moved to `src/legacy/` with a header note each; `npm run` script names
   unchanged. No logic touched.

## Track C — Architecture cleanup (medium risk, no behavior change)

7. ✅ **Done 2026-09-05.** **Move the remaining flat research scripts**
   (`categorize.ts`, `consensusSignal.ts`, `ouOverBias.ts`,
   `sportSegmentation.ts`, `ladderScanner.ts`, `indicators.ts`,
   `walletStats.ts`) into `src/research/`. Pure move + import-path fixes;
   `indicators.ts` noted as having zero importers anywhere (left as-is, not
   deleted — that's a separate call).
8. ✅ **Reviewed 2026-09-05 — no further action.** Audited every remaining
   inline interface outside `src/domain/` and `src/legacy/` (16 found).
   Conclusion: the real cross-cutting domain types (`Trackable`,
   `WalletHealth`, `BacktestTrial`, position/paper-order types) already live
   in `src/domain/types.ts`; everything left is either a genuine
   implementation-local shape (`LoopDeps`, `Migration`, `BackoffOptions`,
   script-internal intermediates) or tightly coupled to the one config/data
   file it types (`TrackedWallet`/`wallets.ts`, `PaperTradeTarget`/
   `paperTrading/config.ts`). Confirmed `domain/types.ts` already deliberately
   avoids importing `TrackedWallet` — its `Trackable` interface exists
   specifically so the domain layer doesn't depend on the `wallets.ts` data
   file — so moving `TrackedWallet` there would invert an intentional
   dependency direction, not fix one. Moving these would be relocation for
   its own sake, not a real coupling fix — skipped per "don't refactor
   beyond what's needed."
9. ✅ **Done 2026-09-05.** **Add lint/format tooling.** ESLint (flat config,
   typescript-eslint recommended) + Prettier, wired into CI. Two real bugs
   fixed along the way (missing `Error.cause` on two rethrows), two dead
   imports removed.

## Track D — Observability

10. ✅ **Done 2026-09-05.** **Expand `wallets:health` into a real status
    view**: added `npm run status` (`src/cli/status.ts`) — daemon liveness
    (`systemctl --user is-active` + last-write freshness for both
    `wallet_polls` and `orderbook_snapshots`), unhealthy-wallets rollup,
    paper-trading P&L summary (reuses `paper:report`). `wallets:health`
    kept as the separate detailed per-wallet command. wallet-score
    deliberately NOT included (costs live API calls per wallet).
11. ✅ **Done 2026-09-05, folded into D.10.** **Heartbeat alerting** — user
    chose "status command, no push notifications" over cron+desktop-notify;
    `npm run status` above is the deliverable, no separate alerting channel
    built.

## Track E — Research continuation (the actual "find a strategy" work)

12. ✅ **Started 2026-09-05, ongoing.** **Resume tracking `0x1b20a0...`'s
    paper trading.** `track:daemon` started via systemd (`loginctl
    enable-linger` also set so it survives session end, per
    `docs/OPERATIONS.md`). Found+fixed a real bug getting it running: the
    unit files' `ExecStart` gave npm's absolute nvm path, but npm's own
    `#!/usr/bin/env node` shebang still needs `node` resolvable via PATH,
    which systemd doesn't inherit from an interactive shell — added
    `Environment=PATH=...` to both units. Verified live: completed a full
    68-wallet poll cycle + paper-trading step cleanly (8 fills copied, 8
    resolved, correctly flagged by `paper:report`'s own
    too-few-distinct-events warning as not yet meaningful). `npm run status`
    confirms `systemd=active`. `depth:collector` left stopped — not part of
    this item's scope. **This will take a while to accumulate real evidence
    — check `npm run status` in future sessions, don't re-trigger this.**
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

16. ✅ **Done 2026-09-05.** **Write `docs/LIVE_READINESS.md`**: signer
    custody options (comparison table, no single choice forced), kill-switch
    design (halt-new-positions vs. force-exit-everything kept distinct),
    position/exposure limits (reusing the existing `MIN_SAMPLE_SIZE`/
    `effectiveIndependentSampleCount` discipline rather than a fresh guess),
    `.env`/`.env.production` separation, and an explicit gate for what must
    be true before any execution code is written.
17. **Standing rule, not a one-time task.** No execution code (CLOB order
    placement) gets written until a separate, explicit go-ahead — writing
    F.16 is scoping, not that go-ahead. Repeats the project's own existing
    rule.

---

Suggested order: **A → B → C → D**, then **E and F in parallel** (research
continuation doesn't block on live-readiness docs, and vice versa) —
everything in A-D is low-risk hygiene with no behavior change, worth
clearing before spending effort on the higher-uncertainty research/live
tracks.
