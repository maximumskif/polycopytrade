# Multi-market architecture (design only, 2026-09-07)

Design for generalizing this project from "Polymarket wallet scoring" to "any
market's wallet scoring." Written from an actual read of every file listed
below (with line references), not from abstract theorizing about what a
generic backtesting engine "should" look like. **This document changes
nothing about the running system.** No Polymarket file under `src/api/`,
`src/tracking/`, `src/paperTrading/`, `src/storage/`, `src/backtesting/`,
`src/scoring/`, `src/legacy/`, or `src/research/` is touched by this pass —
see "Constraints" in the task this doc was written under. The systemd
`track:daemon`/paper-trading loop keeps running throughout, untouched.

## Revision history

**2026-09-07, second pass — reconciled against the real codebase.** The
first version of this doc (below, originally titled "A note on the brief
this doc was written against") flagged that `docs/IMPROVEMENT_PLAN.md`'s
"Track G" and `src/scoring/walletScore.ts`'s composite quality score
appeared not to exist anywhere — not in the working tree, `git log`, or
`origin/master`. **Root cause, since confirmed by the task's coordinator:**
this worktree branched off local `master` at commit `461e93c`, but four more
commits (`268e3d9` "Add composite Wallet Quality Score, keep existing flags
as hard vetoes," `d9ae0d1` "Add Track G to the improvement plan," `c310f5c`
"Add profitability floor to the Wallet Quality Score," `f44e8e6` "Add
volatility-compression-breakout strategy test") landed on local `master`
after that branch point and before this task started, and were never pushed
to `origin` — a harness/isolation quirk (worktree branched before those
commits landed, `origin` was never a factor either way), not a real absence
of the work or a wrong call on my part to flag it. Rebased this worktree's
branch onto the real local `master` (`git rebase master`, clean, no
conflicts — my additions were purely additive) and re-read the real current
`src/scoring/walletScore.ts`/`src/domain/types.ts` in full before revising
anything below.

**What changed in this revision, stated explicitly rather than silently
patched in:**
- The composite `qualityScore`/`WalletQualityScoreComponents`/profitability
  floor are real, and turn out to be **entirely market-agnostic already** —
  a stronger, better-grounded version of what Part 2's original "if/when one
  is added" speculation guessed at. This is a **reaffirmation** of this
  doc's core thesis (the scoring math is agnostic, only two literals in
  `walletScore.ts` are Polymarket-specific), now checked against the real,
  richer implementation instead of the absent one — see the rewritten
  Section 1/2 below.
- The original guess that a profitability floor "would plausibly reject a
  wallet whose bootstrap CI's lower bound is negative, expressible purely
  against `StrategyResult.roiBootstrapCI[0]`" was **substantially correct**:
  the real floor caps the composite at 50 when BOTH the ROI-lower-bound term
  AND the risk-adjusted-return term score below neutral — a real, slightly
  richer two-term version of the single-term guess, found live against
  SDTrading (real net -1.7% ROI, no veto flags, scored 63/100 before the cap
  existed). Noted as a **partial confirmation**, not treated as if it were
  already known.
- Section 1's inventory of which `walletScore.ts` lines are Polymarket-
  specific is **unchanged in substance** (still exactly two hardcoded
  literals: the `"TRADE"` type filter and the `"politics"` category check)
  — the three new functions (`computeProfitConcentration`,
  `computeConsistencyScore`, `computeQualityScore`) add zero new
  Polymarket-specific surface, which is itself worth stating rather than
  assuming.
- Everything about `statistics.ts`, `rollingWindow.ts`, `engine.ts`'s
  `buildTrials`, the `hold-to-resolution`-has-no-Solana-analog finding, and
  the directory-layout proposal is **reaffirmed unchanged** — none of those
  files were touched by the four commits (confirmed via `git show --stat`
  on each), so nothing about them needed revisiting. The `MarketAdapter`
  interface proposal in Section 2 also holds, with one addition: it should
  note explicitly that `computeQualityScore` needs zero adapter-supplied
  input beyond what `MarketAdapter.buildTrials` already produces.

The original first-pass note is kept below, struck through in spirit but not
deleted, since it's still an accurate record of what a legitimate,
carefully-checked read of the environment looked like at the time (`grep`
across the working tree, `git log`, and `origin/master` really did come back
empty) — useful as a record of why the flag was raised, not as current
guidance.

<details>
<summary>Original first-pass note (superseded by the revision above — kept for the record)</summary>

This doc was commissioned as "Phase B" of a `docs/IMPROVEMENT_PLAN.md` "Track
G," described as already containing a Solana/EVM sniping-blueprint review
(with items G.18-19 already done). **That track does not exist anywhere in
this repository** — not in the working tree, not in `git log`, not on
`origin/master`. `grep -rn "Track G"` across the repo returns nothing, and
`docs/IMPROVEMENT_PLAN.md` ends at Track F (line 149) with no G section. The
brief also described `src/scoring/walletScore.ts` as already having a
composite 0-100 quality score with a "profitability floor" cap and a
`WalletQualityScoreComponents` type "added today" — neither exists either;
`grep -rn "WalletQualityScoreComponents\|profitability floor\|compositeScore\|qualityScore"`
across `src/` and `docs/` returns nothing. `computeWalletScore` (read in
full below) returns raw flags + raw metrics, not a composite score.

This is flagged prominently, not buried, because it changes what "based on
actually reading the files" can mean for those two claims: I designed against
the actual code, not the described-but-absent code. Everywhere below that
depends on the composite-score/profitability-floor claim, I've noted it as a
**proposed** addition rather than described existing behavior. **This
discrepancy should be resolved with the user before Phase D starts** — either
Track G's content and the score-related work exist in a session/branch this
worktree never received, or the brief described planned-but-not-yet-done work
as already-done. See "Open questions" at the end.

</details>

---

## 1. What's market-agnostic today vs. Polymarket-specific

### Genuinely market-agnostic (operates purely on `BacktestTrial[]`/`StrategyResult`, no Polymarket concept in the code path)

**`src/backtesting/statistics.ts`, all of it.** Read in full. Every function
takes `BacktestTrial[]` and reads only seven of its fields:
`resolved`, `entryTimestamp` (sort key only), `usdcStaked`, `netReturn`,
`won`, `eventKey`, `category`, plus `conditionId`+`outcome` as an opaque
market-identity pair for `distinctMarkets`. It never touches `entryPrice`
or `shares` — those pass through the type unused by this file. Concretely
market-agnostic:
- `mean`/`stdev` (lines 14-22) — plain statistics.
- `maxDrawdownPct` (lines 31-42) — peak-to-trough of a cumulative-P&L
  series in entry order. The comment at lines 24-30 is explicit that this
  is an approximation (orders by entry time, not resolution time, because
  trials don't carry a resolution timestamp) — that caveat is a property of
  the `BacktestTrial` shape, not of Polymarket, and applies identically to
  any market's trials built the same way.
- `bootstrapRoiCI` (lines 52-82) — resamples whole **events** (`eventKey`
  groups), not individual trials, specifically to avoid treating correlated
  bets (the file's own example: 19 rungs of one month's WTI ladder) as 19
  independent draws. The *mechanism* (cluster bootstrap keyed by an opaque
  grouping string) is 100% reusable; only the meaning of what belongs to
  one `eventKey` is market-specific (see below).
- `computeStrategyResult` (lines 84-141) — win rate, ROI, profit factor,
  volatility, `sharpeLike`/`sortinoLike` (explicitly documented at lines
  141-144 of `domain/types.ts` as "-like" because trials don't share a
  common time basis — this caveat is itself market-agnostic, it's a property
  of comparing discrete bets, true for Solana trades too), and
  `effectiveIndependentSampleCount` (`distinctEvents`, line 122) — the
  project's core anti-sample-inflation discipline. `MIN_SAMPLE_SIZE = 20`
  (line 11) and `meetsMinimumSample` are pure thresholds on a count.

**`src/backtesting/rollingWindow.ts`, all of it.** Buckets `BacktestTrial[]`
by `entryTimestamp` and reruns `computeStrategyResult` per bucket (lines
27-47). Zero Polymarket-specific code — the file header itself (lines 1-13)
already describes this as answering "is performance stable across time" in
general terms.

**The veto-flag/composite-score split — real, both layers market-agnostic
except two literals.** `docs/AUDIT.md`'s Phase 2 established hard
disqualifying flags kept separate from a continuous score (so a wallet can't
buy its way past "this is a one-shot bet" with a good ROI number); the real
`src/scoring/walletScore.ts` (re-read in full after the rebase described in
"Revision history" above) implements this as two layers, both worth
inventorying on their own:

- **Six veto flags** (`computeWalletScore`, lines 154-221): `one-shot`
  (distinctEvents ≤ 3, line 184), `dormant` (daysSinceLastActivity > 30,
  line 185), `election-only` (electionShare > 70%, line 186),
  `highly-concentrated` (top-event stake share > 50%, line 187),
  `uncopyable-high-frequency` (median inter-fill gap < 5s on ≥ 50 fills,
  lines 188-190), `insufficient-sample` (below `MIN_SAMPLE_SIZE`, line 191).
  Five of six are pure functions of counts/ratios/gaps over `eventKey`/
  `usdcStaked`/timestamps — fully market-agnostic. `election-only` is the
  one exception (see below).
- **A composite 0-100 `qualityScore`** (`computeQualityScore`, lines
  103-152), built from `computeProfitConcentration` (lines 61-72 — top-1/
  top-3 event share of realized PROFIT, distinct from the flag layer's
  STAKE-based concentration check) and `computeConsistencyScore` (lines
  82-94 — wires `rollingWindow.ts` into a weekly-bucketed stability read,
  null with under 2 windows rather than penalized). **All three of these
  functions read only `BacktestTrial[]`/`StrategyResult`/`BacktestConfig` —
  none of them touch a Polymarket type, a category string, or an activity
  row.** `computeQualityScore` itself blends `strategyResult.roiBootstrapCI`/
  `sortinoLike`/`sharpeLike`/`expectedValuePerDollar`/`maxDrawdownPct`/
  `effectiveIndependentSampleCount` (all `StrategyResult` fields, all
  already established as agnostic above) with the two new agnostic
  functions' output — weights 30/20/15/15/10/10 (lines 129-134), plus a
  profitability floor (lines 136-149: caps the composite at 50 when both the
  ROI-lower-bound term and the risk-adjusted-return term score below
  neutral, found live against SDTrading scoring 63/100 net-negative before
  the cap existed). **Every one of these mechanisms — the profit-
  concentration math, the consistency math, the composite blend, and the
  profitability-floor cap — would run unmodified against a Solana adapter's
  `BacktestTrial[]` output, exactly like the five agnostic veto flags
  already established.** This is the single most important correction this
  revision makes: the richer scoring layer this project actually built is
  not a bigger adapter-interface burden than the flag layer was — it's the
  same "reads only the shared trial shape" property, just with more of it.

**Sample-independence discipline in general** (`effectiveIndependentSampleCount`
as "distinct real-world bets, not distinct fills or distinct markets") is the
single most valuable piece of prior art in this codebase (`docs/AUDIT.md` §7,
found the hard way after 0x_exit's wallet's 253 "markets" turned out to be 16
real events). It is a completely general lesson about correlated outcomes,
independent of what a "market" or "event" means in any given venue.

### Polymarket-specific (the adapter layer that would need replacing)

**`src/api/schemas.ts`, all of it.** `ActivitySchema`/`GammaMarketSchema`/
`GammaEventSchema`/`OrderBookSchema` are 1:1 zod mirrors of Polymarket's REST
responses — `conditionId`, `outcome`, `outcomePrices` (a JSON-encoded array
of final settlement prices, lines 63-67 below), `clobTokenIds`, `side` as a
free string because Polymarket's own API emits non-trade rows with
`side=""` (schemas.ts:17-23). None of this has a Solana analog by name;
a Solana adapter needs its own schema module entirely (this pass's
`src/markets/solana/client.ts` does exactly that, scoped to what's
currently confirmable — see Part 2 below).

**`src/backtesting/engine.ts`'s `buildTrials` and everything it calls — this
is the actual adapter boundary in the codebase today, whether or not anyone
has named it that.** Specifically:
- `resolveMarket`/`outcomeWon` (lines 52-68): a Polymarket market resolves to
  a JSON `outcomePrices` array; the trial's `won` is `finalPrices[idx] > 0.5`.
  This assumes a binary market that settles to (effectively) 0 or 1 — a
  concept with no meaning for a Solana spot trade. A token doesn't
  "resolve" the way a prediction-market contract does.
- `eventKeyFor` (lines 23-25): `a.eventSlug ?? a.slug` — Polymarket's own
  event-grouping concept (e.g., one month's WTI-ladder rungs share one
  `eventSlug`). A Solana adapter's equivalent grouping key means something
  different (see Part 2).
- `categorize` (`src/research/categorize.ts`, all 24 lines): a keyword
  classifier over Polymarket market **titles** into `crypto/commodity`,
  `weather`, `politics`, `sports`, `other`. Nothing about this taxonomy
  transfers to Solana wallet activity — a Solana wallet's "category" would
  more plausibly be about token type (meme/L1/stable/new-launch) or
  strategy shape (snipe vs. swing), a completely different classification
  problem needing its own module, not a port of this one.
- `applyCosts` (lines 32-37): fee/slippage modeled as basis points against a
  probability-shaped price in `[0, 1]` (`Math.min(1, entryPrice * (1 +
  slippageBps/10_000))`, line 33) — this specific clamp only makes sense
  because Polymarket prices are probabilities capped at 1. A token price has
  no such ceiling; the *shape* of "fee taken off stake, slippage worsens
  entry price" is reusable, the `Math.min(1, …)` clamp is not.
- `buildHoldToResolutionTrials` vs. `buildMirrorExitTrials` (lines 70-157):
  see Part 2 — this distinction turns out to matter a lot for what a Solana
  adapter should even attempt.

**`src/scoring/walletScore.ts`'s two Polymarket-specific reads — still
exactly two, even in the real, richer file with three more functions in it:**
- Line 177: `activity.filter((a) => a.type === "TRADE")` — `"TRADE"` is a
  literal from Polymarket's `Activity.type` enum-ish string field (schemas.ts
  line 27, deliberately loose because real rows include `"REWARD"` — see
  schemas.ts's own comment at lines 17-23). `medianGapSeconds` is computed
  only over this filtered set, and feeds only the `uncopyable-high-frequency`
  flag — not the composite score.
- Line 173: `resolvedTrials.filter((t) => t.category === "politics")` —
  the `election-only` flag hardcodes one string from `categorize.ts`'s
  taxonomy. This is the one flag that is conceptually Polymarket-specific,
  not just implementation-specific: "one-shot 2024-election bet" is a real,
  specific pattern this project discovered (README Phase 1c) that doesn't
  have an obvious Solana analog by name — see Part 2 for what the analogous
  concept ("one dominant information-driven catalyst") would need to look
  like there. Also feeds only a flag, not the composite score.
- The async orchestrator `scoreWallet` (lines 223-230) is Polymarket end to
  end: `getActivityFromStart` (Polymarket API), `buildTrials` (Polymarket
  adapter), `TrackedWallet` (`src/wallets.ts`'s Polymarket-address-shaped
  config type).

Worth stating plainly: `computeProfitConcentration`, `computeConsistencyScore`,
and `computeQualityScore` (added to this file after this doc's first pass —
see "Revision history") introduce **zero new instances of this pattern**.
Every Polymarket-specific read in the entire file is still confined to
exactly these same two lines, both feeding flags, neither feeding the score.

**`src/api/client.ts`'s reliability pattern is architecturally reusable, not
literally reusable.** The pattern (per-host `RateLimiter`, bounded
`backoffDelayMs`+jitter retry that fast-fails on non-429 errors, a
`fetchWithTimeout` `AbortController` wrapper, zod `validate()`, a mockable
`fetchImpl` seam) has zero Polymarket-specific code in the mechanism itself
— `src/utils/rateLimiter.ts` and `src/utils/retry.ts` (both read in full)
are already fully generic and, in principle, importable as-is by a Solana
client. This pass's `src/markets/solana/client.ts` does exactly that: it
imports `RateLimiter` (`src/utils/rateLimiter.ts`) and `backoffDelayMs`/
`sleep` (`src/utils/retry.ts`) directly, unmodified — `src/utils/` is not in
this task's list of directories not to touch, and re-deriving the same
backoff math a second time would be exactly the kind of duplication
`docs/AUDIT.md` calls out elsewhere as a real risk (one bug fixed in two
places, or fixed in only one). What it does **not** import is anything from
`src/api/client.ts` itself (that file *is* off-limits, and its
`PolymarketApiError`/zod schemas/`fetchWithTimeout` wrapper are specific
enough to Polymarket's own response shapes that copying its *structure*
locally, rather than trying to generalize it in place under time pressure,
is the safer call for this pass) — a future refactor (Part 3 below) is where
the timeout/validate/error-type scaffolding itself would get promoted to a
shared `src/core/` location both markets' clients import from, once a
second real adapter's needs are known well enough to design that shared
shape properly instead of guessing at it from one example.

---

## 2. Proposed adapter interface

### Can `BacktestTrial`/`StrategyResult` be reused as-is?

**`StrategyResult` (`domain/types.ts:119-149`): yes, unchanged.** Nothing in
it names Polymarket. It's already exactly "the output of running
`computeStrategyResult` over some trials" — a general-purpose statistical
summary.

**`BacktestTrial` (`domain/types.ts:101-117`): structurally yes, semantically
each field needs a documented reinterpretation per market — not a schema
change, a documentation/convention change.** Field by field:

| Field | Polymarket meaning today | Solana-adapter meaning (proposed) |
|---|---|---|
| `conditionId` | Polymarket's market identifier | token mint address (or mint+pool if a wallet's realized P&L needs pool-level granularity — open question, see below) |
| `outcome` | `"Yes"`/`"No"`-style binary outcome string | not a natural fit — a spot trade has no "outcome" dimension. Proposed: a constant sentinel (`"LONG"`) so `distinctMarkets` (`conditionId`+`outcome` pair, `statistics.ts:102`) still degenerates correctly to "distinct tokens traded" |
| `eventKey` | Polymarket `eventSlug`, groups correlated sub-markets (ladder rungs) sharing one real-world bet | **the field earning the most caution.** For Solana, the natural first guess is "same token mint" — but that conflates two different correlation problems statistics.ts's bootstrap is built to catch: (a) many small trades in-and-out of the *same token* are genuinely one directional bet (correlated, same reasoning as Polymarket ladder rungs), but (b) two different tokens that pump/dump together because of a shared narrative (e.g. two dog-themed memecoins on the same day) are *also* correlated in a way pure per-mint grouping misses. Proposed: `eventKey` = token mint for a first pass (matches the existing "same underlying bet" idea exactly), with a documented open question about narrative-correlated cross-mint clustering as a known gap, not silently ignored |
| `category` | `categorize.ts`'s keyword taxonomy on market titles | a Solana-specific classifier, plugged in as an adapter-supplied function — see below |
| `entryPrice` | probability price in `[0,1]` | USD (or SOL) price per token unit at fill time — same *field*, different unit, no code in `statistics.ts` reads this field at all so this is a non-issue for the scoring core; only the Solana adapter's own `applyCosts`-equivalent needs to know the unit |
| `usdcStaked` | USD stake amount | USD-equivalent stake amount (Solana fills are natively SOL/token-denominated; the adapter must convert using the fill's own recorded price, the same way Polymarket's `usdcSize` is already a pre-converted USD figure the API provides directly — Solana has no such pre-converted field, so the adapter has to do this conversion itself, see Part 2 caveat) |
| `shares` | outcome shares (redeemable 1:1 at settlement) | token quantity held |
| `resolved` | Polymarket market has settled (`GammaMarket.closed`) | **no natural analog — see below, this is the load-bearing design question** |
| `won` | `outcomePrices[idx] > 0.5` | proposed: `netReturn > 0` on a **closed** position — i.e., copy the `mirror-exit` convention (`engine.ts:152`, `won: realizedPnl > 0`), not the `hold-to-resolution` convention (`engine.ts:80`, `outcomeWon(market, …)`) |
| `netReturn` | dollar P&L after fee/slippage | dollar P&L after fee/slippage/priority-fee — same concept |

**The single biggest finding of this exercise: Polymarket's two resolution
treatments are not equally portable, and the one this project treats as
"the original, simpler methodology" (`hold-to-resolution`) has no Solana
analog at all — only `mirror-exit` does.** `hold-to-resolution`
(`engine.ts:70-101`) fundamentally depends on an external oracle event (the
market settling to a final price) that exists for prediction markets by
construction and does not exist for a spot token. A Solana wallet's token
buy doesn't "resolve" — it just sits in the wallet, or gets sold, forever,
with no analog to "the market's real settled outcome" this project has built
its whole resolution-integrity discipline around (`resolveMarket`/
`outcomeWon`, the `GammaMarket.closed` check). **`mirror-exit`
(`engine.ts:103-157`) is the only viable resolution treatment for a Solana
adapter**, because it already defines "resolved" as "we observed both an
entry and an exit fill in the wallet's own activity" (`positionReconstruction.ts`'s
`closedAt !== null`) rather than "an external oracle settled." Its one
Polymarket-specific escape hatch — force-resolving a still-open position at
the market's settlement price when the wallet just never got around to
selling (`engine.ts:125-137`) — has no Solana equivalent and should simply
be dropped for a Solana adapter: a Solana position that's still open when the
dataset cutoff hits should be **excluded from the trial set** (same as
`mirror-exit`'s genuinely-unresolved branch, `engine.ts:138`), not
mark-to-market'd against a live price. Marking an open position at a live
price would smuggle look-ahead bias back in via a different door than the
ones this project has already found and fixed (README's repeated "shallow
pull only saw the wallet's best days" lesson, Phase 1d/1e) — an open,
appreciating position looks artificially good if you value it at "now"
instead of waiting for it to actually close.

**Proposed `MarketAdapter` interface** (illustrative TypeScript, not code to
write yet):

```ts
// A market-specific translation layer producing the one shared shape the
// scoring core (statistics.ts / rollingWindow.ts / walletScore.ts's flag
// logic) already knows how to consume. Nothing about this interface is
// implemented in this pass — it's the seam a future refactor would cut
// along, informed by having actually built one adapter (src/markets/solana/
// this pass) far enough to see where the seam naturally falls.
interface MarketAdapter<RawActivity> {
  // Pull a wallet's raw activity — this market's own API client underneath.
  fetchActivity(address: string, cutoff: number): Promise<RawActivity[]>;
  // The one function that matters: raw activity -> BacktestTrial[], doing
  // whatever position reconstruction / resolution-treatment logic this
  // market needs. For Polymarket this is buildTrials (engine.ts:159-164,
  // itself calling buildHoldToResolutionTrials OR buildMirrorExitTrials).
  // For Solana, per the finding above, this should ONLY implement the
  // mirror-exit-equivalent path — there is no hold-to-resolution analog.
  buildTrials(address: string, activity: RawActivity[], config: BacktestConfig): Promise<BacktestTrial[]>;
  // categorize.ts's role: title/activity -> category string. Market-owned,
  // scoring core only ever treats the result as an opaque grouping key.
  categorize(activity: RawActivity): string;
  // Which category value(s) represent a "one dominant catalyst" pattern
  // analogous to Polymarket's election-only flag (walletScore.ts:186) --
  // replaces the current hardcoded `=== "politics"` (line 173) with a
  // market-supplied list, since "one memecoin narrative dominates this
  // wallet's whole history" is the Solana-flavored version of the exact
  // same underlying risk (a wallet that looks skilled because of one
  // concentrated bet on one real-world/market event, not repeatable
  // trading).
  concentrationCategories: string[];
  // Which raw-activity rows count as a real trade for medianGapSeconds
  // (walletScore.ts:176-179's `type === "TRADE"` filter) -- Solana has no
  // "REWARD"-style non-trade row in the same sense, but a real adapter
  // still needs to decide what counts (e.g. exclude failed/reverted txs).
  isRealTrade(activity: RawActivity): boolean;
}
```

`computeWalletScore` itself would need one small, mechanical generalization
to actually consume this: replace the two hardcoded literals
(`"TRADE"`/`"politics"`) with adapter-supplied predicates/lists. That is the
only change this design proposes to the scoring core's *logic* — and,
per the reaffirmed finding above, it's the **only** change needed anywhere
in the scoring core, composite score included: `computeProfitConcentration`,
`computeConsistencyScore`, and `computeQualityScore` take zero
Polymarket-shaped input today and would need zero changes for a Solana
adapter to use them as-is. `statistics.ts`/`rollingWindow.ts` also need zero
changes.

### The real composite score, checked against this design (revised from a guess to a confirmed finding)

This doc's first pass, written before the rebase described in "Revision
history," could only guess at what a future composite score and
profitability floor might look like. Having now read the real
`computeQualityScore`/`computeProfitConcentration`/`computeConsistencyScore`
(`src/scoring/walletScore.ts:61-152`) in full: the guess was **substantially
right in spirit, and the real implementation is cleaner than the guess** —
no adapter-interface change is needed at all, versus the guess's hedge that
one "very plausible reading" would need one. Specifics worth recording:
- The real `roiLowerBound` term (line 108: `strategyResult.roiBootstrapCI
  ? strategyResult.roiBootstrapCI[0] : strategyResult.roi`) is almost
  exactly what the first-pass guess proposed — falling back to the point
  estimate when there's no CI (below `MIN_SAMPLE_SIZE`) rather than treating
  a missing CI as automatically bad, a detail the original guess didn't
  anticipate but that's clearly correct in hindsight (a thin-sample wallet
  should be caught by the separate `insufficient-sample` flag, not silently
  double-penalized inside the score too).
- The real profitability floor (lines 136-149) is a **two-term** AND
  condition (`roiLowerBound` AND `riskAdjustedReturn` both below neutral),
  not the single-term version the original guess considered — a real
  refinement, validated live against SDTrading (a genuinely net-negative,
  zero-veto-flag wallet that scored 63/100 before the cap existed, entirely
  because near-perfect concentration/drawdown/sample-size terms outweighed
  two weak profitability terms). Neither term references anything
  Polymarket-specific.
- **Net implication for Phase D, stated plainly**: a Solana `MarketAdapter`
  implementation does not need to reimplement, extend, or even think about
  the composite score. Once `MarketAdapter.buildTrials` produces a
  `BacktestTrial[]` and `MarketAdapter.isRealTrade`/`concentrationCategories`
  are supplied for the two flag-only literals, `computeWalletScore` — flags
  AND composite score together — runs unchanged. This is a stronger claim
  than the original design could make, and is the main thing this revision
  adds beyond correcting the record.

---

## 3. Proposed directory layout (design only — no files moved this pass)

Today's flat `src/` (post `docs/IMPROVEMENT_PLAN.md` Track C's moves) has
`domain/`, `api/`, `backtesting/`, `scoring/`, `storage/`, `tracking/`,
`paperTrading/`, `research/`, `legacy/`, `cli/`, `utils/`, `config/`, plus
root-level `wallets.ts`, `index.ts`. Proposed future shape (again: **not**
executed now):

