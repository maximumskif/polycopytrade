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

## Current status (updated as work lands)

**Active** (as of 2026-09-24, items 41-52): Tracks K-O -- infrastructure
for unattended/background work (see "Tracks K-O" near the end). Landed:
K1-K3 (persistent API cache, cross-process rate limit, scoring from the
daemon DB), L1+L3 (`npm run job`/`jobs`, status rollup), M1+M2
(`wallet_scores` + auto-confirmation), N1+N2 (`npm run prereg`,
multiple-comparison reporting), O1+O2 (`scripts/agent-worktree.sh`,
`docs/AGENTS.md`), M3 (`npm run watch:check`), L2 (timers: daily
watch check, weekly pool re-score and rotating sourcing -- item 55).
Track E
sourcing continues through category-targeted holders passes (items 42,
46 -- both clean negatives).

**Blocked, needs user input**:
- Track H Phase D (Solana wallet scoring, item 29): needs a
  `BIRDEYE_API_KEY`, or a real wallet address with actual token swaps to
  test Helius's `events.swap` shape against.
- Track F (live execution code, item 17): explicitly gated on a separate,
  explicit go-ahead from the user — not started, not implied by anything
  else being done.

**Open, awaiting data** (as of item 65):
- `lamyk` forward paper test (item 64) -- pre-registered; evaluate at 20
  resolved events (`watch:check` entry `lamyk-forward-test`).
- Quality pool: 13 by `isQualityWallet` (early-movers channel, items
  62-64, supplied 9); CIs clear zero only for lamyk (in-sample). The
  channel's own pre-registered out-of-sample tests FAILED in two
  independent windows (items 67-68: +6.5% [-12.2%, 28.4%]; +1.8% [-7.9%,
  10.2%]) -- it screens out bad traders but finds breakeven ones, so the
  forward paper tests are the deciding evidence. Weekly `rescore-pool` keeps the pool current.

**Closed, don't revisit without a specific reason**:
- Track G.20 (funding-source clustering, items 36-38) — 41/95 resolved,
  clean negative, stopped at the user's call.
- Track I (fine-comb code review, items 24-26) — done.
- Volatility-breakout strategy (item 43) — no edge on a proper sample.
- Weather favorite-longshot (item 44) — pre-registered out-of-sample test
  failed.
- G.19 items 1-2 (consensus / smart-money divergence among quality
  wallets, item 65) — testable at last (80 events), no edge, CIs straddle
  zero even in-sample.
- Holders-based sourcing as a primary channel (items 42, 46, 60) — zero
  durable wallets in five categories; still runs weekly (cheap).

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
14. ✅ **Re-checked 2026-09-13 — no growth, verdict unchanged, still not
    actioned.** Re-pulled `0x1b20a0...`'s current full history
    (`historyPages=10`, same cap as always) and re-ran both sub-signals
    through `computeStrategyResult`. **Both are exactly as thin as they
    were on 2026-08-18** — 2274 total resolved trials, identical to the
    original count, meaning this wallet has resolved zero new sports
    trades in the ~26 days since the last check (separate from the
    daemon's own paper-trading copy, which has been running since Track
    E.12 and shows 8 fills/5 markets — that's a different, much newer
    dataset). **WNBA**: still exactly 68 trials / 4 distinct events, 42.6%
    win, +45.2% ROI, 95% CI [-100.0%, 89.8%] — unchanged, still below
    `MIN_SAMPLE_SIZE=20`, still watch-don't-filter. **O/U Over-only**:
    269 trials / 12 distinct *markets* (matches the original number) but
    only **7 distinct independent *events*** once properly grouped by
    `eventKey` (several O/U lines share one real game, same correction
    already applied to the MLB league count) — even thinner than the
    original "12" implied. 96.7% win, +113.6% ROI, 95% CI [90.4%, 134.8%]
    — a fully-positive CI, but built by `computeStrategyResult`'s new
    `src/research/ouOverUnderSplit.ts` (`npm run ou-over-under-split`,
    added this pass) off only 7 independent event-clusters; a tight CI
    from a 7-cluster bootstrap is not the same confidence as one from 20+,
    treat it as a stronger-looking but still-provisional number, not
    grounds to act. **Under**: 521 trials / 27 markets / 17 events, 34.2%
    win, +54.6% ROI, 95% CI [-29.7%, 90.5%] — still straddles zero. No
    config change made (same standing rule as everywhere else in this
    project) — this wallet's own live trading has simply gone quiet since
    mid-August; re-check again once/if it resumes and new trials resolve.
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
    - ✅ **Item 2 (smart-money accumulation/divergence), tested 2026-09-10 —
      inconclusive by starvation, not a clean negative.**
      `src/research/smartMoneyDivergence.ts`, `npm run
      smart-money-divergence`. The tracked-wallet pool only has 2 wallets
      that clear the project's own quality bar (zero veto flags,
      qualityScore>=50), so the "2+ quality wallets accumulate while price
      stays flat" hypothesis found essentially nothing to test on (1 total
      accumulation cluster across the whole pool, and it wasn't even
      divergent). See `docs/AUDIT.md`'s dated entry — this argues for
      prioritizing Track E.13 (new wallet sourcing) before revisiting this
      script, not for concluding the hypothesis is false.
      - **Follow-up, checked independently 2026-09-13 (parallel session,
        merged after the fact — see note below): same conclusion, harder
        evidence, still not a clean negative.** A second pass used a
        different quality bar (un-ruled-out AND a real positive signal,
        checked against actual documented verdicts rather than the
        `qualityScore>=50` threshold — which, note, technically admits
        `SDTrading`, a net -1.7% ROI wallet capped at exactly 50/100 by the
        profitability floor, Track G.18) against the wallet pool as it
        stood right after Track E.13's same-day sourcing sweep (96
        wallets, including the 27 newly sourced that day). That bar leaves
        exactly 3 wallets — `0x1b20a0...`, `TennisLove` (n=4, thin), and
        `bin8888` (n=22, thin) — and pulling their full real activity
        history (2384/113/3828 rows respectively) found **zero overlapping
        `conditionId`s across all three pairs**, out of 72+13+61 combined
        distinct markets: sports, tennis, and finance never once collide.
        Confirms the starvation finding above with a bigger, differently-
        filtered pool rather than contradicting it. **Revisit only once
        the quality pool grows enough that wallets in the same category
        actually start overlapping on real markets** — one sourcing sweep
        grew it by exactly one wallet, so this is not close yet.
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
23. ✅ **Done 2026-09-07.** Phase B's 6 open questions resolved with the
    user (see `docs/MULTI_MARKET_ARCHITECTURE.md`'s "Open questions"
    section — all six now struck through with their decisions recorded):
    same-mint `eventKey`, `hold-to-resolution`-has-no-analog signed off,
    fully separate per-market storage schemas (not a shared table), no
    Solana "dominant catalyst" flag (existing concentration checks already
    cover it), and identical composite-score weights initially (no
    Solana-specific retuning yet). **Phase D onward remains blocked on the
    one thing none of these unblock: a real Helius and/or Birdeye API key**
    to verify Phase C's scaffold against.

## Track I — Fine-comb code review (2026-09-08/09)

Requested as a checkpoint before continuing further work, given the volume
committed across Tracks A-H in one session. Two `/code-review` runs against
the full session diff (`6f2d09a..HEAD`); the first hit a session-wide rate
limit mid-flight (5 of 6 finder angles failed with 429s), fixed 5 of its 6
findings before retrying (see the "Fix 5 of 6 duplication findings" commit).
The retry ran ~13 hours (one finder angle hung; the orchestrator finalized
without it per instruction rather than blocking indefinitely) and returned
10 more findings, 6 fixed:

24. ✅ **Done 2026-09-09.** **Critical, pre-existing bug found and fixed**:
    `src/backtesting/positionReconstruction.ts`'s `marketKey()` embedded a
    literal raw NUL byte as a delimiter — `git diff` on this file has shown
    "Binary files differ" with zero visible hunks since the file was
    written (not introduced this session), and even `grep` silently found
    nothing in it without `-a`. Replaced with `":"`, matching the exact
    delimiter convention `statistics.ts` already uses for the same
    conditionId+outcome pairing. All future diffs to this file are now
    readable text.
25. ✅ **Done 2026-09-09.** Five smaller fixes: a duplicate inline zod
    schema in `markets/solana/schemas.ts` extracted to one definition; a
    hand-written sign function in `walletScore.ts` replaced with
    `Math.sign()`; a redundant `Math.max(...timestamps)` call in
    `walletScore.ts` computed once instead of twice; a dead `toNumber`
    re-export removed from `markets/solana/client.ts`; `cli/status.ts`'s
    two systemd checks parallelized via `Promise.all` instead of running
    sequentially; `RateLimiter.resetForTests()` added (purely additive) and
    wired into `markets-solana-client.test.ts`'s `beforeEach` — confirmed
    live this cut real accumulated cross-test delay (13 tests: 6.2s → 5.2s,
    remainder is tests intentionally exercising real backoff/retry timing).
26. **Flagged, not fixed** (each with a documented reason): the composite
    score's profitability floor creates a real discontinuity at the
    0.5/0.5 neutral boundary (inherent to the deliberate hard-cap design,
    not a bug); `markets/solana/client.ts`'s `requestJson` still duplicates
    `api/client.ts`'s retry control flow (already deliberately deferred —
    live production request path vs. a currently-unused consumer);
    `volatilityBreakout.ts`'s raw `JSON.parse` vs. the `parseJsonArray()`
    pattern used elsewhere is a **pre-existing inconsistency already
    present across 4 files before this session** (`legacy/backtestLadder.ts`/
    `followerExecution.ts` use raw `JSON.parse`; `snapshotCollector.ts`/
    `ouOverBias.ts` each independently duplicate their own
    `parseJsonArray`) — the new file matches its direct sibling
    (`backtestLadder.ts`, which it reuses code from), fixing this properly
    would mean touching frozen `legacy/` code or an unrelated cross-project
    cleanup.

## Track J — Depth-shift WebSocket research (2026-09-13)

27. ✅ **Superseded by a stronger, earlier finding — see below.** This
    session independently answered Track E.15's open question (doc-sourced
    only, never opened a live connection) without knowing a parallel
    session had already answered it three days earlier with an actual live
    WebSocket connection and 659 captured real messages — a stale local
    git clone on this session's side, caught only when the two diverged
    branches were merged after the fact (see the merge commit around this
    date for the full story). Both reached the same yes/no conclusion
    (`wss://ws-subscriptions-clob.polymarket.com/ws/market`, `{assets_ids,
    type: "market"}` subscribe, snapshot-then-`price_change`-deltas, 10s
    PING/PONG) but the earlier, empirically-verified pass in
    `docs/DEPTH_SHIFT_STRATEGY_SCOPE.md` §6 (2026-09-10) is the canonical
    answer — it has real captured message shapes (`hash`, `level`,
    `best_bid_ask`/`new_market`/`market_resolved` event types) this pass
    never discovered from docs alone. §2 of that doc now points here only
    as a pointer to §6, not a competing answer. **Recommendation
    (unchanged either way, not yet actioned)**: migrating
    `src/depthShift/snapshotCollector.ts` from REST polling to this WS
    channel needs its own explicit go-ahead — the running REST collector
    keeps accumulating data unchanged in the meantime.

