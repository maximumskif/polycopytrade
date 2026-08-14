# Audit: polycopytrade (2026-08-13)

Full-repository audit performed before continuing feature work. Read every
file in `src/`, `README.md`, `package.json`, `.env.example`, `tsconfig.json`,
and the git history; ran `npm install`, `npm run typecheck`, `npm run build`,
and every research command that API access permitted. This document is the
source of truth for what in the repo is currently trustworthy — do not defer
to README prose where it conflicts with this audit or with re-run output.

**This document is a point-in-time audit — sections 1-12 below describe the
repo exactly as it stood on 2026-08-13, before Phase 1 work started.**
Findings that Phase 1 has since addressed are marked inline
(`✅ Addressed <date>, see below`) rather than rewritten, so the original
audit stays intact as a record; see "Phase status" for what's actually true
today.

## Phase status

- **Phase 0 (2026-08-13): done.** This audit; the `backtestLadder.ts`
  return-math bug found, fixed, and regression-tested (§4); `backtest-ladder`
  and `backtest-ladder-narrow` re-run with corrected math (README).
- **Phase 1 (2026-08-13): done.** SQLite data foundation, replacing the
  duplicate-prone JSONL tracker (§8) and the dead `POLL_INTERVAL_MS` config
  (§8) with a real daemon:
  - `src/storage/`: `db.ts` (node:sqlite — built into Node 22.5+/24, no new
    native dependency), `migrate.ts` (idempotent migration runner, tested),
    `migrations/0001_init.ts` (wallets, wallet_activity, positions,
    api_errors, wallet_polls — deliberately just the Phase 1 tables, not
    every table the original request listed; markets/events/signals/paper
    orders/backtest runs belong to the phases that introduce them), and
    `repository.ts` (typed idempotent reads/writes — `wallet_activity` dedup
    on transaction hash + market + outcome + side + size + price +
    timestamp, tested).
  - `src/api/client.ts` (moved from `src/polymarketClient.ts`): request
    timeout, bounded exponential-backoff-with-jitter retries (never
    forever — §10), per-host rate limiting, zod runtime response validation
    (`src/api/schemas.ts` — caught a real production bug during Phase 1
    itself: some activity rows are `type: "REWARD"` with an empty `side`,
    which an overly-strict first draft of the schema rejected), structured
    `PolymarketApiError`, secret-shaped-query-param redaction in logs, and a
    mockable fetch seam for tests.
  - `src/tracking/`: `trackOnce.ts` and `trackDaemon.ts` (`npm run
    track:once` / `track:daemon`) replace the old `walletTracker.ts`, which
    ran once despite `POLL_INTERVAL_MS` implying otherwise (§8) — the daemon
    actually loops, handles SIGINT/SIGTERM gracefully (finishes the current
    cycle, never killed mid-write), never overlaps polls, and re-reads its
    wallet list from storage every cycle. `wallets:add`/`wallets:health` give
    a configurable list and basic freshness/health without requiring
    `wallets.ts` edits or building the full dashboard (Phase 4).
  - `tests/`: 18 tests total (5 pre-existing + 13 new — schema validation
    against real captured payloads, bounded-retry/fast-fail/pagination-cap
    behavior against a mocked fetch, migration idempotency, activity dedup),
    all passing, no network access required.
  - Verified end-to-end against the live API: `track:once` twice in a row
    (4799 rows inserted, then 14 — the difference being genuine new activity
    in the few seconds between runs, not a dedup failure) and a daemon
    SIGINT mid-cycle (finished the in-flight cycle, then stopped cleanly).
  - **Not done in Phase 1, by design** (see "don't build everything at
    once"): markets/events/price-snapshot/order-book/signal/paper-order/
    backtest-run tables, the reusable backtest engine, position
    reconstruction, wallet scoring, paper trading, risk engine, dashboard,
    CI. These are Phase 2-4.
- **Phase 2-5: not started.**

## 1. Existing commands and responsibilities

| Command | File | Responsibility |
|---|---|---|
| `npm start` / `npm run dev` | `src/index.ts` | Runs `walletTracker` then `ladderScanner` once, sequentially. `dev` adds `tsx watch` (re-runs on file save, not a scheduler). |
| `npm run track-wallets` | `src/walletTracker.ts` | Pulls current positions + up to 200 recent activity rows per tracked wallet, appends to `data/positions.jsonl` / `data/activity.jsonl`. Runs once and exits. **✅ Replaced 2026-08-13 by `npm run track:once` / `track:daemon` (`src/tracking/`), writing to SQLite — see "Phase status" above.** |
| `npm run scan-ladders` | `src/ladderScanner.ts` | Scans currently-open BTC/WTI monthly ladder events for rungs priced 5-45c. Read-only, prints candidates, no persistence. |
| `npm run backtest-ladder` | `src/backtestLadder.ts` | Backtests a "$1 stake at first touch into 5-45c, hold to expiry" rule against closed historical BTC/WTI ladder events. **Contained the return-calculation bug — see §4.** |
| `npm run backtest-ladder-narrow` | `src/backtestLadderNarrow.ts` | New this session: same methodology, narrowed to 15-30c / HIGH-side rungs only, restricted to events closing after 2026-05-17, to out-of-sample-test a pattern found in one wallet's trades. |
| `npm run wallet-stats` | `src/walletStats.ts` | Clusters raw activity fills into synthetic orders (same market/outcome/side, gaps ≤120s) and reports category/order-size behavior per tracked wallet. No P&L. |
| `npm run wallet-backtest` | `src/walletBacktest.ts` | Backtests "copy every real BUY fill, hold to resolution" for each tracked wallet, using the wallet's actual historical trades pulled from genesis. This is the project's main research tool; **not** affected by the §4 bug (uses real fill share counts, not synthetic $1 stakes). Accepts an optional CLI address/label filter. |
| `npm run wallet-breakdown` | `src/walletBreakdown.ts` | New this session: slices one wallet's `walletBacktest` trial set by category, entry-price band, ladder side, and week-of-lifetime; caches the trial set to `data/<address>-trials.json`. |
| `npm test` | `tests/` | 18 regression tests: §4's ladder-return math, plus (Phase 1) API client reliability, schema validation, storage/dedup/migrations. |
| `npm run migrate` | `src/storage/migrate.ts` | **Phase 1.** Idempotent SQLite migration runner. |
| `npm run track:once` | `src/tracking/trackOnce.ts` | **Phase 1.** Replaces `track-wallets`: polls every tracked wallet once, writes idempotently to SQLite instead of appending to JSONL. |
| `npm run track:daemon` | `src/tracking/trackDaemon.ts` | **Phase 1.** Actually loops (unlike the old `POLL_INTERVAL_MS`, which was never read) — polls continuously, graceful SIGINT/SIGTERM shutdown, no overlapping cycles. |
| `npm run wallets:health` | `src/tracking/health.ts` | **Phase 1.** Per-wallet freshness/health from storage. |
| `npm run wallets:add` | `src/tracking/addWallet.ts` | **Phase 1.** Adds a wallet to the tracking daemon's list without editing `wallets.ts`. |

## 2. Data sources and API assumptions

- `data-api.polymarket.com/positions?user=<address>` and `/activity?user=<address>` — public, unauthenticated, real trade/position data. Rate-limited aggressively; `src/api/client.ts` (moved from `polymarketClient.ts`) throttles every call to ≥1.1s apart per host, with a bounded exponential-backoff-with-jitter retry on 429s (✅ addressed — see §10).
- `gamma-api.polymarket.com/public-search?q=<query>` — real full-text search over events/markets/profiles. `/markets?search=` is a known dead end (confirmed by prior testing, documented in code comments — silently returns unrelated results).
- `gamma-api.polymarket.com/markets?condition_ids=<id>&closed=<bool>` — direct market lookup; `closed` must be passed explicitly, not tri-state.
- `clob.polymarket.com/prices-history` — per-outcome-token price history, used only by `backtestLadder.ts`. Confirmed by testing to reject any single `startTs`/`endTs` span past ~1 week; the code chunks into ≤6-day slices.
- **No response validation anywhere.** Every API call trusts the JSON shape completely (`res.json()` cast directly to a TypeScript interface with no runtime check). A malformed or changed API response would either crash deep in calling code with a confusing error, or — worse — silently produce wrong numbers if a field is renamed/units change and the value still type-checks (e.g. a string that parses as a different-scale number). **✅ Addressed 2026-08-13** — `src/api/schemas.ts` (zod), applied to every typed endpoint in `src/api/client.ts`. Caught a real bug on first production use: an over-strict draft schema rejected genuine `REWARD`-type activity rows with empty `side`/`conditionId` fields, exactly the "renamed/reshaped field silently breaks things" failure mode this was meant to catch, except caught loudly instead of silently.
- **No caching.** Every script re-fetches from scratch; re-running the same analysis twice re-issues every API call. `walletBreakdown.ts`'s trial-cache-to-JSON (added this session) is the only exception, and it's a one-off convenience, not a system.
- Offset-based pagination on `/activity` is capped by the API at ~5000 (confirmed by testing: offset=5000 succeeds, offset=5500 400s). `getActivityFromStart` in `polymarketClient.ts` works around this by advancing a `start` timestamp filter and resetting offset — undocumented API behavior being relied on, not a documented contract, and could change without notice.

## 3. Backtesting methodology

Two structurally different, inconsistent backtests exist:

**`backtestLadder.ts`** (ladder-harvester track): synthetic $1-per-trial staking against historical CLOB price series. "First touch into price zone" entry rule, hold-to-expiry exit, no slippage/order-book/fee modeling. A `REQUIRE_EARLY_CONTESTED` filter tries to separate "was a real toss-up, got dumped on" from "was always a longshot decaying to zero," which is a reasonable idea but an unvalidated heuristic (`>=20c both sides in the first 20% of the window`) with no sensitivity analysis behind the two magic numbers.

**`walletBacktest.ts`** (wallet-copy track): replays a real wallet's actual historical BUY fills at the actual price/size they were filled at, resolves against real settled outcomes. This is NOT a "would a hypothesized rule work" backtest — it's "would blindly copying this wallet's exact trades at their exact fill price have worked," which implicitly assumes the follower gets the SAME price the original wallet got. **This is a materially unrealistic assumption for any high-frequency wallet** (see §5) — it is not a copy-trading simulation, it's a retrospective "was the original trader net profitable" calculation. Renaming/documenting it as such (not as a copy-trade backtest) would be more honest until a delay/slippage model exists.

Neither backtest has: a defined dataset snapshot/version, a documented train/test split, walk-forward evaluation, confidence intervals, or a minimum-sample-size gate. Every "result" in the README to date is a single point estimate from a single non-reproducible-in-the-strict-sense run (the underlying API data can change — new events close, — between runs; nothing pins a backtest to an immutable input).

## 4. Mathematical errors (the confirmed one, and how it was verified)

**Confirmed and fixed this session.** `backtestLadder.ts`'s `summarize()` computed `totalReturned` by summing each trial's binary `payout` field (1 if won, 0 if lost) — treating every winning $1 stake as returning exactly $1, regardless of the price it was bought at. A $1 stake at price `p` actually buys `1/p` shares, each worth $1 if the outcome resolves in its favor; the correct payout on a win is `1/p`, not `1`.

The practical effect: `net = (totalReturned - totalStaked) / totalStaked` algebraically collapses to `(wins - n) / n = winRate - 1` for **every** group, completely independent of entry price. A bucket priced at 5-15c (where a win should pay out 6-20x) and a bucket priced at 35-45c (where a win pays out ~2.2-2.9x) would report the *same* net given the same win rate — which is obviously wrong, and is exactly what the pre-fix code did.

**Verified two ways:**
1. Algebraic re-derivation of the original Phase 1a README table (`docs` did not exist yet; this was in `README.md`'s "Phase 1 findings" section): every published bucket's "net" matched `winRate − 100%` to one decimal place (8.1%→−91.9%, 8.3%→−91.7%, 10.3%→−89.7%, 32.3%→−67.7%, 14.5%→−85.5% overall) — a mathematical tautology of the bug, not new information about the strategy.
2. Independently re-derived on this session's own new `backtest-ladder-narrow` run before the fix: n=112, win rate=16.1%, net=−83.9%; 16.1−100=−83.9, exact match.

**Fixed** in `backtestLadder.ts`'s `summarize()`: now sums `1/entryPrice` for winning trials (correct share-based payout), reports `sharesAcquired`, `grossReturned`, `netProfit`, `roi`, `avgEntryPrice` alongside `winRate`, and returns a structured `LadderSummary` instead of only `console.log`-ing. **Regression tests added** in `tests/backtestLadder.test.ts` (5 tests, `npm test`) — the sharpest one constructs 10 trials at 50c with exactly 5 wins (fair-odds breakeven) and asserts `netProfit === 0`; the old buggy code would have reported `−50%` for this exact case.

**`walletBacktest.ts` does NOT have this bug** — verified by reading: it sums `t.shares`, which is the real fill's actual share quantity from the Polymarket API (`b.size`), already correctly reflecting `usdcStaked / entryPrice` from a real trade. A winning trial's `shares` value already IS its correct dollar payout. This means **all of the wallet-copy-trade findings in the README (Phase 1b through 1f, including the decisive Phase 1e/1f conclusions about 0x_exit's wallet) do not need to be recomputed** — they were correct math to begin with. Only `backtestLadder.ts`-derived numbers (Phase 1a, and this session's new narrow-zone test) needed re-running; see §12/README for corrected figures.

No other summation/aggregation bugs of this shape were found elsewhere in the codebase on inspection, but see §7/§9 for other numerical concerns (breakeven-rate approximation, effective sample size).

## 5. Look-ahead and survivorship bias

- **Look-ahead (found and fixed previously, documented in README Phase 1c):** the original `getActivityDeep` (DESC-from-now pagination) made "most recent N fills" a moving target for high-frequency wallets — re-running the identical script a day apart flipped two wallets' net P&L sign. Fixed by `getActivityFromStart` (ASC-from-genesis). This audit re-confirms the fix is in place and is what `walletBacktest.ts`/`walletBreakdown.ts` use today — no regression found.
- **Early-slice bias (found and fixed this session, Phase 1e):** `walletBacktest.ts` had a flat `BACKTEST_PAGES = 10` that silently ignored the per-wallet `historyPages` override declared in `wallets.ts`, meaning several "backtest results" in the README were unknowingly computed from only a wallet's first ~5000 fills even when the code implied otherwise. Fixed to honor `wallet.historyPages ?? BACKTEST_PAGES`, and separately fixed the underlying offset cap (§2) to allow pulling a wallet's true full history. The practical impact was large: 0x_exit's wallet's reported edge dropped from +33.8% net (12-day slice) to +7.1% net (full 23-day history) once this was fixed.
- **Survivorship / leaderboard bias (identified, not yet systematically defended against):** `wallets.ts`'s candidate pool comes entirely from Polymarket's own profit leaderboards. A leaderboard is definitionally survivorship-biased — it only shows wallets that made money, filtered further by whoever happened to post about one on X. 17 of the 24 wallets checked so far turned out to be one-shot election bets, which the project caught via direct backtesting, not via any structural defense — there is no code that would catch this pattern on a fresh wallet without a human re-running the same manual checks each time (see §11, wallet scoring).
- **No survivorship control on backtest events:** `getClosedLadderEvents` takes "whichever 4 closed events currently rank most-recent by end date" — an event that never closed (delisted, disputed, extremely illiquid and abandoned) would simply not appear, with no accounting for it. For a small, hand-picked N=4-per-asset sample this could matter.

## 6. Fill-versus-order treatment

- `walletStats.ts` correctly identifies that `/activity` returns one row per **fill**, not per decision/order, and clusters same-market/outcome/side fills within a 120-second gap into synthetic orders before reporting order counts/sizes. This clustering is used only for behavioral reporting (avg order size, category mix) — it is **not** applied anywhere P&L is computed.
- `walletBacktest.ts` and `backtestLadder.ts` both operate at fill granularity for P&L, which is defensible for aggregate $ P&L (each fill's dollar stake and payout is real, and summing fills should equal summing orders for total P&L) but means every "distinct markets" / "n=" count in every backtest report is a **fill count or unique-market count, not an independent decision count**. A wallet that fires 40 fills into one thin order is currently indistinguishable, sample-size-wise, from 40 wallets each making one independent bet. The README's "253 distinct markets" framing for 0x_exit's wallet is the right unit (it dedupes to markets, not fills) but no report anywhere computes an "effective independent sample size" that would, e.g., discount for one real-world event spawning many correlated rung markets (all the WTI ladder rungs for one month move together with the underlying oil price — they are not 20+ independent bets).
- **No SELL-side / position-lifecycle modeling anywhere.** Every backtest treats every BUY as an independent buy-and-hold-to-resolution position and ignores SELL fills entirely (explicitly by design, documented in `walletBacktest.ts`'s header comment, as "the simplest, most conservative copy strategy"). This means the project cannot currently distinguish a wallet that scalps in and out of positions for profit from one that holds to resolution, cannot compute realized vs. unrealized P&L, and cannot model a copy-trader who would want to mirror exits too. This is a known, explicitly-scoped simplification, not an oversight, but it means every P&L number in the project is really "P&L of holding every one of this wallet's buys to expiry," which may differ substantially from the wallet's own real P&L if they actively manage positions.

## 7. Sampling limitations

- `EVENTS_PER_ASSET = 4` in `backtestLadder.ts` (and its narrow-script sibling) is a small, hardcoded convenience limit "to keep API-call volume sane given the ~1req/sec throttle" — not chosen for statistical adequacy. The entire original Phase 1a conclusion rests on 4 BTC + 4 WTI monthly ladder events.
- `wallets.ts` currently tracks 24 wallets total, sourced from one X post plus the top-20 all-time leaderboard. This is not a random or representative sample of Polymarket traders — it's "wallets someone already suspected were good," which is the input survivorship bias described in §5, not an independent sampling limitation, but compounds with the small event count above.
- The "breakeven win rate" figure now printed by `backtestLadder.ts`'s fixed `summarize()` is `avgEntryPrice`, an **approximation** valid exactly only when prices within a group are homogeneous; it does not account for which specific trials within a heterogeneous-priced bucket happened to win. This is stated in a code comment but worth flagging here as a real limitation, not just a documentation nicety — a bucket with a bimodal price distribution could have a materially wrong single-number "breakeven" summary.

## 8. Data-quality problems

- `data/activity.jsonl` and `data/positions.jsonl` are plain append-only JSONL with **no deduplication logic in `walletTracker.ts`'s `appendJsonl`** — it blindly concatenates every poll's rows. The current files (1000 / 1018 rows, from 5 poll runs on 2026-08-11) happen to show zero duplicate rows under a reasonable dedup key (transactionHash + conditionId + outcome + side + size + price), most likely because those 5 runs were spaced far enough apart and pulled from low-frequency-enough wallets that the "most recent 200" windows didn't overlap — this is incidental, not a property of the code. Any sustained polling (which `POLL_INTERVAL_MS` implies is the intended use) against a high-frequency wallet **would** produce duplicate rows with the current code. **✅ Addressed 2026-08-13** — `wallet_activity` now has a real UNIQUE constraint and `INSERT OR IGNORE` (`src/storage/repository.ts`), tested against exact-duplicate and near-duplicate (different price) fills.
- `POLL_INTERVAL_MS` is defined in `.env.example` and documented in comments as "how often to poll" but is **never read anywhere in `src/`** (confirmed by grep) — there is no polling loop; `track-wallets` runs once and exits. The setting is dead configuration. **✅ Addressed 2026-08-13** — `src/config/env.ts` reads it, and `npm run track:daemon` (`src/tracking/trackDaemon.ts`) actually loops on it.
- No schema/format versioning on the JSONL files — a future field rename in `polymarketClient.ts`'s types would silently produce mixed-shape rows in the same file with no way to detect it downstream.
- No raw-payload retention — only the typed/narrowed fields are stored; if a future bug is found in how a field was interpreted, the original API response is not recoverable from historical data, only from a fresh API call (which may no longer return the same historical state for time-sensitive fields like live prices).

## 9. Missing tests

Before Phase 0: **zero tests existed**, no test runner was installed, and `package.json` had no `test` script. Phase 0 added `tests/backtestLadder.test.ts` (5 tests covering exactly the §4 bug). Phase 1 added 13 more (18 total, `npm test`, still just Node's built-in `node:test` via `tsx --test` — no new test-framework dependency): `tests/apiClient.test.ts` (bounded 429 retry, fast-fail on non-429, the offset-cap pagination-window-reopen/dedup logic — all three of which were explicitly called out below as untested, now fixed), `tests/storage.test.ts` (migration idempotency, activity dedup, wallet upsert), `tests/schemas.test.ts` (validates real captured payloads, including the `REWARD`-row edge case). `tests/fixtures/activity.sample.json` is real, captured API output — the first fixture in the project (✅ "no test fixtures exist" below, addressed). Remaining gaps, still real:

- `walletStats.ts`: fill-clustering logic — has real edge cases (fills exactly 120s apart, fills across a clustering boundary) with no test.
- `walletBacktest.ts` / `walletBreakdown.ts`: market resolution, category classification, price-band bucketing — no test.
- `categorize.ts`: a pure function with obvious, cheap-to-test cases — no test.
- Nothing in `src/tracking/` (daemon loop timing, no-overlap behavior, signal handling) is unit-tested — it was verified manually against the live API and a real SIGINT this session (see "Phase status"), which is real evidence but not a regression test; a future session should add one, likely by injecting a fake clock/wallet-poll function rather than actually sleeping.

## 10. Live-trading risks

Live execution is not implemented (confirmed — no CLOB order-placement code exists anywhere in `src/`), but several things are worth flagging before it ever is:

- `.env.example` already stubs `CLOB_SIGNER_PRIVATE_KEY` as a commented-out env var — i.e., the **documented default deployment shape for a future live mode is "put a raw private key in a `.env` file."** This is a real risk to flag now, before any execution code is written: a `.env`-resident raw signer key is a common source of real fund loss (accidental commits, shell history, process-list exposure, backup exfiltration). See `docs/LIVE_READINESS.md` (to be written before any live-mode work) for safer alternatives to evaluate (a dedicated low-balance hot wallet with hard on-chain limits, a hardware/HSM-backed signer, a broker/relayer API that never exposes the raw key to this process, etc.) before committing to the `.env` approach.
- `polymarketClient.ts`'s retry-on-429 has **no retry limit** — `throttledFetch` recurses on every 429 indefinitely. This is a minor reliability risk today (a research script could hang forever against a persistently-limited endpoint) and would be a much more serious risk in any future live-order-placement path (an order-status-check stuck in an infinite retry loop during a live position is a real operational hazard). **✅ Addressed 2026-08-13** — `src/api/client.ts` bounds every retry loop to `config.apiMaxRetries` (default 5) with exponential backoff + jitter, tested against a mock that always returns 429 (asserts exactly N attempts, not N+1 or infinite).
- No kill switch, no position-size limit, no exposure limit exists anywhere in the code today — appropriate for a read-only research tool, but flagged here as a hard gate for Phase 3+ (see `docs/LIVE_READINESS.md` requirement in the roadmap below).
- No `.env`-vs-`.env.production`-style separation between read-only/paper/live configuration exists yet — today there's only one `.env`, which is fine while nothing writes orders, but should be split before paper trading adds any state that live mode could accidentally inherit.

## 11. Recommended architecture

See the proposed `src/{api,backtesting,cli,config,data,domain,research,scoring,storage,strategies,tracking,utils}` + `tests/` + `docs/` layout — agreed as the target structure. Current `src/` is a flat 12-file directory mixing API client, domain types (inline as interfaces inside `polymarketClient.ts` and inline in each script), backtesting logic, CLI entry points, and presentation (`console.log` formatting) in the same files. The most valuable near-term moves, in priority order:

1. **Extract domain types** (`Wallet`, `Fill`, `SyntheticOrder`, `ResolvedTrial`/`BacktestTrial`, etc.) out of `polymarketClient.ts` and the individual script files into `src/domain/`, so backtesting/scoring code depends on stable domain types instead of raw API response shapes.
2. **Separate API retrieval from storage.** Today every script calls `polymarketClient.ts` directly and either prints or appends JSONL inline. A `src/data/` (or `src/storage/`) layer with an ingestion/query boundary is what makes SQLite migration (§ below, Phase 1) tractable without a rewrite.
3. **Separate backtesting engine from strategy definition.** `backtestLadder.ts` and `walletBacktest.ts` currently each hand-roll their own trial loop, their own summarize function, and their own bucketing — a shared `src/backtesting/` engine that takes a strategy's entry/exit rule and a dataset and produces a standard result shape (per the "Results must include" list from the request) would remove this duplication and make the two backtests' outputs directly comparable for the first time.
4. **Separate CLI/presentation from logic.** Every current script's core logic and its `console.log` formatting are interleaved in the same function (e.g. `backtestMarket`/`summarize` both compute AND print). Splitting these makes both the logic unit-testable (§9) and the eventual dashboard (Phase 4) able to reuse the same computation without going through console output.

## 12. Prioritized implementation plan

Phase numbers below match the user's requested phase plan; this audit's own findings map onto it as follows:

- **Phase 0 (this session):** ✅ audit complete (this document); ✅ §4 bug verified, fixed, and regression-tested; ✅ `npm install`/`typecheck`/`build` all verified clean; ✅ re-ran `backtest-ladder` and `backtest-ladder-narrow` with corrected math (results in README, superseding the old buggy table which is preserved in a clearly-labeled historical section).
- **Phase 1 (data foundation):** highest-leverage next step is the SQLite migration + idempotent ingestion (§8's duplicate-prone JSONL is a real, if not-yet-triggered, bug) and API response validation (§2's zero-validation risk). Should also fix `POLL_INTERVAL_MS` being dead config by building the actual `track:once`/`track:daemon` split.
- **Phase 2 (research engine):** reusable backtest engine (§11.3) is the highest-leverage move here — it directly fixes the "two inconsistent backtests" problem in §3 and is a prerequisite for the realistic copy-trade simulation (delay/slippage/liquidity) and wallet scoring work requested. Position reconstruction (BUY+SELL, not BUY-only) is the other big one — §6 explains why the project currently cannot tell holding-to-resolution apart from active management.
- **Phase 3 (paper trading):** blocked on Phase 2's backtest engine and position reconstruction existing first — a paper trader built on top of today's BUY-only, no-delay assumptions would just be simulating the same unrealistic "instant copy at leader's exact price" model documented in §3.
- **Phase 4 (dashboard):** blocked on Phase 1's SQLite layer existing (a dashboard reading JSONL directly would be reading the same duplicate-prone, unversioned data flagged in §8).
- **Phase 5 (live-readiness review):** `docs/LIVE_READINESS.md` — explicitly not started, and per the user's instructions, live execution code itself should not be written proactively at all; this phase is a document, not code.

Not yet built, and intentionally out of scope for this session per "do not build everything immediately": SQLite/migrations, the reusable backtest engine, realistic copy-trade delay/slippage simulation, position reconstruction, wallet scoring system, paper-trading engine, risk engine, dashboard, CI. These are Phase 1-4 work, to be scoped and greenlit separately.