```
src/
  core/                        # <- renamed from domain/, or domain/ kept as-is;
                                #    naming bikeshed, not an architectural
                                #    decision -- see open questions
    types.ts                   # BacktestTrial, StrategyResult, WalletScore,
                                # WalletFlag, Trackable, WalletHealth,
                                # ApiErrorRecord/PollOutcome -- the pieces of
                                # today's domain/types.ts that are already
                                # market-agnostic (see Part 1)
    statistics.ts               # unchanged, moved as-is
    rollingWindow.ts             # unchanged, moved as-is
    walletScore.ts                # computeWalletScore/computeProfitConcentration/
                                # computeConsistencyScore/computeQualityScore
                                # ALL move here as-is (reaffirmed Part 1/2:
                                # the composite score reads only
                                # BacktestTrial[]/StrategyResult, zero
                                # Polymarket-specific surface) -- only
                                # computeWalletScore's two hardcoded literals
                                # (isRealTrade/concentrationCategories) need
                                # to become adapter-supplied instead of
                                # hardcoded. scoreWallet's async orchestrator
                                # part is NOT here -- it's market-specific,
                                # moves to each markets/<name>/ namespace
                                # instead
    utils/
      rateLimiter.ts             # promoted from src/utils/ -- already fully
      retry.ts                  # generic, both markets' clients would import
                                # these instead of each re-implementing them
                                # (this pass's solana/client.ts does
                                # re-implement locally -- see Part 1's note on
                                # why, and see below)

  markets/
    polymarket/                 # today's Polymarket-specific code, moved
                                # here wholesale in a future pass -- api/,
                                # backtesting/engine.ts (buildTrials +
                                # resolveMarket/outcomeWon), research/
                                # categorize.ts, tracking/, paperTrading/,
                                # legacy/, wallets.ts. Storage (see below)
                                # is the one piece that needs a real design
                                # decision, not a pure move.
      client.ts                 # <- src/api/client.ts
      schemas.ts                # <- src/api/schemas.ts
      engine.ts                 # <- src/backtesting/engine.ts (the adapter:
                                # buildTrials implementing MarketAdapter)
      categorize.ts              # <- src/research/categorize.ts
      wallets.ts                 # <- src/wallets.ts
      tracking/                  # <- src/tracking/
      paperTrading/              # <- src/paperTrading/
      legacy/                    # <- src/legacy/ (unchanged content, just
                                # relocated under the namespace)

    solana/                     # this pass's client.ts lives at
                                # src/markets/solana/client.ts already --
                                # this row already exists, not proposed
      client.ts                 # Helius/Birdeye API wrapper (Part 2 below)
      schemas.ts                # (future) zod schemas once a real key
                                # confirms response shapes
      engine.ts                 # (future, Phase D) buildTrials implementing
                                # MarketAdapter -- mirror-exit-only per the
                                # finding above, needs its own position-
                                # reconstruction (token buy/sell lots, not
                                # Polymarket's binary-outcome-share model --
                                # positionReconstruction.ts's avgCost/
                                # realizedPnl math is a weighted-average-cost
                                # inventory model that's actually much closer
                                # to what a Solana adapter needs than
                                # anything else in backtesting/, but it's
                                # written in terms of conditionId/outcome and
                                # would need its own Solana-flavored sibling
                                # rather than a direct import, since a
                                # position here is (mint, wallet), not
                                # (conditionId, outcome))
      categorize.ts              # (future) Solana-specific taxonomy

  backtesting/                  # (future) thin, market-agnostic reporting
                                # CLIs that take a MarketAdapter + wallet list
                                # and print a StrategyResult -- today's
                                # src/cli/backtest.ts,walletScore.ts,
                                # paperReport.ts generalized to accept
                                # "--market=polymarket|solana"
  storage/                     # see below -- the one real design call
  cli/
  index.ts
```