## Track E.13 follow-up — category-leaderboard sweep (2026-09-13)

28. ✅ **Done 2026-09-13.** **Resolves Track E.13.** Added
    `getLeaderboard()` (`src/api/client.ts`, confirmed against
    docs.polymarket.com's `/v1/leaderboard` reference) and
    `npm run source-wallets` (`src/research/sourceWallets.ts`) — the first
    sweep of data-api's 9 non-OVERALL leaderboard categories (POLITICS,
    SPORTS, ESPORTS, CRYPTO, CULTURE, WEATHER, ECONOMICS, TECH, FINANCE)
    across MONTH+ALL windows, PNL-ordered. Deduped against all 69
    `TRACKED_WALLETS`, then ran the existing `scoreWallet()` pipeline (same
    one `npm run wallet-score` uses) on the top 3 per category. **Result:
    450 raw entries -> 311 new addresses -> 27 shortlisted -> 26 of 27
    vetoed**, almost entirely on `dormant` — confirms category ALL-time
    leaderboards are dominated by the same one-shot-big-win-then-inactive
    pattern this project already ruled out repeatedly on the OVERALL
    leaderboard (most survivors sat 60-800+ days since last activity).
    **One clean candidate surfaced**: `bin8888`
    (`0xa80e3fe5e7a445fa047fe6de1e27f9a15217b94b`, FINANCE category,
    ALL-time #2) — qualityScore 64/100, zero veto flags, 22 events, 85.9%
    win rate, +33.3% ROI, $492,238 net P&L, **last active 1 day ago**
    (genuinely live, not dormant). Thin sample (22 events) — same
    discipline as every other candidate in this project: worth a
    paper-trading decision, not treating 22 events as proven edge yet
    (already at `historyPages=10`, the API's own page-offset cap, so
    there's no deeper history to pull). **Follow-up same day**: all 27
    scored candidates (including the 26 ruled out) recorded in
    `src/wallets.ts` with full label/score/source provenance, matching
    this project's existing practice of logging ruled-out wallets
    permanently — so a future `source-wallets` rerun's dedupe against
    `TRACKED_WALLETS` skips all 27 instead of re-scoring them from scratch
    (each score cost real, rate-limited API time; this run took ~90
    minutes for 27 wallets). `bin8888` is NOT added to the tracking
    daemon or `paperTrading/config.ts` — only to `wallets.ts` for
    provenance — actually tracking/paper-trading it is a separate decision
    still pending.
    - **Post-merge correctness check (2026-09-13, same day)**: this whole
      sweep was scored against a local checkout that turned out to be
      stale — three days behind `origin/master`, discovered only when
      pushing (see the merge commit around this date). The missed commits
      included a real P&L bug fix (`positionReconstruction.ts`: a SELL
      with no prior tracked BUY silently zeroed its `realizedPnl` instead
      of recording the sale proceeds, understating ROI/win-rate for any
      wallet with an incomplete/paginated pull). Re-ran `bin8888` through
      `wallet-score` and the 0x1b20a0 O/U-split/WNBA checks (item 14 below)
      against the fixed code after merging: **all numbers came back
      identical** (bin8888: 85.9% win, $492,238.33 net, 33.3% ROI, still no
      flags; WNBA/O-U-split: byte-identical to the pre-fix run) — none of
      these wallets' pulled history actually hit the buggy code path. The
      26 ruled-out candidates were NOT individually re-scored (their veto
      flags are activity-pattern-based — `dormant`/`uncopyable-high-freq`/
      etc. — not PnL-magnitude-based, so the bug could not plausibly flip
      a RULED OUT verdict); their prose netPnl/ROI figures in `wallets.ts`
      should be read as pre-fix and directionally right, not re-verified
      to the dollar.

## Track H Phase D — partial unblock (2026-09-13)

29. **Partial.** **A real `HELIUS_API_KEY` was added to `.env`** (user-
    provided). Ran `getHeliusWalletTransactionHistory` live against a real
    wallet (a Jito mainnet tip account — officially published, high-volume,
    chosen so the address needed no guessing) and confirmed: `api.helius.xyz`
    is the right host (resolves the base-URL ambiguity `client.ts` flagged),
    the response validates cleanly against `HeliusTransactionsResponseSchema`
    with zero changes needed, and `timestamp` is confirmed unix seconds (not
    ms). Updated `src/markets/solana/client.ts` and `schemas.ts`'s file
    headers in place to record what's now confirmed vs. still open, per
    this project's existing practice of dating and citing confirmations
    rather than silently trusting docs. **Still blocked**: no
    `BIRDEYE_API_KEY` was provided, so `getBirdeyeWalletPnlSummary` and its
    schema remain entirely unconfirmed; and the tip-account test wallet
    only had plain SOL transfers, so Helius's `events.swap` shape — the
    single most important field for real wallet PnL reconstruction — is
    still unconfirmed (docs-sourced only). **Phase D proper (building
    `src/markets/solana/engine.ts`'s `buildTrials`) should not start until
    one of those two gaps closes** — either a Birdeye key arrives, or a
    real wallet with actual token swaps gets tested against Helius. Neither
    was attempted this pass since it needs either a credential the user
    hasn't provided or a specific real trader's address the user hasn't
    named yet (see `docs/MULTI_MARKET_ARCHITECTURE.md`'s updated "Open
    questions" section for the same finding).

## Track G.19/E.13 follow-up — archetype classifier, holders-based sourcing, favorite-longshot-bias (2026-09-15)

Session was interrupted by a machine shutdown right after these landed;
this entry backfills the log per this project's practice of writing up
non-trivial work as it's completed, not after the fact — this batch is the
one exception, logged retroactively once confirmed pushed and still green
(172/172 tests, typecheck clean).

30. ✅ **Done 2026-09-15.** **Archetype classifier** — 76 of 96 tracked
    wallets' `archetype` field was the "unclassified" placeholder and was
    never actually computed anywhere, purely stored/printed metadata.
    Added `src/scoring/archetypeClassifier.ts`'s `classifyArchetype()`,
    deriving the label from the same `WalletScore`/`BacktestTrial` data
    `walletScore.ts` already computes. Found live against `0xE30E7` that
    raw fill counts badly misclassify a fragmenting large order as
    high-frequency scalping — fixed by reusing `walletStats.ts`'s
    `clusterFills()` for every count/size/frequency-sensitive rule, with a
    regression test locking in the fix. Also fixed a real staleness bug
    found along the way: `wallets.ts`'s archetype field for two wallets
    (`0xE30E7`, `Djdjdjekekek`) didn't match README's own already-published
    manual "live-sports whale" corrections — that category didn't even
    exist in the type union; added it and fixed both entries. New tools:
    `npm run classify-archetypes` (compares algorithmic vs. declared
    archetype per wallet, `--write` to persist) and
    `npm run archetype-cohorts` (pools quality-scored wallets by shared
    archetype, tests whether a cohort's combined backtest beats the whole
    pool). Live-validated against 6 previously-manual archetypes: 4
    confirmed exactly; one (`0xE30E7`) disagrees for a real reason (its
    declared label came from an early shallow pull, superseded by a deeper
    README analysis) — left as a flagged disagreement, not silently
    overwritten.
31. ✅ **Done 2026-09-15.** **New wallet-sourcing channel: per-market top
    holders**, not historical leaderboards. Motivated by the same day's
    archetype-cohort sweep finding the entire 95-wallet tracked pool
    almost completely dormant (only 1 wallet still clears the quality
    bar). Sources by who currently holds a large real position in a
    market trading heavily right now, via data-api's `/holders` endpoint
    (confirmed live, not doc-sourced) paired with gamma-api's
    active-events-by-24h-volume listing. `npm run source-wallets-holders`.
    Two real bugs found and fixed live against production data: (1)
    `/holders` returns bare `null` instead of `[]` for a market close to
    full resolution — `HoldersResponseSchema` now normalizes null to an
    empty array instead of throwing; (2) the first shortlisting heuristic
    (biggest position/most markets) scored 4/4 candidates dormant because
    holder `amount` reflects position SIZE, not RECENCY — added a cheap
    single-call recency pre-filter (`getActivity`, most-recent-first)
    ahead of the expensive full pull. That surfaced a second, deeper bug:
    `scoreWallet()`'s `getActivityFromStart` pages FORWARD from a wallet's
    OLDEST activity, so a shallow page budget on a high-volume wallet can
    cap out before reaching recent trades — falsely flagging genuinely
    active wallets dormant (same root cause as the earlier `bin8888`
    finding in item 28). Added `scoreWalletShallow()`
    (`src/scoring/walletScore.ts`) using `getActivityDeep` (pages backward
    from now) for a fast, non-reproducible screening pass — confirmed
    live: a previously falsely-dormant candidate (`ScottyNooo`) correctly
    scored 42/100/highly-concentrated once fixed. 158/158 tests passed at
    the time, typecheck/lint clean. One candidate (`Elias.Thornwell`) hit
    24+ minutes of pure rate-limit wait resolving a large market history
    and was cut rather than block further — an inherent API cost for a
    high-volume wallet, not a bug.
32. ✅ **Done 2026-09-15.** **Favorite-longshot-bias strategy test** — a
    new, broader direction than the one narrow version already tested
    (`0x_exit`'s ladder-harvester, which backtested negative). Tests
    whether heavily-favored outcomes (high price, high win probability)
    carry a small but real positive edge, across every category the
    project's 96 tracked wallets have actually traded. Two new pieces:
    `src/backtesting/bankrollSimulation.ts` — a genuinely new capability,
    since every other backtest in this project measures aggregate stats
    (flat stake per trial, order-independent); this simulates a GROWING
    bankroll across a chronologically-ordered real-bet sequence, sized
    conservatively (Wilson-lower-bound win-rate estimate, quarter Kelly,
    hard stake-fraction cap). `src/research/favoriteHarvesting.ts`
    (`npm run favorite-harvesting`) reuses real fills already in the local
    `wallet_activity` DB (same source `consensusSignal.ts` uses, zero new
    historical-pull cost), buckets by entry price (70-99c), resolves each
    against real settlement, runs every bucket through the same
    `eventKey`-grouped `computeStrategyResult()` every other result in
    this project goes through, plus the new bankroll sim. **Live result
    (150 markets/bucket sample): no bucket clears statistical
    significance yet** — every 95% ROI CI straddles zero, including the
    combined result (+1.2% ROI, CI [-4.6%, 6.5%]). One bucket (80-85c)
    looked worth a deeper pull: +7.2% ROI, and the only bucket where the
    bankroll sim found a real sizeable edge (338 bets, 2.09x over $1000
    starting bankroll, 44.8% max drawdown) — promising, not proven. Also
    bumped `sourceWalletsFromHolders.ts`'s scoring scope
    (`MAX_CANDIDATES_TO_SCORE` 5→15, `RECENCY_PREFILTER_POOL_SIZE` 40→80)
    now that it runs detached/unattended instead of blocking an
    interactive session on slow rate-limited pulls. 172/172 tests passed
    at the time, typecheck/lint clean.
33. ✅ **Done 2026-09-15.** Added `--bucket`/`--maxMarkets` flags to
    `favoriteHarvesting.ts` to scope a run to a single price bucket at a
    much higher market cap, rather than re-paying the full 5-bucket API
    cost to sharpen one bucket's CI. Targets item 32's 80-85c bucket,
    which only sampled 150 of 1,517 available distinct markets. Usage:
    `npm run favorite-harvesting -- --bucket=80-85 --maxMarkets=600`. Added
    but **not yet run** as of this entry — see the follow-up below.
34. ✅ **Done 2026-09-15.** **Ran item 33's 80-85c deep-dive** — full 600
    of the 1,517 available distinct markets (vs. 150 in item 32's initial
    pass). **Result: the edge shrank and is still not statistically
    significant.** 1,561 trials across 463 distinct events, winRate 84.5%,
    netPnl $45.72, ROI **+2.9%** (down from +7.2% on the smaller sample),
    95% ROI CI **[-3.9%, 9.2%]** — still straddles zero. Bankroll sim
    (same Wilson-lower-bound/quarter-Kelly sizing as item 32) also
    weakened: $1000 → $1446.04 (1.45x, down from 2.09x) over 842 bets
    (up from 338), maxDrawdown 37.4% (down from 44.8%). **Verdict: this
    is the expected direction for a real small-sample overestimate, not a
    new red flag** — matches this project's existing sample-size
    discipline (a promising point estimate on ~150 markets regressing
    toward insignificance on ~4x the sample is exactly what "not proven"
    in item 32 meant). The 80-85c bucket is **not actionable** as a
    standalone strategy on current data; no further deep-dive planned
    unless a materially larger sample becomes available organically (more
    markets resolving over time) rather than by re-spending API budget on
    the same underlying population.
35. ✅ **Done 2026-09-15. Resolves the pending `bin8888` paper-trading
    decision from item 28.** Re-scored live: still active
    (`daysSinceLastActivity=0.2`), qualityScore ticked up to 65/100, still
    zero veto flags — same clean-candidate shape as 2026-09-13. But a
    deeper pull (`wallet-breakdown`, `classify-archetypes`, both run
    fresh) changed the read: the 22-"event" sample isn't diversified —
    1,703 of 1,758 resolved fills (97%) are `crypto/commodity`, almost all
    "Will WTI/Crude Oil (CL) hit $X in [month]" price-threshold markets at
    different strikes/expiries, i.e. the same directional oil-price bet
    repeated. `classifyArchetypes` newly tags it **`ladder-harvester`**
    (confidence 0.70, 2.5 markets/event) — the identical strategy shape to
    `0x_exit`, which this project already backtested negative on BTC/WTI
    ladders specifically (Track G.19). Profit is also concentrated (top
    event = 31% of profit, top 3 = 88.6%; quality score's own
    `profitConcentration=0.69`/`consistency=0.38` were already flagging
    this, which is why 65/100 isn't higher despite the headline ROI/win
    rate). Week-by-week, the bulk of the $492K net P&L clusters in a
    March-June 2026 run (wk0 +146% net, wk3 +238% net on a single WTI
    cluster) reading like one well-timed directional call on rising oil
    prices, not a repeatable mechanical edge; 139 fills are still open/
    unresolved so the current position's outcome is unknown. **Decision
    (user's call, presented with this recommendation): do NOT add
    `bin8888` to `paperTrading/config.ts`.** Left in `TRACKED_WALLETS`
    as-is (still polled by the tracking daemon, so activity continues to
    accrue for provenance/future re-review) with its `wallets.ts` label
    updated from "pending deeper review" to record this outcome and the
    reason, matching this project's practice of flagging investigated-but-
    not-acted-on findings rather than omitting them.

## Track G.20 research — funding-source clustering is a bigger lift than originally scoped (2026-09-15)

Also checked: whether to re-run `npm run smart-money-divergence` (Track
G.19 item 2) given the quality pool might have grown. It hasn't — no new
wallet has cleared the qualityScore>=50/zero-veto-flags bar since
2026-09-13 (today's holders-sourcing channel's one candidate, `ScottyNooo`,
scored 42/100, below the bar), so a re-run would burn real rate-limited
API time to reproduce the same starvation result. Skipped; revisit only
once a sourcing channel actually grows the quality pool.

36. **Research only, not yet built.** Item 20's funding-source-clustering
    idea (do two "independently smart" wallets share a common funder,
    implying the same real entity) turns out to need updating before any
    client code gets written — two things changed since this was first
    scoped as "needs Polygonscan":
    - **The API moved.** Polygonscan's standalone API was deprecated
      2025-08-15; Polygon POS data now comes from the unified Etherscan
      API V2 (`https://api.etherscan.io/v2/api?chainid=137`, one API key
      across chains, 5 req/s / 100k req/day free tier). The env var this
      needs is `ETHERSCAN_API_KEY`, not `POLYGONSCAN_API_KEY`.
    - **Polymarket's collateral token moved too.** Trading collateral is
      now **pUSD** (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`), not raw
      USDC.e (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) — incoming
      USDC/USDC.e gets wrapped into pUSD via a **Collateral Onramp**
      contract (`0x93070a847efEf7F70739046A929D47a521F5B8ee`). A naive
      "who sent this wallet its first pUSD" trace would likely just find
      the Onramp contract as the ERC-20 transfer's `from`, not the real
      depositor — the actual funding identity would need the underlying
      transaction's true signer, which may itself be a gasless relayer
      rather than the depositor's own EOA if Polymarket's proxy-wallet
      deposit flow uses meta-transactions (not yet confirmed either way).
    - Confirmed these addresses via public PolygonScan/docs.polymarket.com
      pages (web search + fetch), but **could not pull real transfer data**
      — polygonscan.com's transfer tables render via JS that a plain page
      fetch doesn't capture, and the Etherscan V2 API requires a key even
      on the free tier. **Blocked on an `ETHERSCAN_API_KEY`** — user is
      getting one; next step once it lands is pulling one real tracked
      wallet's (`tokentx`, contractaddress=pUSD and =USDC.e) full transfer
      history live to see whether the funding-source signal survives the
      Onramp/relayer confound at all, before writing any client/schema
      code. Same "verify live before building" discipline as Track H
      Phase D's Helius work.

## Track G.20 — funding-source clustering: built, run, clean negative on partial coverage (2026-09-15)

37. ✅ **Done 2026-09-15.** A real `ETHERSCAN_API_KEY` was added to `.env`
    (user-provided). Built and ran the funding-source-clustering trace
    item 36 scoped: `src/markets/polygon/{client,schemas,logDecoding}.ts`
    (Etherscan API V2, chainid=137) + `src/research/fundingSourceClustering.ts`
    (`npm run funding-source-clustering [-- --limit=N]`), with
    `tests/polygonFundingTrace.test.ts` against real captured fixtures
    (`tests/fixtures/polygon-{tokentx,receipt}.sample.json`) — 7 new tests,
    179/179 total, typecheck/lint clean. Every schema/endpoint claim is
    confirmed against a real response, same bar `src/api/schemas.ts` holds
    itself to (unlike `src/markets/solana/schemas.ts`'s still-doc-only
    ones) — see `logDecoding.ts`'s file header for the exact real
    transaction this was traced through.
    - **The signal**: a wallet's `pUSD` is minted (from the zero address),
      not transferred from a real depositor, so naively reading the mint's
      `from` reveals nothing. But the deposit transaction's logs include
      an ERC-4337 `UserOperationEvent` whose `sender` is the real account
      that authorized the deposit — confirmed live to be distinct from
      both the trading wallet and Polymarket's own infra contracts
      (EntryPoint/Onramp). Live-tested going one hop further (who funded
      THAT account) and found it resolves to a swap-router/aggregator
      contract (`permit2TransferAndMulticall`) — not a human, and not a
      per-user signal (most users converging on the same handful of
      popular routers) — so a second hop was deliberately NOT built into
      the automated sweep, only documented as a manual-review option if
      the first hop ever surfaces a real cluster worth digging into.
    - **Real bug found and fixed live while building**: Etherscan signals
      rate-limiting as HTTP 200 with `status:"0", message:"NOTOK"`, not an
      HTTP 429 — invisible to the standard retry-on-429 check every other
      client in this project uses. `requestJson` now also retries on this
      body shape specifically (matching only the confirmed `"NOTOK"`
      value, not a broader "rate limit"-text sniff, to avoid swallowing a
      real non-retryable error under similar wording).
    - **Result: 17 of 95 tracked wallets resolved to an authorizing
      address; zero share a funder with any other tracked wallet** — a
      genuine, not-starved negative for this subset (17 distinct
      addresses is a real sample, not 1-2 wallets scraping by). Confirms
      `unnamed monthly #15` (`0x1b20a0...`, this project's best
      paper-trading candidate)'s authorizing address independently, same
      value found during live design-testing.
    - **Real, majority-sized coverage gap, not a rare edge case**: the
      other 78 wallets' funding transactions have NO `UserOperationEvent`
      at all — e.g. `SDTrading`'s funding tx calls Gnosis Safe's
      `execTransaction`, a structurally different deposit-relay pattern
      from ERC-4337, not just an older EntryPoint version. This decoder
      only handles the ERC-4337 case. **Extending to Safe (and whatever
      else the remaining unresolved wallets turn out to use) is real,
      separate follow-up work — deliberately not attempted this pass,
      pending a decision on whether the clean negative on the resolved
      17 makes the remaining 78 worth the additional build.**

38. ✅ **Done 2026-09-15. Extends item 37 with a second signal.** User
    asked to extend coverage to the 78 unresolved wallets. Investigating
    a few live turned up that Polymarket's proxy wallets split across
    (at least) three structurally different architectures, not two:
    - **Gnosis Safe** (e.g. `SDTrading`) — the trading wallet itself IS a
      1-of-1 Safe. Added `getSafeOwners()` (`src/markets/polygon/client.ts`):
      one `eth_call` to the wallet's own `getOwners()` (a standard,
      documented Safe interface function, selector `0xa0e67e2b`) reveals
      its real controlling EOA directly — no funding-transaction lookup
      needed at all. New `src/markets/polygon/abiDecoding.ts` (a minimal,
      purpose-built ABI `address[]` decoder — not a general library, this
      project has exactly one on-chain read that needs it). Confirmed live
      against both a real Safe (1 owner decoded correctly) and a real
      non-Safe (a clean revert, the expected "not a Safe" signal, not
      a bug). 5 new tests (12 total in this file), including a
      hand-constructed 2-owner case (standard ABI encoding, not something
      requiring live verification the way a provider's own response shape
      does — no live 2-owner Safe was found to capture instead).
    - **Plain EOA** (e.g. `0x_exit`'s featured wallet): the funding
      transaction's own signer (`eth_getTransactionByHash`'s `from`) IS
      the trading wallet address itself — a user connected a regular
      wallet directly, no proxy contract at all. Structurally, there is
      NO separate "authorizing account" to find for this case — the
      wallet already is its own owner. Not counted as an error, but also
      not a fingerprint this method can use.
    - **A third, older Polymarket-proprietary architecture** (e.g.
      `0xE30E7`, per `docs.polymarket.com`'s own history and the
      `Polymarket/proxy-factories` GitHub repo): a GSN-style relayer calls
      a custom `proxy()` function on a `ProxyWalletFactory`-deployed
      wallet. Read that repo's actual `ProxyWallet.sol` / `ProxyWalletLib`
      source directly: **there is no public function that exposes the
      owner** — it lives in a library's internal storage slot, not a
      standard getter. The real owner address appears to be embedded as a
      parameter in the relay call's raw calldata, but confirming its exact
      position would mean reverse-engineering an undocumented layout
      rather than reading a confirmed standard interface — the same bar
      this project held ERC-4337/Safe to before trusting them. **Not
      attempted** — flagged, not guessed at.
    - **Result, full 95-wallet pool: 41/95 resolved (17 via ERC-4337, 24
      via Safe), zero share a funder with any other tracked wallet** — a
      more than doubled, still-clean negative. 184/184 tests pass,
      typecheck/lint clean. The remaining ~54 unresolved wallets split
      across plain-EOA (no fingerprint exists) and the third
      proxy-relay architecture (fingerprint likely exists, not decoded).
      **Extending further (reverse-engineering the legacy ProxyWallet
      calldata layout) is a real, separate decision — not started, given
      41 real answers with zero clusters already makes a positive result
      from the remaining wallets look less likely, not more.** **Decision
      (user's call, 2026-09-15): stop here.** Track G.20 considered closed
      at 41/95 coverage / clean negative unless a future session has a
      specific reason to revisit the legacy ProxyWallet pattern.

## Track E.15 — depth-collector migrated to the CLOB WebSocket (2026-09-15)

39. ✅ **Done 2026-09-15. Resolves Track E.15's open question (already
    answered doc/live-confirmed in §6 of `docs/DEPTH_SHIFT_STRATEGY_SCOPE.md`
    — this is the deferred rewrite itself, done live).** Every message
    shape re-confirmed against the real production endpoint this session
    (not relying on the earlier session's now-3-days-old capture):
    `book`/`price_change` payloads carry `event_type`/`tick_size`/
    `last_trade_price` fields the docs omit; `price_changes` entries are
    ABSOLUTE new sizes at (price, side), not deltas; `size="0"` really
    does mean "remove this level" (captured a real one, not inferred from
    the schema); and — the key fact enabling clean 15-minute market
    rollover — sending `{"operation":"subscribe",...}` on an ALREADY-OPEN
    connection triggers a fresh `book` snapshot for the newly-added asset,
    no reconnect needed.
    - New `src/depthShift/clobWebSocket.ts`: zod schemas + a pure,
      fully-unit-tested in-memory book-state (build from a snapshot, apply
      `price_change` deltas, sorted best-bid/best-ask). 10 tests against
      real captured fixtures (`tests/fixtures/clob-ws-*.sample.json`).
    - `src/depthShift/snapshotCollector.ts` rewritten: one WebSocket
      connection tracks both BTC/ETH "Up" tokens' live book state,
      persisting a snapshot on a **2-second timer, deliberately decoupled
      from message volume** — live-tested throughput was 5,000-7,000
      messages in 20 seconds for a single token during a fast-moving
      market; persisting per-message would have grown the DB roughly
      1,000x faster than the old 5s-REST-poll cadence for zero analytical
      benefit (a depth-shift rule reads snapshots seconds apart, not a
      full tick replay) — 2.5x faster than the old cadence while keeping
      growth bounded and predictable, a documented engineering choice, not
      a strategy decision. Includes a reconnect loop with capped DELAY but
      uncapped attempts (`backoffDelayMs`, `maxDelayMs=30_000`) — a
      deliberately different shape from this project's usual bounded-retry
      convention (`docs/AUDIT.md` §10, meant for one logical API call),
      since this is a long-running daemon's connection loop, same
      "runs forever, backs off, never gives up" character as its own
      systemd `Restart=always` wrapper.
    - **Smoke-tested against a scratch copy of the real DB** (never wrote
      to production during testing): correctly captured a real BTC
      Up-or-Down market's book collapsing to one side as it approached
      resolution (best bid climbing 0.54 → 0.99, ask-side depth thinning
      from 44 levels to zero) — **cross-verified against a fresh,
      independent REST `/book` call at the same moment: asks genuinely
      empty (0 real levels), confirming this was real market behavior,
      not a parsing bug.** 194/194 tests pass, typecheck/lint clean.
    - **Not independently live-tested**: the `operation:"unsubscribe"`
      message's exact effect (low risk if wrong — a stale subscription
      just means ignored extra messages for a token nothing tracks
      anymore, not a correctness bug); a real WS disconnect triggering the
      reconnect loop (only the connect/subscribe/message path was
      exercised end-to-end this pass, not a forced connection drop).

## Track E.13 broaden pass — stopped mid-run, session pause (2026-09-15)

40. **Paused, not abandoned.** Raised `TOP_N_PER_CATEGORY` 3→6 in
    `src/research/sourceWallets.ts` to score ranks 4-6 per category (ranks
    1-3 are already in `TRACKED_WALLETS` from the 2026-09-13 sweep, so
    dedupe skips them automatically) — 54 new candidates to score. Along
    the way, found and fixed a real bug: the script buffered ALL output
    until every candidate finished, so a run killed partway through (each
    candidate is a real rate-limited full-history pull, ~3 min each, 54 of
    them ≈ 2-3 hours) would have shown nothing for the time spent — hit
    this live when a foreground time limit killed an earlier attempt at
    ~55 minutes with zero output. Fixed to print a progress line per
    candidate as it finishes (commit `95b434f`); pushed and confirmed
    working. Restarted properly in the background — **manually stopped
    after 10/54 scored, at the user's request to pause for the day, not
    because of any problem.** All 10 scored so far: `Jenzigo`,
    `GCottrell93`, `RandomGenius-190`, `Michie`, `denizz`, `tdrhrhhd`
    (POLITICS ALL, ranks 11-16), `foodenjoyer`, `pako`, `The Spirit of
    Ukraine>UMA`, `CentralCasting` (ECONOMICS ALL, ranks 5-9) — **all 10
    VETOED**, overwhelmingly on `dormant`, matching the exact pattern the
    2026-09-13 sweep already established for this leaderboard-based
    channel. **Not recorded in `wallets.ts`** (unlike that prior sweep) —
    stopping mid-run for a pause, not backfilling provenance right now, so
    a future re-run of `npm run source-wallets` will re-score these same
    10 rather than skipping them via dedupe; a small, known, acceptable
    cost given the session is pausing. **To resume**: just re-run
    `npm run source-wallets` — it will redo POLITICS/ECONOMICS ranks
    11-16/5-9 (already known-vetoed, wasted but cheap-ish) then continue
    into the remaining 7 categories' ranks 4-6, which haven't been touched
    yet.

## Track E.13 broaden pass — finished, false-dormant bug fixed (2026-09-24)

41. ✅ **Done 2026-09-24. Completes item 40.** Re-ran `npm run
    source-wallets` end to end (the 2026-09-22 partial run's log was lost
    to a WSL reboot). 54 candidates: **22 skipped by the 1-call dormancy
    pre-check, 32 fully scored (9 clean / 23 vetoed)**. All 32 recorded in
    `wallets.ts` for provenance + dedupe; the 22 pre-check skips are not
    (cheap to re-check, could reactivate).
    - **Real bug found and fixed first** (commit `38f1aaf`): five wallets
      in the earlier partial run passed the dormancy pre-check yet
      `scoreWallet()` flagged them `dormant` -- the same forward-paging
      truncation as item 31 (`getActivityFromStart` pages from a wallet's
      OLDEST fill and caps out years before the present on high-volume
      wallets). The pre-check's newest timestamp makes this exactly
      detectable: `sourceWallets.ts` now rescores via
      `scoreWalletShallow()` when the full pull's newest fill is older,
      marked `[shallow]`. It fired on **24 of 32** scored wallets -- the
      old "leaderboard channel = overwhelmingly dormant" pattern from the
      2026-09-13 sweep and item 40 was substantially this bug, not reality.
    - **Shallow screens are not trusted directly.** Added a reproducible
      confirmation path: `TrackedWallet.historyStart` /
      `getActivityFromStart(..., fromTs)` pin the forward pull to a fixed
      anchor (still reproducible, but reaches recent trades), and
      `npm run confirm-shallow -- <addr...>` re-scores from 2026-06-24
      with 40 pages and re-checks truncation. Of 5 shallow wallets that
      cleared the bar, **only 2 survived**: `coinman2` and `0x32b4...`
      were still truncated at 40 pages (~20K fills in <3 months) with
      bot-speed median gaps (0s / 2s) the recent-2000-fill shallow window
      had hidden -- ruled out on copyability; `0xdc3E...` had only one
      event since the anchor -- ruled out as one-shot.
    - **Quality pool grew by 3** (qualityScore>=50, zero veto flags):
      `ndb1` (SPORTS #18, confirmed 62/100, 71.9% win, ROI 12.1%, 224
      events, $1.73M net, medianGap 7s), `HighTempTation` (WEATHER #9,
      confirmed 74/100, 99.3% win, ROI 9.3%, 2267 events -- a
      near-certainty favorite harvester, so copy delay may erase its thin
      per-trade edge), `vito3corleone` (SPORTS #19, full-history 57/100,
      39.4% win, ROI 47.7%, only 13 events, 23d since last trade -- thin).
      Not added to paper trading yet.
    - **G.19 check (overlap precondition for consensus/divergence):** the
      three sports-side quality wallets' real fills -- `0x1b20a0...`
      (72 markets), `ndb1` (902 since anchor), `vito3corleone` (16) --
      give the **first-ever overlap** in this project: `ndb1` x
      `vito3corleone` share 4 soccer markets (late Aug 2026). Still far
      below `MIN_SAMPLE_SIZE=20`, so G.19 items 1-2 are NOT re-run yet --
      the pool needs more wallets in the same category (-> item 42).
      Separately: `0x1b20a0...`, the only paper-traded wallet, last traded
      2026-08-10 (45 days) -- itself now dormant by the scorer's bar.

## Track G.19 — volatility breakout re-run on engine stats (2026-09-24)

43. ✅ **Done 2026-09-24. Resolves item 19's volatility sub-item: the
    earlier +10.4% result does NOT survive a proper sample.** Done by a
    parallel agent in a separate worktree (commits `073ce02`, `3928ec6`).
    `src/research/volatilityBreakout.ts` no longer touches
    `legacy/backtestLadder.ts`: trials are `BacktestTrial`s keyed by event
    slug (one monthly ladder = one event) and go through
    `computeStrategyResult` for the event-clustered bootstrap CI and
    `MIN_SAMPLE_SIZE` gating. `--eventsPerAsset=N` (default 15) replaces
    the fixed 4. **Real bug found:** gamma search marks an event "closed"
    once some rungs close, so the old run included still-live Sep-2026
    ladders but only their already-resolved-Yes rungs -- a selection bias
    that plausibly inflated the old number. Now only ladders with a past
    endDate and rungs settled at 0/1 count. The price-history fetch stops
    early once a signal can't change (`isSignalFinal`, property-tested
    against full-series detection). 203/203 tests.
    - **Live (29 min, 15 BTC ladders Apr 2025-Aug 2026 + 5 WTI Apr-Aug
      2026 -- WTI has no more closed monthly ladders):** 214 trials / **20
      independent events** (exactly `MIN_SAMPLE_SIZE`; 15 if same-month
      BTC+WTI are merged as one cluster), 54.2% win, **ROI +8.7%, 95% CI
      [-20.9%, +45.2%] -- straddles zero.** BTC +17.8% [-25.6%, +65.3%]
      (15 events), WTI -3.5% (5 events).
    - **The old 5-15c bucket is noise:** +90.1% ROI on ~5 wins across 11
      events, CI [-100%, +303%]. Only 65-85c has a CI above zero
      (+15.1%, [+4.3%, +26.0%], 19 events) -- but it's one of 8 buckets
      examined post hoc and under the sample floor; a hypothesis to test
      out-of-sample, not a finding. 35-45c comes out significantly
      negative, consistent with multiple-comparison noise.
    - **Verdict: no evidence of an edge. Not pursuing further** unless a
      larger independent sample appears (older 2024 BTC ladders, or
      ETH/SOL/gold ladders -- correlated with BTC, so fewer effective
      samples than their count suggests).

## Track G — weather favorite-longshot test (2026-09-24)

44. ✅ **Done 2026-09-24.** Motivated by item 41's `HighTempTation`
    (99.3% win / +9.3% ROI buying near-certain weather outcomes) and a
    copy-delay check showing that edge is NOT copyable: `npm run
    follower-delay-demo -- hightemptation 30` (30 sampled fills) put the
    leader's entry at 0.928 / ROI 13.7% vs. a follower's 0.970 / 4.8% at
    +5s and **0.995 / 0.5% at +30s** -- paper trading's own delay. So:
    is the underlying mispricing directly tradeable? Built by a parallel
    agent (commits `9d1fb79`, `be4428d`): `src/research/weatherFavorites.ts`
    (`npm run weather-favorites`) pulls closed gamma `tag_slug=weather`
    temperature events day by day (5/day by fixed slug hash), reads each
    settled market's CLOB price at a fixed lead before endDate (never
    after closedTime, never a future point, <=3h stale), buys the
    favorite side $1 if it's in a price band; trials keyed by event slug
    through `computeStrategyResult`, plus stricter city-date and date
    groupings. 216/216 tests. Pull cached in `data/weather-favorites/`.
    - **Live (200 events, 2026-08-13..09-21, 50bps slippage): the band
      HighTempTation trades is NOT an edge.** 85-99c combined: 24h lead
      -0.1% [-1.8%, 1.6%], 6h lead +1.3% [-0.8%, 3.3%]. The one
      CI-above-zero bucket (95-99c @6h, +1.9% [0.8%, 2.5%]) rests on 1
      loss in 218 trials, dies at 150bps slippage, and its later half's
      CI straddles zero. Consistent with items 32-34.
    - **Unplanned lead: 70-85c @24h, +10.8% [7.4%, 13.9%], 426 trials /
      139 events** (almost all "No" on a 1-degree range quoted 15-30c
      Yes) -- robust across groupings, both time halves, and 300bps
      slippage (+8.1%). But it was a context bucket, best of 8 post-hoc
      comparisons, so it is a hypothesis only.
    - **Out-of-sample test, pre-registered here BEFORE running:** same
      script and defaults, `--leadHours=24 --skipDays=43 --days=43` =
      2026-07-01..08-12, disjoint from the discovery window. Only the
      70-85c @24h bucket is evaluated. **Pass = event-clustered 95% CI
      lower bound > 0 at 50bps AND ROI > 0 at 300bps.** Anything else =
      fail, and the bucket is dropped. Result appended below when done.
    - **Out-of-sample result (2026-07-01..08-12, 215 events / 43 dates):
      FAIL -- bucket dropped.** 70-85c @24h: 285 trials / 164 events,
      76.1% win vs. 77.8% breakeven after costs, **ROI -2.3%, 95% CI
      [-7.2%, 3.1%]** (date-clustered [-7.1%, 2.9%]). The discovery
      window's +10.8% did not replicate -- a textbook best-of-8 post-hoc
      artifact, which is exactly what pre-registering caught. The 85-99c
      band is flat again (+0.8%, [-0.7%, 2.3%]). **Verdict: no tradeable
      favorite-longshot edge in daily temperature markets at a fixed 24h
      lead; weather favorites closed.** HighTempTation's own +9.3% must
      come from entry timing/information a fixed-lead snapshot can't
      replicate, and item 44's delay check says a copier can't capture it.

## Track E.13/G.19 — soccer-targeted holders sourcing (2026-09-24)

42. ✅ **Done 2026-09-24. Clean negative: zero quality wallets added.**
    Motivated by item 41's first-ever quality-wallet market overlap
    (`ndb1` x `vito3corleone`, 4 soccer markets): G.19's consensus/
    divergence tests need more wallets in ONE category. Added
    `--tag=<gamma slug>` to `npm run source-wallets-holders` (commit
    `b4c23f3`) and ran `--tag=soccer`: 15 events / 1216 sightings / 621
    new wallets -> 15 active in 14d -> 15 shallow-scored (12 "clean").
    - **"Clean" was mostly hollow.** 6 of 12 sat at exactly 50 -- the
      profitability-floor cap (G.18), i.e. both profitability terms weak,
      not quality; `MeistersApprenticeship` scored 60 on $28 net. Rule of
      thumb going forward: **qualityScore==50 is a cap, not a pass.**
    - **The 3 real-looking ones all failed confirmation** (`npm run
      confirm-shallow`, which gained `--from=YYYY-MM-DD` because 40 pages
      from 2026-06-24 only spanned ~2 weeks for these wallets): `Cannae`
      ROI -1.0% (-$31K, 286 events); `SnakeBall` medianGap 1s, bot-speed;
      `Zzzz87` -- shallow 71/100 at +24% ROI, but from a 2026-08-25 anchor
      (reached present, 842 events) it's **50/100, ROI +4.8%** -- the
      shallow window was a lucky streak. Logs: `data/*item42.log`.
    - Candidates not recorded in `wallets.ts` (same as item 31: this
      channel is read-only). G.19 items 1-2 stay parked.
    - Also this pass: `HighTempTation` copy-delay check -- see item 44.

## Paper-trading candidacy — ndb1 vetted and declined (2026-09-24)

45. ✅ **Done 2026-09-24. Decision: NOT paper-trading `ndb1`.** Of item
    41's three new quality wallets it was the only live candidate
    (`HighTempTation` fails copy delay, item 44; `vito3corleone` has 13
    events and was already 23d quiet). Two checks:
    - **Copy delay is fine:** `npm run follower-delay-demo -- ndb1 30`
      puts a follower only +0.3c worse at +30s (0.643 -> 0.646) -- unlike
      HighTempTation, delay isn't the problem. (The 28-fill sample's own
      ROI is noise; slippage is the metric.)
    - **The edge doesn't hold up by league.** `sportSegmentation.ts` now
      takes a wallet filter (`npm run sport-segmentation -- ndb1`; default
      still `0x1b20a0`). Sports overall: 8836 trials / 134 events, 69.9%
      win, **ROI +7.5%, 95% CI [-13.7%, 28.0%] -- straddles zero.** And
      **7664 of 8836 trials (53 events) are FIFA World Cup** (+8.0%, CI
      [-22.9%, 39.3%]), a tournament that's over -- a paper-trade from
      here would mostly see club soccer, where EPL is +1.6% (CI
      [-75.7%, 74.3%], 24 events). NFL is the one CI-above-zero league
      (+42.0%, [12.9%, 70.7%]) but only 12 events -- provisional, re-check
      after the NFL season accrues more.
    - **Net: the quality pool is 3 on paper but 0 actionable for copy
      trading right now.** The one paper-traded wallet (`0x1b20a0...`)
      has been quiet since 2026-08-10.

## Scoring hygiene — one quality-wallet definition, cap excluded (2026-09-24)

47. ✅ **Done 2026-09-24.** The "quality wallet" bar (zero veto flags +
    `qualityScore>=50`) was duplicated in `smartMoneyDivergence.ts` and
    `archetypeCohorts.ts`, and `>=50` admitted wallets pinned exactly AT
    the profitability-floor cap -- i.e. both profitability terms below
    neutral, the case the cap (G.18) exists to exclude. Already flagged
    once (G.19 item 2's 2026-09-13 note: `SDTrading`, net -1.7% ROI,
    passed as 50/100) and hit hard in item 42 (6 of 12 "clean" soccer
    wallets sat at exactly 50). Now a single exported
    `isQualityWallet(score)` in `src/scoring/walletScore.ts` (zero flags
    AND `qualityScore > PROFITABILITY_FLOOR_CAP*100`), used by both
    scripts; the cap itself is now an exported module constant. 2 new
    tests, 218/218 pass. Effect on item 41's pool: none (ndb1 62,
    HighTempTation 74, vito3corleone 57 are all above 50).

## Tracks K-O — infrastructure for unattended/background work (planned 2026-09-24)

Motivation, from the 2026-09-24 session (items 41-47): (1) every job
re-fetches immutable API data -- the only cache is engine.ts's in-memory
closed-market map, lost per process; (2) `RateLimiter` is per-process, so
parallel jobs/agents compete uncoordinated; (3) jobs were ad-hoc shells
with logs in /tmp (lost on a WSL reboot -- item 40's log was); every step
of screen -> confirm -> record -> write-up needed a human-driven session;
(4) wallet scoring re-pulls full histories the tracking daemon already
stores.

- **Track K — shared data layer.** K1: persistent SQLite cache
  (`data/api-cache.db`) for provably-immutable responses only (closed
  settled markets, past-window price histories of closed markets).
  K2: cross-process per-host rate limiting (slot reservation in SQLite,
  falls back to in-process). K3: score wallets from the daemon's stored
  activity, gap-filling from the API. **K1+K2 in progress 2026-09-24
  (parallel agent, branch `k1-k2-shared-cache`).**
- **Track L — background job runner.** L1: `npm run job -- <name> <cmd>`
  as a systemd user unit, output + command + commit + exit code in
  `data/runs/<date>-<name>/`; `npm run jobs`. L2: systemd timers --
  weekly pool re-score (`isQualityWallet`), weekly category-rotating
  holders sourcing, monthly watch re-checks. L3: `npm run status` shows
  jobs, quality-pool size, paper-trading summary. (L2 makes unattended
  API calls -- confirm with the user before enabling timers.)
- **Track M — automated wallet pipeline.** M1: sourcing auto-confirms
  shallow passes (`confirm-shallow`, retrying with a later `--from` when
  truncated). M2: `wallet_scores` table (score + window + date) instead
  of hand-edited `wallets.ts` labels. M3: watchlist triggers (e.g. ndb1
  NFL events >= 20 -> re-segment; same-category quality overlap >= 20
  markets -> run G.19 consensus).
- **Track N — research discipline as tooling.** N1: pre-registration
  helper (`data/preregistrations/`: hypothesis, window, pass rule,
  stamped result) -- item 44 showed it catches post-hoc artifacts. N2:
  scripts report how many buckets/variants were compared.
- **Track O — parallel-agent workflow.** O1: launch sessions from the repo
  so worktree isolation works; `scripts/agent-worktree.sh`. O2:
  `docs/AGENTS.md` (file ownership, verification, report format).

Order: K1+K2 -> (L1+L3) || (M1+M2) as parallel agents -> L2, M3, N, O.
Track F stays gated on the user regardless.

48. ✅ **Done 2026-09-24. Tracks K1, K2, L1, L3 landed** (parallel
    agents in separate worktrees; cherry-picked as `883fcc5`, `1dd732e`,
    `048e30b`, `5d58923`). 247/247 tests.
    - **K1 — persistent cache** (`data/api-cache.db`, `src/api/cachePolicy.ts`
      decides everything): only "finalized" markets (closed, exactly one
      outcome at 1 and the rest 0, UMA status `resolved` if present), the
      `closed=true` market lookup returning exactly that market, and
      price histories of a finalized market's own token whose window ended
      >=24h ago and is non-empty (the CLOB thins history at resolution, so
      only post-resolution fetches are stored). `/activity`, leaderboards,
      holders, listings, books never cached. Hits skip the rate limiter.
      Live: `follower-delay-demo -- bin8888 10` 93.7s cold -> 25.0s warm,
      identical output; the remainder is uncached `/activity` + open-market
      lookups.
    - **K2 — cross-process rate limit** (`data/api-ratelimit.db`, per-host
      slot reservation under `BEGIN IMMEDIATE`, falls back to per-process
      after 500ms lock/open failure, retries after 30s). 3-process test at
      the production 1.1s gap: arrival gaps min ~1087ms / median 1100ms;
      disabled: min 0ms. Found+fixed a concurrent first-open "database is
      locked" race on the WAL switch (`src/utils/openWalDb.ts`).
      Env: `POLYCOPY_API_CACHE=0`, `POLYCOPY_SHARED_RATELIMIT=0`,
      `*_PATH` overrides. Daemon restarted; it now shares the ~0.9 req/s
      budget with research jobs (intended).
    - **L1 — job runner:** `npm run job -- <name> -- <cmd...>` runs as a
      transient systemd user unit (`pct-job-*`) via `ops/jobs/run-job.sh`,
      recording `meta.json`/`output.log`/`exit.json` in
      `data/runs/<ts>-<name>/`; `npm run jobs [--tail X]`, `npm run
      job:stop`. States incl. `lost` (killed/WSL shutdown -- relaunch by
      hand). **L3:** `npm run status` shows jobs + quality pool.
    - Not yet: K3 (score from daemon DB), L2 timers (need user OK),
      M1+M2 (agent in progress), N, O.

49. ✅ **Done 2026-09-24. Tracks M1+M2 landed** (parallel agent;
    cherry-picked as `38be70e`, `99a500f`). 269/269 tests.
    - **M2 — `wallet_scores` table** (migration 0005, additive): one
      append-only row per scoring run -- method (`full`/`shallow`/
      `anchored`), history_start/pages, truncated, quality_score, flags,
      events, win rate, ROI, net, median gap, days since last activity,
      `is_quality` (via `isQualityWallet`), source, git commit.
      "Confirmed" = non-shallow AND non-truncated, applied before taking
      the latest per wallet (a newer shallow screen never hides a
      confirmation; a newer failed confirmation does replace a pass).
      `npm run status` reads the quality pool from it (label scan only
      while the table is empty).
    - **M1 — auto-confirmation**, one shared module
      (`src/research/walletConfirmation.ts`) used by `source-wallets`,
      `source-wallets-holders` and `confirm-shallow`: a shallow
      `isQualityWallet` pass gets an anchored pull (2026-06-24, 40 pages);
      if truncated, exactly one retry from the wallet's newest activity
      minus 30 days rounded down to the 1st/16th (30-46 days back, from
      the wallet's own data, recorded as `history_start`); still truncated
      -> **unconfirmed-truncated, never a pass**. Output separates
      confirmed / failed (with reason, ==50 named as the cap) /
      unconfirmed / screened out, and prints a ready-to-paste `wallets.ts`
      entry for each confirmed wallet; the pipeline never edits
      `wallets.ts`. Live: ndb1 confirmed 63/100 clean (item 41: 62).
    - Seeding the main DB's table: `npm run job -- seed-quality-pool`
      re-confirms ndb1, HighTempTation, vito3corleone.
    - Follow-ups: sourcing still dedupes only against `TRACKED_WALLETS`,
      not `wallet_scores` (candidates get re-scored each run); no command
      records a `full`-method score outside `source-wallets`.

46. ✅ **Done 2026-09-24. Clean negative: NFL holders pass adds zero
    quality wallets.** Follow-up to item 45 (NFL was ndb1's only league
    with a CI above zero, 12 events). `npm run source-wallets-holders --
    --tag=nfl`: 15 events / 843 sightings / 447 new wallets -> 15 active
    -> 15 shallow-scored (12 "clean"). Five sat at exactly 50 (the cap,
    item 47); `LimitOrderLarry` 63 on $301 net; `TKD44` and `Cannae`
    net negative. The one real-looking candidate, `neutralwave23`
    (shallow 56, 529 events, ROI +45.0%), confirmed from a 2026-08-25
    anchor at **50/100 (cap), 4354 events, 46.5% win, ROI +2.2%** --
    another lucky shallow window. Logs: `data/*item46.log`.
    - Same pattern as item 42: holders-based sourcing finds active
      wallets, but on confirmation they're breakeven. The shallow
      screen's recent window is systematically optimistic (4 of 4
      strong-looking holders candidates across items 42/46 regressed to
      ~breakeven), so M1's auto-confirm is load-bearing.

50. ✅ **Done 2026-09-24. Tracks N1, N2, O1, O2 landed** (parallel
    agent, interrupted once by a usage limit and resumed; cherry-picked
    as `ae71ab3`, `1502a6c`, `146ec73`). 293/293 tests.
    - **N1 — pre-registration:** `npm run prereg -- create|evaluate|list|
      show`. Registrations are **committed** under `docs/preregistrations/`
      (their value is provable existence-before-the-run); tamper-checked
      by a stored sha256 AND against the file's first committed version.
      Rules are `<metric> <op> <n>[%] [at k=v]` joined by AND, each clause
      must select exactly one result row; n/a counts as FAIL. `evaluate`
      refuses on hash/first-commit mismatch, script/resolved-args
      mismatch, window mismatch or data outside the window (catches a
      reused discovery cache), a result older than the prereg, or a
      second evaluation. `weather-favorites` and `volatility-breakout`
      gained `--json`/`--asOf`/`--sensitivityBps`. Item 44 reconstructed
      as a worked example (not committed as a registration: a file dated
      today can't claim to predate that run).
    - **N2 — multiple comparisons:** `src/research/comparisons.ts` prints
      k and flags the best bucket as post hoc, with a clearly-labeled
      Bonferroni rough guide; used by weather, volatility, and
      favorite-harvesting. `statistics.ts` exports
      `eventClusteredRoiCI(trials, confidence, resamples)` (95% path
      unchanged).
    - **O1/O2:** `scripts/agent-worktree.sh create|merge [--dry-run]|
      remove|list` (merge cherry-picks in the main checkout, never
      stashes the user's edits, runs tests); `docs/AGENTS.md` (worktrees,
      file ownership, shared cache/limiter env vars, verification, report
      format, research-discipline rules, commit early because agents get
      interrupted).

51. ✅ **Done 2026-09-24. Track K3 landed** (parallel agent, interrupted
    once and resumed; cherry-picked as `f3ed71f`). 307/307 tests.
    - **Scoring reads the daemon's `wallet_activity`, fetching only gaps.**
      Migration 0006 adds `wallet_activity_coverage` (per-wallet time
      ranges proven complete -- stored rows alone can't show holes, since
      the daemon keeps only the newest 200 per poll and the DB was reset
      2026-09-22). Only provers write ranges: the scorer per fetched page
      (a full page counts up to 1s before its newest row) and `pollWallet`
      (a full 200-row poll proves everything after its oldest row; a short
      poll proves all history). `replayFromStartPull` replays
      `getActivityFromStart`'s exact paging (page budget, offset-cap
      window restarts, shared `activityKey` dedupe) over stored rows,
      fetching a page only where coverage is missing -- so truncation
      happens at the same point and results are identical to a pure pull.
      Used by `scoreWalletWithActivity` (so confirm-shallow, auto-confirm,
      wallet-score); `POLYCOPY_SCORE_FROM_DB=0` disables.
    - **Live:** vito3corleone 630 rows identical across pure / DB-cold /
      DB-warm; HighTempTation 32.8s cold -> **2.1s warm, 1 request**
      (7303 rows, identical to a pure pull).
    - **Paper-trading guard:** backfilled rows are only persisted for
      tracked wallets, tagged `source='scoring-gap-fill'`, and
      `listUncopiedBuyFills` skips them; if the daemon later sees the same
      fill, `insertActivity` re-tags it to the daemon source (unique-key
      upsert), so copying behaves as before K3.
    - Daemon restarted: 41 wallets had coverage within 45s.
    - Side effect: `consensus-signal`/`favorite-harvesting` read all of
      `wallet_activity` and will now also see backfilled history.
    - **Found, not yet fixed: `statistics.ts`'s bootstrap CI uses unseeded
      `Math.random`** -- identical rows scored vito3corleone 57/58/59
      across runs, which matters right at the 50 cap.

52. ✅ **Done 2026-09-24. Deterministic bootstrap CI** (follow-up found
    in item 51). `eventClusteredRoiCI` drew with unseeded `Math.random`,
    so identical trials gave different CIs -- and, through
    `roiLowerBound`, different qualityScores (vito3corleone 57/58/59) --
    enough to flip a wallet across the 50 cap between runs. Now: events
    sorted by `eventKey` (trial arrival order can't change the draws), a
    fixed-seed mulberry32 PRNG, and per-event stake/net sums precomputed
    (also faster). New test: same trials, any order -> identical interval.
    308/308 tests. Scores recorded before this commit carry run-to-run
    noise of a point or two; re-confirm anything within ~2 of 50.

53. ✅ **Done 2026-09-24. Track M3 landed** (parallel agent; merged via
    `scripts/agent-worktree.sh merge`, 3 commits). 321/321 tests.
    `npm run watch:check` evaluates a typed watchlist
    (`src/watch/watchlist.ts` -- TS, not JSON, so `tsc` checks condition
    kinds/params) with zero API calls, from the daemon DB and
    `wallet_scores`. Five seeded entries, all `not-yet` on 2026-09-24:
    `ndb1-nfl-events` (~12, need 20 -> sport-segmentation),
    `quality-overlap` (0 shared markets in one category from daemon
    history, need 20 -> G.19), `0x1b20a0-resumed` (last trade
    2026-08-10), `quality-pool-changed` (baseline ndb1/HighTempTation/
    vito3corleone -> human review), `paper-resolved-events` (5, need
    20). `--run` launches fired actions through `npm run job` (forwarding
    the shared cache/limiter/DB env vars); `--ack <id>` marks handled.
    Fires once per state: re-arms only after a real reading shows the
    condition unmet or the state (e.g. pool membership) changes;
    errors/no-data never re-arm. State in `data/watch-state.json`.
    `npm run status` shows fired/errored entries plus a count. On-demand
    only -- a timer is L2 (needs the user's OK). When a watched script is
    re-run by hand, update that entry's baseline in `watchlist.ts`.

55. ✅ **Done 2026-09-24. Track L2 enabled, with the user's explicit OK**
    (commit `5f2282b`). Three systemd user timers, each a oneshot service
    that launches its work through `npm run job`: daily 08:00
    `watch:check -- --run`; Mon 03:00 `rescore-pool` (new: re-confirms
    every confirmed quality wallet via confirm-shallow); Wed 03:00
    `source-rotate` (new: one gamma tag per week from soccer, nfl, mlb,
    tennis, nba, esports, politics, crypto -- all 8 verified live).
    `Persistent=true` catches up after WSL downtime. Verified end to end
    by starting `polycopytrade-watch.service` by hand: the job ran and
    exited 0 in `npm run jobs`. Install/pause commands in
    `docs/OPERATIONS.md`. All three ride the shared K2 rate limiter.

54. ✅ **Done 2026-09-25. Sourcing dedupes against `wallet_scores`.**
    `source-wallets` and `source-wallets-holders` now also skip any wallet
    whose latest confirmed score is under 14 days old
    (`src/research/recentlyScored.ts`, `RESCORE_AFTER_DAYS`; `--rescore`
    bypasses) -- previously every run re-scored the same candidates.
    Matters now that L2's weekly `source-rotate` runs unattended.
    `backtest` and `follower-delay-demo` load activity through K3's
    `getScoringActivity`.

56. ✅ **Done 2026-09-25. Track K4 (new): batched market lookups.** The
    `holders-mlb-tennis` job ran 8h+ -- mostly one or two gamma `/markets`
    requests per market at ~1.1s each. Checked live: gamma accepts
    repeated `condition_ids=` params (a comma list returns nothing) and
    caps responses at 20 unless `limit` is passed; of 100 real ids the
    batch returned 97, and the other 3 were absent from single lookups
    too. `getMarketsByConditionIds` (50 per request, closed=true then
    closed=false for leftovers) + engine `resolveMarkets` replace the
    per-market loop in both trial builders; finalized markets are cached
    under the single-lookup key, so both paths share one cache. Live with
    cache off: vito3corleone `wallet-score` **36s -> 5s, output
    identical**. 2 new tests (batch == single over 120 mixed ids; shared
    cache key). 325/325 tests.

57. ✅ **Done 2026-09-25. Rate-limit gap 1100ms -> 100ms per Polymarket
    host** (after the user flagged jobs as too slow). Polymarket's
    documented per-IP limits (docs.polymarket.com rate-limits page, read
    2026-09-25): data-api 1000/10s general (`/positions` 150/10s), gamma
    4000/10s general (`/markets` 300/10s), CLOB `/prices-history`
    1000/10s -- enforced by Cloudflare throttling. The old flat 1.1s gap
    was 20-100x under all of them. `HOST_MIN_GAP_MS` in `client.ts`: 100ms
    for data-api/gamma/clob (10 req/s, under the tightest limit), still
    coordinated across processes by K2; `POLYCOPY_MIN_GAP_MS` overrides.
    Live (cache + DB off): ndb1 `wallet-score` **153s -> 34s**, identical
    output, zero 429s. Combined with K4 (item 56), a candidate that took
    ~20 min now takes well under a minute; the remaining cost is request
    latency (~250ms, sequential), not pacing.

58. ✅ **Done 2026-09-25. Track K5 (new): closed-positions screen -- built,
    validated, kept OPT-IN (`--screen=positions`).** Parallel agent,
    merged as 3 commits. Idea: screen candidates from data-api
    `/closed-positions` (realized P&L per position, no market lookups)
    instead of 4 `/activity` pages + gamma lookups. Findings: stake =
    `totalBought`x`avgPrice` matches the wallet's BUY fills; **losing
    positions mostly never appear in `/closed-positions`** (they only
    show once redeemed) so `/positions?redeemable=true` is needed too,
    and those carry no close time (gamma lookups needed for real close
    times). Validated read-only against 30 wallets in the main DB's
    `wallet_scores`: vs anchored confirmations the positions screen
    missed 3 of the 4 confirmed passes (activity screen missed 0), and
    after K1/K4 it only saved ~7 vs ~10 requests per wallet. Default
    stays the activity screen. `npm run validate-positions-screen`
    reproduces the comparison. 337/337 tests.

59. ✅ **Done 2026-09-25. `isQualityWallet` now requires net ROI > 0.**
    K5's validation surfaced it: the profitability-floor cap only applies
    when BOTH profitability terms are weak, so a losing wallet with one
    middling term plus strong hygiene terms could clear 50 --
    `0x3804fb...` confirmed at 61/100 on ROI -2.3% over 708 events (in the
    K5 worktree's soccer run), and a -16.9% ROI wallet screened at 52.
    `qualityFailureReason` names it ("net ROI ... lost money"). The
    confirmed pool is unaffected (ndb1 +12.1%, HighTempTation +9.3%,
    vito3corleone +47.7%). 338/338 tests.
    - Follow-up noticed: `tsconfig.json` includes only `src`, so `tsc`
      never typechecks `tests/` (a test passing objects missing `roi`
      compiled fine).

60. ✅ **Done 2026-09-25. MLB + tennis holders passes: zero quality
    wallets.** MLB (`holders-mlb-tennis`, pre-K4/pre-item-57 code, 8h+):
    883 sightings -> 458 new -> 15 active -> 0 confirmed / 1 failed
    (TimeTraveler: truncated at 2026-06-24, retry from 2026-08-16 reached
    present at 50/cap, ROI -12.8%) / 14 screened out. Tennis (relaunched on
    K4 code, **19 min**): 474 sightings -> 275 new -> 15 active -> 1
    "confirmed" (`0x796f...`, 66/100 but ROI -0.8% on 1419 events --
    re-scored after item 59 and now fails "lost money") / 4 unconfirmed
    (truncated) / 10 screened out. The 4 truncated re-confirmed with the
    120-page retry (item 61, 7 min): `0xeea3...` reached the present and
    fails (ROI -0.6%, 1519 events); the other 3 are still truncated
    (>60K fills in <40 days -- market-maker volume) with partial-window
    ROIs of +2.2%, -0.2%, +1.7% (one bot-speed) -- breakeven, not
    candidates. Across items 42/46/60 the holders channel has now
    produced zero durable quality wallets in five categories.

61. ✅ **Done 2026-09-25. Confirmation retry gets 120 pages; `tests/` is
    typechecked** (commit `a15563f`). `CONFIRM_RETRY_HISTORY_PAGES=120`
    for the later-anchor retry only. `npm run typecheck` (and CI) also run
    `tsconfig.test.json` over `tests/`, which `tsc` never saw; fixed the 2
    real errors it found. 338/338 tests.

62. ✅ **Done 2026-09-25. New sourcing channel: early movers -- first
    durable quality wallet since item 41.** Chosen by the user (option 2)
    after items 42/46/60 found the holders channel dry. `npm run
    source-early-movers` (commit `1135439`): settled markets by volume ->
    keep those whose winner traded <= 0.35 and first crossed 0.60 >= 6h
    before close (CLOB history, K1-cached) -> taker BUYs of the winner at
    <= 0.35 before the cross (data-api `/trades` with start/end; checked
    live: newest first, offset paging past 10K, taker-only by default) ->
    wallets with early winning buys in >= 3 distinct events -> dormancy
    pre-check -> the standard screen + anchored confirmation (scores ALL
    trades, losers included -- nomination alone is survivorship-biased).
    - **Run (600 largest markets closing since 2026-08-11, 15 min):** 45
      with a qualifying move, 2151 early winning buys by 1092 wallets, 15
      nominees -> **1 confirmed quality** / 3 failed (two at the 50 cap
      despite +15% ROI screens, one ROI -1.5%) / 11 screened out (mostly
      net-losing -- the longshot-buyer survivorship the design expected).
    - **`Toncar16` (`0x41583f2e...`): 58/100 clean, 87 events, 37.4% win,
      ROI +14.0%, $9.1K net, median gap 192s (human speed), active.**
      Early buys were geopolitical (Iran strike / Hormuz / US halt) at
      0.17-0.28. Added to `wallets.ts` (tracked by the daemon from now).
      Sample is modest (87 events, $9K) -- watch, not yet paper-traded.
    - Also found running it: `npm run job` didn't forward `DB_PATH`/
      `POLYCOPY_*` into the systemd unit (systemd-run starts clean), so a
      job launched from a worktree used the worktree's DB and limiter --
      fixed (`forwardedEnv`, commit in the same merge). 344/344 tests.
    - **Follow-up checks (same day):** copy delay is fine --
      `follower-delay-demo -- toncar16 30` (9s total now): entries ~0.30,
      follower +0.4c worse at +30s (~4pp ROI cost). But the event-clustered
      **ROI 95% CI is [-20.4%, +48.8%]** over 87 events -- straddles zero,
      so per the project's rule (same call as ndb1, item 45) it is NOT
      paper-traded yet. Category split: "other" (geopolitics) 627 trials
      +$7.1K, politics 17 trials +$2.5K, sports 10 trials -$0.4K. It's in
      the confirmed pool, so Monday's `rescore-pool` refreshes it weekly;
      revisit when the CI clears zero.
    - `source-rotate` (Wednesday timer) now runs early movers before the
      weekly holders tag (commit `2a28479`).

63. ✅ **Done 2026-09-25. Early movers, wider run: 2 more tracked quality
    wallets.** `source-early-movers -- --days=120 --markets=1500` (33 min):
    107 markets with a qualifying move, 6041 early winning buys by 2529
    wallets, **125 nominees** (>= 3 events), top 15 scored -> 3
    confirmed / 2 failed / 10 screened out.
    - **`gkeqd` (`0xdf17f4a8...`): 63/100, 65 events, 71.8% win, ROI
      +7.9%, $123K net, median gap 51s, max drawdown 1.2%; ROI CI
      [-0.9%, +20.9%]** -- just short of clearing zero. Retry-anchored
      from 2026-08-16 at 120 pages (very active). Early buys: Russia x
      Ukraine ceasefire, Israel.
    - **`yuhyuhyuhy352352` (`0xbd0477e0...`): 54/100, 54 events, 48.5%
      win, ROI +10.2%, $91.6K net, gap 55s; CI [-19.2%, +63.1%].**
    - `MEPP` "confirmed" at ROI 0.0% ($148 net) -- clears `roi > 0` by
      rounding; breakeven, not tracked.
    - gkeqd and yuhyuhyuhy352352 added to `wallets.ts`; neither CI clears
      zero, so both are watched (weekly `rescore-pool`), not paper-traded.
    - 110 of 125 nominees went unscored at the default cap of 15;
      `--candidates=N` added and an 80-candidate re-run launched (result
      appended below).

64. ✅ **Done 2026-09-25. Early movers, 80-candidate re-run: 6 more
    confirmed; `lamyk` goes to a pre-registered forward paper test.**
    `source-early-movers -- --days=120 --markets=1500 --candidates=80`
    (19 min): 120 nominees, 80 scored (4 dormant) -> 6 confirmed / 8
    failed / 62 screened out. ROI 95% CIs, anchored from 2026-06-24:
    | wallet | score | events | ROI | 95% CI | net | maxDD |
    |---|---|---|---|---|---|---|
    | **lamyk** | 70 | 70 | **+40.2%** | **[15.1%, 66.2%]** | $19.7K | 2.1% |
    | BiDiFakePolls | 67 | 115 | +12.3% | [-1.5%, 23.5%] | $30.1K | 2.9% |
    | 0x233B... | 57 | 144 | +21.4% | [-10.9%, 58.9%] | $17.6K | 12.1% |
    | pbshine | 60 | 128 | +11.6% | [-18.5%, 39.9%] | $22.9K | 5.2% |
    | garbagefriends | 59 | 187 | +6.2% | [-7.5%, 21.3%] | $4.2K | 5.8% |
    | MisTKy (not tracked) | 57 | 102 | +2.0% | [-12.4%, 13.1%] | $64.8K | 4.5% |
    The five above MisTKy are added to `wallets.ts`. Across items 62-64
    the channel has 9 confirmed quality wallets (1 hollow, MEPP) -- vs 0
    from five holders categories.
    - **lamyk is the first wallet since `0x1b20a0...` whose CI clears
      zero.** Copy delay is a non-issue (median gap ~21 min; follower
      slippage +0.0c at +30s, +1.3c at +60s). **Caveat: in-sample.** Its
      scored window overlaps the window it was *selected* on (early winning
      buys), so +40% is optimistic by construction; best-of-80 as well.
    - **Pre-registered forward test (written before any paper result;
      commit of this entry = registration time):** paper target `lamyk`,
      $100/fill, 30s delay, no filters, `activeFrom` = 1790325448
      (2026-09-25T08:37:28Z; new `PaperTradeTarget.activeFrom` so the
      daemon's first poll of ~200 historical fills can't be "copied" with
      known outcomes -- a look-ahead leak the engine had for any newly
      added target). **Evaluate once its paper orders have resolved on
      >= 20 distinct events (`npm run paper:report`). PASS = paper net ROI
      > 0 AND the event-clustered 95% CI lower bound > -10%. Anything else
      = FAIL: stop paper-trading it.** No parameter changes (stake, delay,
      filters) before evaluation. 345/345 tests.

65. ✅ **Done 2026-09-25. G.19 items 1-2 finally testable -- clean
    negative.** The M3 `quality-overlap` watch fired (quality wallets now
    share 71 markets in "other"/geopolitics, need 20 -- largely from the
    early-movers wallets) and launched `smart-money-divergence` itself via
    `watch:check --run` (14 min; pool of 12 by `isQualityWallet`, 30,343
    resolved BUY trials, 114 markets where >= 2 quality wallets bought the
    same outcome within 72h):
    | signal | events | win | ROI | 95% CI |
    |---|---|---|---|---|
    | any >= 2-wallet accumulation (= G.19 item 1, consensus) | 80 | 59.6% | +5.5% | [-14.5%, 25.7%] |
    | divergent (price flat; G.19 item 2's hypothesis) | 50 | 46.0% | +5.6% | [-24.3%, 35.6%] |
    | trend-following (control) | 43 | 76.5% | +5.3% | [-12.1%, 22.9%] |
    | divergent, >= 3 wallets agreeing | 8 | 55.6% | +52.9% | n/a (< 20 events) |
    Every CI straddles zero and divergent ~= the trend-following control,
    **even though this is in-sample-biased upward** (most pool wallets
    were nominated for early buys in these same markets). The >= 3-wallet
    row is 8 events and one of 5 variants -- noise until seen out of
    sample. G.19 closed unless a forward (post-2026-09-25) dataset shows
    otherwise.

66. ✅ **Done 2026-09-25. Two more pre-registered forward paper tests:
    `gkeqd` and `BiDiFakePolls`** -- the two wallets whose in-sample ROI
    CIs came closest to clearing zero ([-0.9%, 20.9%] and [-1.5%, 23.5%]).
    Paper trading costs nothing and a forward test is out-of-sample however
    a wallet was picked. **Registration (before any paper result):** same
    target settings and rule as item 64 -- $100/fill, 30s delay, no
    filters, `activeFrom` = this commit's time; evaluate each at >= 20
    resolved events; PASS = paper net ROI > 0 AND event-clustered 95% CI
    lower bound > -10%; FAIL = stop paper-trading that wallet; no
    parameter changes before evaluation. **Family note, fixed now:** with 3
    parallel forward tests (lamyk, gkeqd, BiDiFakePolls), a single PASS is
    weaker evidence than a lone test's -- before any live-execution
    discussion (Track F), a passing wallet also needs its CI lower bound >
    0 at the Bonferroni level (98.3%, 1-0.05/3), or a second forward window.
    `watch:check` entries `gkeqd-forward-test`, `bidifakepolls-forward-test`.

67. **Pre-registered 2026-09-25 (this entry's commit = registration
    time); result appended below when the run finishes. Out-of-sample test
    of the early-movers channel itself.** Items 62-64 confirmed nominees on
    windows overlapping their nomination (in-sample). `npm run
    early-movers-oos` splits time instead: **window A** = markets that
    closed 2026-01-28..2026-05-28 (`--split=2026-05-28 --lookbackDays=120
    --markets=1500`), nominating with the unchanged item-62 rules (winner
    <= 0.35 then first cross of 0.60 >= 6h before close; taker BUYs of the
    winner <= 0.35, >= $50, before the cross; >= 3 distinct events); top 60
    by events then $ (`--perGroup=60`). **Control** = top 60 wallets with
    the same cheap early BUYs but on outcomes that LOST (>= 3 events,
    excluding nominees). **Window B** = each wallet's trades from
    2026-05-28 on, 40-page anchored pull; wallets whose pull is truncated,
    or with no resolved window-B trials, are excluded and counted.
    - **Primary metric: nominees' equal-weight pooled window-B ROI**
      (each wallet's trials scaled to total stake 1), event-clustered
      bootstrap 95% CI (deterministic since item 52).
    - **PASS = that CI's lower bound > 0.** Anything else = FAIL: the
      channel's in-sample confirmations (items 62-64) are then treated as
      unproven selection artifacts until the forward paper tests (items
      64/66) say otherwise.
    - Secondary, reported but not part of the pass rule: the control's
      ROI/CI, nominee-minus-control difference, and fraction of wallets
      with ROI > 0 in each group.
    - One run, no parameter changes after seeing results; any variant
      would be a new registration.
    - **Result (run 2026-09-25, 53 min): FAIL.** 1500 window-A markets,
      150 with a qualifying move; 60 nominees, but only **7** controls
      qualified (>= 3 events of early losing buys, excluding nominees).
      | group | scored | truncated | no window-B trials | eq-wt ROI | 95% CI | wallets ROI > 0 |
      |---|---|---|---|---|---|---|
      | nominees (primary) | 33 | 16 | 11 | **+6.5%** | **[-12.2%, 28.4%]** | 22/33 |
      | control | 5 | 1 | 1 | +2.6% | [-22.2%, 27.1%] | 2/5 |
      Nominee CI lower bound -12.2% < 0 -> **FAIL per the registered
      rule.** Directionally positive (two-thirds of nominees profitable in
      the later window, +3.9pp over the control) but not significant; the
      control is too small to support a comparison, and excluding 16
      truncated (very active) nominees may bias either way. **Consequence
      as registered: items 62-64's confirmations are unproven selection
      results; the forward paper tests (lamyk, gkeqd, BiDiFakePolls --
      items 64/66) are the deciding evidence.** The channel stays in the
      weekly sourcing run (cheap, and it's the only one producing
      candidates), but its output is no longer described as an edge.
      Result JSON: `data/research-results/early-movers-oos-2026-05-28.json`.
    - Observation 2026-09-25 (not a parameter change): gkeqd's first ~2.5h
      produced 70 copied fills, **68 in one market** ("Trump renames AI by
      September 30?", 52 filled / 16 unresolvable -- CLOB history gaps
      between its rapid small buys, same market so not a biased subset).
      The registered evaluation counts distinct events and clusters its
      CI by event, so this counts as one event, but it will dominate
      gkeqd's dollar P&L -- read paper:report's $ figures with that in mind.

68. **Pre-registered 2026-09-25 (this entry's commit = registration
    time); result appended below. Replication of item 67 on an independent
    nomination window, with v1's two power problems fixed.** Same script,
    same nomination rules and same PRIMARY rule as item 67 (nominees'
    equal-weight pooled window-B ROI, event-clustered 95% CI; **PASS = CI
    lower bound > 0**). Changes, all decided from item 67's *diagnostics*
    (control size, truncation count), not from nominee outcomes:
    `--split=2026-01-28 --lookbackDays=120` (window A = markets closing
    2025-09-30..2026-01-28, disjoint from v1's window A; window B = trades
    from 2026-01-28 on), `--controlMinEvents=2` (v1 got only 7 controls),
    `--pages=120` (v1 dropped 16 of 60 nominees as truncated), `--markets=
    1500 --perGroup=60`.
    - **How the result will be read, fixed now:** v1 FAILED. If v2 PASSES,
      the combined evidence is *mixed* (1 of 2 pre-registered windows), not
      a pass -- the channel stays unproven and the forward paper tests
      still decide. If v2 FAILS, the early-movers channel is recorded as
      showing no out-of-sample edge in two independent windows, and stays
      in weekly sourcing only as a candidate generator for forward tests.
    - **Result (run 2026-09-25, 85 min): FAIL.** 1500 window-A markets, 146
      with a move; 60 nominees, 16 controls.
      | group | scored | truncated | no window-B trials | eq-wt ROI | 95% CI | wallets ROI > 0 |
      |---|---|---|---|---|---|---|
      | nominees (primary) | 44 | 14 | 2 | **+1.8%** | **[-7.9%, 10.2%]** | 26/44 |
      | control | 8 | 3 | 5 | -15.1% | [-26.9%, -4.0%] | 3/8 |
      **Per the reading fixed above: the early-movers channel shows no
      out-of-sample edge in two independent windows** (item 67 +6.5%
      [-12.2%, 28.4%]; item 68 +1.8% [-7.9%, 10.2%]). It stays in weekly
      sourcing only as a candidate generator for forward tests.
      Secondary (reported, not a pass criterion): nominees beat the
      control by 16.8pp and the control's CI is entirely negative --
      the "early winning buys" filter screens OUT bad longshot buyers, but
      what's left is roughly breakeven, not profitable. The 120-page
      pulls cut truncation (16 -> 14 of 60) only slightly.
      Result JSON: `data/research-results/early-movers-oos-2026-01-28.json`.
