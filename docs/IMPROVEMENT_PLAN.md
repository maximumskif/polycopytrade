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

## Track G — Profit-directed tooling (added 2026-09-06, mid-session)

Prompted by a user-supplied blueprint written for a Solana/EVM DEX
smart-wallet-sniping bot (originally intended, on investigation, for the
`meteorabot` sibling project — see chat, not this doc — which turned out to
itself have none of the wallet-intelligence machinery the blueprint
describes; it's a narrow, dormant cross-DEX arb bot). Decision: translate
the *applicable* ~25-30% of that blueprint onto polycopytrade's existing
Polymarket data rather than adopting it wholesale or chasing meteorabot.

18. ✅ **Done 2026-09-06.** **Composite Wallet Quality Score.** See the
    commit "Add composite Wallet Quality Score, keep existing flags as hard
    vetoes." `computeProfitConcentration()` (profit-based "lucky wallet"
    detection, distinct from the existing stake-based
    `concentrationTopEventShare`), `computeConsistencyScore()` (wires
    `rollingWindow.ts` into wallet-score for the first time), and
    `computeQualityScore()` (0-100 composite: 30% ROI via bootstrap-CI lower
    bound / 20% risk-adjusted return / 15% consistency / 15% profit
    concentration / 10% drawdown / 10% sample size). Existing veto flags
    kept as hard gates, NOT replaced — validated live against `Theo4` (a
    known one-shot election wallet), which scores 71/100 on raw numbers
    (higher than `0x1b20a0`'s 67) but is correctly caught by the
    `dormant`/`election-only`/`uncopyable-high-frequency` flags. The score
    alone would have missed it. Weights/scales are starting points, not
    tuned against the full 68-wallet pool yet. **Follow-up same day**: added
    a profitability floor (commit "Add profitability floor to the Wallet
    Quality Score") after live-validating against `SDTrading` (real net
    -1.7% ROI, no veto flags) scored 63/100 -- hygiene factors alone
    shouldn't rescue a losing wallet into "trade candidate" range. Caps the
    composite at 50 when both ROI-lower-bound and risk-adjusted-return score
    below neutral. Re-verified live: `SDTrading` now scores 50/100, not 63.
19. **Strategy-translation pass** (started 2026-09-06) — of the blueprint's
    ~20 strategies. Explicitly ruled out as non-transferable: cross-DEX/CEX/
    triangular arb, token-security/LP/dev-rug filters, perps/funding/
    liquidation strategies (no tokens, pools, or perps on Polymarket).
    - **Item 1 (consensus-restricted-to-quality-wallets) reordered to last**,
      not skipped: confirmed 59 of 69 tracked wallets already carry
      documented ruled-out language in `wallets.ts` -- too small a surviving
      pool right now for a meaningful convergence test. Revisit once the
      pool grows (Track E.13).
    - ✅ **Volatility compression→expansion, done and run live** (commit
      "Add volatility-compression-breakout strategy test") --
      `src/research/volatilityBreakout.ts`, `npm run volatility-breakout`.
      **Result is NOT trustworthy either way, and that's the actual
      finding**: n=116 trials look mildly positive overall (+10.4% ROI,
      50.0% win rate) with a striking per-bucket split (5-15c: +126.7% net
      on n=18; 15-25c: -100% on n=10; BTC/WTI signs flipped from what the
      original naive ladder-harvest rule found), but all 116 trials come
      from only **`EVENTS_PER_ASSET=4`+4 = 8 real independent events** --
      the exact sample-inflation problem `docs/AUDIT.md` §7 already flagged
      for `backtestLadder.ts`'s own methodology, which this script reuses
      as-is (no `effectiveIndependentSampleCount`/bootstrap-CI treatment).
      Effective sample is closer to 8 than 116; the promising 5-15c bucket
      is likely noise, same shape as Phase 1g's narrow-signal finding that
      didn't survive an out-of-sample retest. **Do not act on this number.**
      Real next step if pursued further: either a much larger closed-event
      pull, or migrate onto `src/backtesting/engine.ts`'s proper
      independent-sample-count/bootstrap-CI machinery instead of
      `legacy/backtestLadder.ts`'s simpler summarize().
    - Item 2 (smart-money accumulation/divergence) not started.
20. Not planned yet, flagged from the blueprint as a real idea: **funding-
    source wallet clustering** (are two "independently smart" wallets
    actually the same entity?) — would need a new Polygon-chain data source
    (e.g. Polygonscan) this project doesn't use today, bigger lift than
    18-19, deliberately deferred rather than started speculatively.

## Track H — Multi-market expansion (added 2026-09-07)

Per the user's decision to expand polycopytrade's scope beyond Polymarket
rather than treat the blueprint as Polymarket-only or pivot to `meteorabot`.
Proposed phases (agreed in chat): **B** design → **C** Solana data infra →
**D** Solana wallet intelligence → **E** token/pool discovery + security
filters → **F** Solana strategy engine → **G** execution (reusing
`meteorabot`'s dormant fork-tested swap code) → **H** perps (Hyperliquid,
lowest priority, own strategy family).

21. ✅ **Done 2026-09-07.** **Phase B — `docs/MULTI_MARKET_ARCHITECTURE.md`.**
    Built by a subagent in an isolated worktree, merged into master. Hit and
    recovered from a real snag: the worktree branched off 4 commits behind
    local master (commits existed locally, never pushed to origin — a
    harness/isolation quirk, filed as product feedback), so its first pass
    designed against a stale, simpler `walletScore.ts`. The agent caught the
    mismatch itself and flagged it rather than guessing past it; resumed
    with the real current state, reconciled cleanly (no code changes needed,
    doc-only). **Key finding**: `statistics.ts`/`rollingWindow.ts` and the
    entire composite-quality-score layer (`computeQualityScore`/
    `computeProfitConcentration`/`computeConsistencyScore`) are already
    100% market-agnostic — only two hardcoded literals in
    `walletScore.ts` (`type === "TRADE"`, `category === "politics"`) are
    Polymarket-specific, both feeding flags only, neither feeding the score.
    **Bigger finding**: Polymarket's `hold-to-resolution` trial-building
    treatment has no Solana analog at all (a spot token never "resolves");
    only `mirror-exit` generalizes. Proposes a `MarketAdapter` interface and
    a future (not executed) `src/core/`+`src/markets/{polymarket,solana}/`
    layout. 6 open questions listed at the doc's end for sign-off before
    Phase D.
22. ✅ **Done 2026-09-07, started only.** **Phase C — Solana data client
    scaffold**, `src/markets/solana/{client,schemas}.ts` +
    `tests/markets-solana-client.test.ts`. Mirrors `src/api/client.ts`'s
    reliability pattern (imports the existing generic `src/utils/rateLimiter.ts`/
    `retry.ts` directly rather than duplicating them). **No live API key
    exists in this environment** — every endpoint/header/response shape is
    sourced from Helius/Birdeye's published docs, not confirmed by a real
    call, and the file headers say so explicitly (a deliberate, flagged
    exception to this project's normal "confirmed by testing" bar). Two
    concrete doc discrepancies caught and flagged rather than silently
    picked: Helius's base-URL docs are internally inconsistent (defaulted to
    `api.helius.xyz`), and Birdeye's PnL-summary path differs between its
    two own doc pages (`/wallet/v2/pnl_summary` vs `/wallet/v2/pnl/summary`
    — used the latter). Rate limits defaulted conservative, both
    second-hand/unconfirmed. `HELIUS_API_KEY`/`BIRDEYE_API_KEY` stubs added
    to `.env.example`, not wired to anything live. 15 new tests. **Phase D
    (real Solana wallet scoring) is blocked on obtaining a real API key** —
    not started.
23. Not started — **Phase D onward** (Solana wallet intelligence through
    perps) blocked on: (a) resolving Phase B's 6 open questions with the
    user, (b) getting a real Helius and/or Birdeye API key to verify Phase
    C's scaffold against and unblock Phase D.