**Storage is the one place a pure rename doesn't resolve cleanly, and is
worth naming explicitly rather than hand-waving.** Two options, neither
executed now:
- **(a) One market-agnostic `trials` cache table** (columns matching
  `BacktestTrial`'s fields, plus a `market` discriminator column) that every
  adapter populates, with each market's *raw* activity kept in its own
  market-specific tables (`polymarket_wallet_activity`,
  `solana_wallet_activity`, differently shaped). This is what lets
  `statistics.ts`/`walletScore.ts` run against either market's data without
  caring which one produced it — genuinely the cleanest cut given how thin
  the actual dependency turned out to be (Part 1's finding that
  `statistics.ts` reads exactly seven fields).
- **(b) Fully separate per-market schemas**, no shared table at all — simpler
  migration story (today's `wallet_activity`/`paper_orders` tables literally
  don't change), but pushes the "produce a `BacktestTrial[]`" step to always
  happen at read time from each market's own tables, never cached.

No recommendation forced here — (a) is more work up front and pays off if a
third market ever gets added; (b) is less work and is fine if Solana stays
the only second market for a long time. This is exactly the kind of call
`docs/IMPROVEMENT_PLAN.md`'s Track B/C entries made explicitly (e.g. B.6's
"keep both, rename for clarity" over migrating) — a deliberate, documented
choice for whoever does the real refactor, not a default to back into.

---

## 4. Blueprint concepts that do NOT belong in a wallet-scoring core

Per the task brief's own framing of the meteorabot-derived blueprint
conversation (unverifiable in this repo per the note at the top, but taken
at face value since it's the direct instruction under which this doc was
written): the blueprint was written for a Solana sniping/execution bot, and
several of its concepts are real and worth building eventually, but are
**downstream of, or orthogonal to, wallet quality scoring** — bolting them
into the scoring core would be the same kind of layering mistake this
project has explicitly avoided elsewhere (e.g. `docs/AUDIT.md`'s repeated
insistence that resolution/price-lookup logic lives in exactly one place,
not duplicated per script).

- **Token security / LP / mint-authority filters.** This answers "is this
  token safe to trade at all" (rug-pull risk, mint authority not revoked,
  thin/single-sided liquidity) — a property of the **token**, checked once
  before ever considering a trade, completely independent of which wallet is
  trading it. It belongs in a pre-trade gate a Solana adapter's execution
  path would consult (analogous to nothing in this project today —
  `meteorabot`'s closest analog is its pool-TVL/depth checks in
  `scanPairs.ts`/`raydiumOnchain.ts`, not wallet-scoring code at all). Wallet
  scoring should never need to know a token passed a security filter; it
  scores *behavior*, not *instrument safety*.
