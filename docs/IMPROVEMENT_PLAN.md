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