- **Execution / risk-gate engines** (position sizing, kill switches, daily
  loss caps, leg-risk handling). This is meteorabot's `liveTrader.ts` and
  this project's own `docs/LIVE_READINESS.md` — explicitly a **later,
  separate gate** ("Standing rule" F.17: no execution code without an
  explicit go-ahead). A wallet-scoring core answers "should we copy this
  wallet"; an execution engine answers "given that yes, how do we place and
  protect a real order." These are different projects that happen to share
  an input (a scored, approved wallet) — the scoring core should produce a
  clean signal and stop there, same as this project's own paper-trading
  engine already does today (`src/paperTrading/engine.ts` books hypothetical
  P&L, it doesn't place real orders).
- **Market-regime detection** (e.g., "is the broader market risk-on/risk-off
  right now, gate strategy activity on that"). This is a property of the
  **market as a whole** at a point in time, not of any individual wallet —
  it would sit *above* wallet scoring as a separate signal a future
  strategy-selection layer might combine with a wallet's score, not
  something the scoring core computes or needs. Nothing in this project has
  ever needed this (Polymarket's per-wallet analysis has never needed a
  "market regime" concept), which is itself a useful data point: it may be a
  genuinely Solana/DeFi-flavored need (volatile, narrative-driven markets)
  that prediction markets don't have in the same way.

None of these three are started in this pass, and none of them are implied
by anything built in Part 2 below — the Solana client scaffolded there is
strictly a data-fetching layer, with no security/risk/regime logic anywhere
near it.

---

## Open questions for the user + orchestrator to resolve before Phase D

1. ~~**The Track G / composite-score discrepancy**~~ — **Resolved** (see
   "Revision history" at the top): a harness/isolation quirk left this
   worktree's branch four commits behind local `master`. Rebased onto the
   real `master`; the composite score, profitability floor, and Track G all
   exist and are reflected throughout this revision.
2. **`eventKey` for Solana** (Part 2): same-mint grouping is the obvious
   first cut and matches the existing Polymarket convention most closely,
   but doesn't catch cross-mint narrative correlation (two memecoins pumping
   together). Worth a real decision, not a default, once real data exists to
   check it against — same spirit as this project's own repeated "don't
   guess a threshold, check it" discipline.
3. **`hold-to-resolution` has no Solana analog** (Part 2) — confirms that a
   Solana `MarketAdapter.buildTrials` can only ever be a `mirror-exit`
   analog. Worth the user explicitly signing off on this before Phase D
   writes real position-reconstruction code, since it's a bigger conceptual
   gap than a first read of `BacktestTrial`'s field list suggests.
4. **Storage: shared `trials` cache table vs. fully separate per-market
   schemas** (Part 3) — no recommendation forced; needs a real decision once
   there's a second market's data to actually store.
5. **What a Solana "one dominant catalyst" flag should trigger on** (Part 2's
   `concentrationCategories` idea) — Polymarket's `election-only` flag is a
   very specific, well-evidenced pattern (this project independently
   rediscovered it multiple times, README Phase 1c). The Solana analog is a
   guess (one memecoin narrative dominating a wallet's whole history) with
   zero validation yet — flagged as a guess, not a finding.
6. **Are the composite score's weights (30/20/15/15/10/10) and `squash()`
   scales Polymarket-tuned in a way that wouldn't transfer?** They're
   explicitly documented in the real code as "starting points... not tuned
   against the full 68-wallet pool yet" (`walletScore.ts` comments) even for
   Polymarket alone. A Solana wallet population plausibly has structurally
   different characteristics worth checking before assuming the same
   weights generalize — e.g. drawdown may be a noisier signal for a
   volatile memecoin-trading wallet than for a probability-bounded
   Polymarket wallet, and `MIN_SAMPLE_SIZE`-relative sample-size scaling
   (line 125) may need a different denominator if Solana wallets typically
   generate far more or fewer independent events per unit time than
   Polymarket ones do. Not a blocker for Phase D's adapter-building work,
   but worth checking once real Solana wallet data exists to check it
   against — same "don't guess a threshold" discipline as everywhere else
   in this project.
