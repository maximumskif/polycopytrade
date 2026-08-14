# polycopytrade

Studying and copying/improving on profitable public Polymarket wallets,
rather than designing a prediction-market edge from scratch. Sibling project
to `meteorabot` (Solana DEX arb) — same "paper trade first, gate real
execution behind a deliberate decision" philosophy, different chain/market.

## Origin

Kicked off by [@0x_exit's post](https://x.com/0x_exit/status/2086940839834444084)
profiling a wallet that turned $500 into a claimed $264k (53.6% win rate)
since June 2026, by only trading Polymarket's recurring BTC/WTI oil
price-ladder markets ("what price will bitcoin hit"). Mechanic: retail bets
pile onto exciting longshot rungs, mechanically dragging the boring/likely
rung down to 6-30c; the wallet buys that cheap and holds to expiry for the
full $1. Slow, low-variance, mechanical — not copy-trading-dependent, since
it exploits Polymarket's own market structure rather than the wallet's
information.

## Trader archetypes being studied

Provisional — assigned from public profiles/leaderboard before looking at
real trade history. `npm run track-wallets` pulls the real data; update this
table once Phase 1 backtesting confirms or corrects them.

| Wallet | Archetype | Notes |
|---|---|---|
| `0x72a0...1c059` (0x_exit's wallet) | ladder-harvester | BTC/WTI price-ladder mispricing — **backtested negative, see Phase 1 findings below** |
| `0xe30e...96b87` | live-sports whale | Corrected from "sniper": 11 real orders (after fill-clustering), avg $54,987, live Challenger-level tennis |
| `0x16bb...a8492` (SDTrading) | sports-systematic | MLB O/U + moneyline, 283 real orders, avg $8,522 |
| `0x6d20...9a165` (Djdjdjekekek) | live-sports whale | Corrected from "whale-conviction": 30 real orders, avg $79,597, live tennis + LoL esports, not macro |
| `0x204f...da95e14` (swisstony) | live-sports scalper | Confirmed: 122 real orders, avg $325, high-frequency within hours |

**Important gotcha:** a `polymarket.com/@<slug>` profile URL is *not* the
wallet to query — that slug is a display identifier. The real address
(`proxyWallet`, the one holding funds/positions) must be resolved via
`resolveProxyWallet()` in `src/polymarketClient.ts`
(`gamma-api.polymarket.com/public-search?search_profiles=true`). Confirmed
by testing: querying `data-api.polymarket.com/positions` with the slug
address for 0x_exit's wallet silently returned `[]`.

## APIs (confirmed working, no auth needed for Phase 0/1)

- `data-api.polymarket.com/positions?user=<address>` — current positions
- `data-api.polymarket.com/activity?user=<address>` — trade history
- `gamma-api.polymarket.com/public-search?q=<query>` — search events/markets/profiles (the real search; `/markets?search=` is silently ignored)
- Rate-limits aggressively (429s within seconds of a handful of calls) — `polymarketClient.ts` throttles every call to ~1/sec with backoff on 429.
- Order placement (CLOB API) needs a signer private key + API credentials — not wired up, see Roadmap.

## Phase 1 findings (2026-08-11)

### Ladder-harvesting backtests NEGATIVE — do not fund

`npm run backtest-ladder` replays 138 real historical BTC/WTI monthly-ladder
rungs (Mar-Aug 2026): buy whichever side sits in the 5-45c "harvest zone"
the first time it gets there, hold to expiry. Two independent passes, one
requiring the rung to have been a genuine early toss-up (>=20c both sides)
before drifting cheap, to rule out "this was always a longshot decaying to
zero" contamination:

| Bucket | n | win rate | breakeven win rate | net |
|---|---|---|---|---|
| 5-15c | 37 | 8.1% | ~10% | -91.9% |
| 15-25c | 36 | 8.3% | ~20% | -91.7% |
| 25-35c | 29 | 10.3% | ~30% | -89.7% |
| 35-45c | 31 | 32.3% | ~40% | -67.7% |
| **All** | **138** | **14.5%** | — | **-85.5%** |

Every bucket loses, and not marginally — actual win rate is roughly
**half or less of the breakeven rate the entry price implies**. That's not
"no edge," it's negative edge: these rungs are systematically *overpriced*
relative to how often they actually resolve YES, the opposite of 0x_exit's
claim. The early-contested filter (excluding rungs that were deep longshots
from the start) only removed 15 of 153 trials and barely moved the result,
so this isn't an artifact of conflating "genuine mispricing" with "normal
decay to zero" — the literal "buy anything under 45c" rule is a value trap
either way. **Conclusion: the tweet's claimed strategy, taken at face
value, does not survive contact with historical data. Do not fund a
ladder-harvester with real capital based on this.** Possible explanations
for the gap: the wallet uses a much more selective entry rule than a static
price band (timing, size, or rung selection we haven't reverse-engineered),
the $264k figure is cherry-picked/unverified, or this backtest's ~6-month,
2-asset sample doesn't generalize. Any of those needs more evidence before
this track gets revisited.

### The real signal: 3 of the top 4 monthly earners share one pattern

`npm run wallet-stats` clusters raw fills into real orders (the activity API
logs every partial fill separately, which inflates naive "trade count" — a
single order against a thin book can show up as 40+ rows at the same
price). After clustering:

| Wallet | Real orders | Avg order size | Category |
|---|---|---|---|
| Djdjdjekekek (#1 monthly profit) | 30 | $79,597 | live tennis (Challenger-level) + esports (LoL) |
| 0xE30E7... (#3) | 11 | $54,987 | live tennis, one obscure Challenger match |
| swisstony (#2) | 122 | $325 | live tennis/football, high-frequency |
| SDTrading (#8) | 283 | $8,522 | MLB props (spreads, O/U, first-inning) |
| 0x_exit | 330 | $73 | BTC/WTI ladders, very diversified |

Three of the top four monthly earners — independently, per the leaderboard —
are running large-to-huge directional bets on **thin, low-profile live
sports/esports markets**, not crypto and not politics. That's a stronger
signal than the ladder tweet: it's cross-validated by three unrelated top
earners' real P&L, not one anecdote. Not yet backtested (needs live
match-state ground truth, e.g. a tennis live-score feed, to check whether
these bets show real predictive skill or just get lucky on big variance) —
this is the most promising next track.

### Would copying each wallet's actual historical buys have paid off?

`npm run wallet-backtest` mirrors every tracked wallet's real BUY fills
(not a hypothesized rule — their actual trades) and holds to resolution,
resolving against the market's real settled outcome via
`getMarketByConditionId()`. This is the direct "should we copy this wallet"
question.

**Trustworthy results** (large enough distinct-market count that the
sample isn't dominated by a couple of events):

| Wallet | Resolved fills | Distinct markets | Win rate | Net |
|---|---|---|---|---|
| RN1 | 390 | 59 | 47.7% | **+20.0%** |
| Djdjdjekekek | 1850 | 37 | 74.2% | **+10.2%** |
| swisstony | 176 | 57 | 56.8% | +4.9% |
| 0x_exit | 750 | 16 | 55.5% | +5.6% |
| 0xE30E7... | 1630 | 34 | 73.7% | +2.8% |
| SDTrading | 1556 | 673 | 50.5% | -2.7% |
| kch123 | 1936 | 49 | 53.8% | **-34.0%** |

Notes: SDTrading's -2.7% is the single most statistically solid number here
(673 distinct markets, by far the largest sample) — but it likely
undersells their real edge, since the "buy and hold to resolution" model
can't capture active position management (partial exits, hedges) that a
high-frequency sports trader plausibly does; their actual monthly-leaderboard
profit (+$410K) says the real strategy works, just not the naive copy of it.
RN1 is the most interesting standout: sub-50% win rate but strongly net
positive — an asymmetric-payoff hunter (loses more often than wins, but
wins pay disproportionately), a genuinely different archetype from the
"buy likely favorites" style of Djdjdjekekek/0xE30E7. kch123's -34% rules
it out as a copy target despite its all-time-leaderboard profit — another
case where the real (unknown) strategy isn't "buy and hold."

**NOT trustworthy — a look-ahead/sample-concentration trap** (added from
the all-time leaderboard, then this same backtest applied): Theo4,
Fredi9999, fishalive, mintblade, GRIMDRIP, and RepTrump all showed
99-100% win rates and 87-209% net returns. Before trusting that,
checked how far back the pulled sample actually reached — Theo4 and
Fredi9999 have traded since **October/August 2024** (2 years), but the
2000-fill window our current pull covers landed entirely within a small
recent slice dominated by just 2-12 distinct markets. That's the signature
of a look-ahead trap, not skill: we're sampling activity from right after
their few career-defining bets already resolved in their favor, not a
representative slice of decisions made before the outcome was known. A
trader who got famous for one huge correct call will show 100% win rate on
any window that happens to only contain that call — this says nothing
about whether copying them prospectively would work. **Do not build
anything on these 6 wallets' numbers without pulling much deeper history
first** (current `getActivityDeep` caps at 4 pages / ~2000 fills; the API
supports offset up to 5000, worth extending, and even that may not reach
across a full 2-year history for the busiest wallets).

**Real finding that DOES survive this caveat:** Theo4, Fredi9999, and
RepTrump are dedicated **politics** traders (394/470/491 of their ~500
most-recent fills respectively) — a category none of the original 5
wallets touched. Worth deeper backtesting once pulled with real historical
depth, but flagged here as a legitimate category discovery, independent of
whether their win-rate numbers above hold up.

### Weather: same ladder shape, likely different edge source

Live temperature-ladder markets (NYC, London, Paris — 11 rungs/day, same
structure as BTC/WTI) look efficiently priced already: 1-2 rungs cluster
near the real forecast, the rest sit near 0 or 1. That's not the "retail
lottery-ticket demand" pattern — it looks like it needs an actual
forecast-model edge (NOAA/ECMWF data feed) to beat. Real category, but a
different, separate project (data feed integration, not a ladder scanner).

## Phase 1c findings (2026-08-12)

### The 6 look-ahead-suspect wallets: confirmed one-shot 2024-election bets, not skill

Pulled each wallet's full history up to the public API's offset cap
(`getActivityDeep(address, 10)` = 5000 fills, up from 4 pages/2000) for
Theo4, Fredi9999, fishalive, mintblade, GRIMDRIP, and RepTrump — the six
wallets whose Phase 1b numbers (99-100% win rate, 87-209% net) were flagged
as a probable look-ahead/sample-concentration artifact.

**Theo4, Fredi9999, RepTrump:** the full 5000-fill pull (hitting the API's
offset cap) shows their *entire* visible activity is packed into a 9-16 day
window in **October-November 2024**, entirely around the US presidential
election (`Will Donald Trump win the 2024 US Presidential Election?`,
`Which party wins 2024 US Presidential Election?`), and then **nothing at
all for the ~21 months since** — confirmed by inspecting raw timestamps
directly, not inferred from the backtest output. This isn't a shallower-pull
artifact anymore: pulling as deep as the public API allows still shows a
dormant account with one concentrated event in its history. Their
politics-only backtest slice (new: `walletBacktest.ts` now tags every trial
by category and reports this split) is nearly identical to their whole-wallet
number (Theo4 99.4%/99.4%, Fredi9999 99.9%/99.8%, RepTrump 100%/100% —
win rate whole-wallet vs politics-only) because politics *is* effectively
their whole wallet. **Conclusion: these are single-event accounts that got
lucky (or informed) on one real-world outcome, not traders with a repeatable
edge. Ruled out as copy-trade candidates — do not revisit without evidence
of NEW activity since Nov 2024.** Archetype updated from `unclassified` to
a new `one-shot-bet` in `wallets.ts`.

**fishalive, mintblade, GRIMDRIP:** these hit "reached end of history" well
under the 5000-fill cap (1686 / 735 / 675 total fills ever) — meaning their
tiny 2-5 distinct-market footprint isn't a pagination limit either, it's
their genuine complete lifetime activity on Polymarket. Same fundamental
problem as the election-bet wallets (near-100% win rate from a handful of
concentrated large bets, not a large enough sample to say anything about
skill) even though these three aren't politics-flavored. Also relabeled
`one-shot-bet`.

### Unplanned finding: the backtest is unstable for high-frequency wallets

Re-running `wallet-backtest` a day later (unrelated to the deeper-history
work above — Djdjdjekekek/RN1/swisstony still use the same 4-page/2000-fill
window as Phase 1b) produced very different numbers than the ones in the
Phase 1b table below:

| Wallet | Phase 1b (2026-08-11) | Phase 1c re-run (2026-08-12) |
|---|---|---|
| Djdjdjekekek | +10.2% net, 74.2% win, 37 markets | **-15.3%** net, 50.0% win, 39 markets |
| RN1 | +20.0% net, 47.7% win, 59 markets | **-10.6%** net, 45.2% win, 87 markets |
| swisstony | +4.9% net, 56.8% win, 57 markets | 1 resolved fill (1905 of 2000 still open) — unusable |

Root cause, confirmed by inspecting raw fetched timestamps: `getActivity`'s
"most recent 2000 fills" is a fundamentally different slice of history each
time it's called for a very high-frequency wallet. Today's pull for
Djdjdjekekek spans Aug 8-12; RN1's spans **4 hours** (Aug 12, 17:00-20:50) —
that wallet fires ~500 fills/hour. Most very recent trades haven't resolved
yet at whatever moment the backtest happens to run, so `skippedStillOpen`
swings wildly and the resolved-trial sample is close to arbitrary. **This
means Djdjdjekekek and RN1's Phase 1b numbers should not be trusted as a
stable signal** — they were one snapshot, not a repeatable measurement, and
this session's re-run landed on the opposite sign for both. Before Phase 2
paper-trades either wallet, `walletBacktest.ts` needs a fixed historical
cutoff (e.g. "only fills older than N days," not "most recent N fills as of
right now") so results are reproducible across runs instead of dependent on
when you happen to hit the API. Not implemented yet — flagging as the actual
next blocker, ahead of starting Phase 2.

### Also fixed while here

`walletStats.ts` had a stale bug: a leftover comment said `getActivity`
didn't support offset pagination and the loop `break`-ed after page 0,
silently re-analyzing the same most-recent 500 fills regardless of the
`pages` argument. `getActivity` gained an `offset` param back in Phase 1b
but this caller was never updated. Fixed to actually paginate; the
category classifier (`categorize()`) was also extracted into
`src/categorize.ts` so both `walletStats.ts` and `walletBacktest.ts` share
one implementation instead of drifting.

## Phase 1d findings (2026-08-12/13)

### Fixed the reproducibility bug: backtest now pulls from each wallet's genesis, not "now"

Added `getActivityFromStart()` to `polymarketClient.ts` — pages the
`/activity` API with `sortDirection=ASC` from `offset=0` instead of `DESC`
from the present. Confirmed by testing (`offset=0`/`offset=500` with
`sortDirection=ASC` returned contiguous, non-overlapping, correctly-ordered
batches) that this is stable: a wallet's oldest fills don't change as new
ones come in, so the same fetch returns the same trial set on any future
run — unlike the old "most recent N fills" pull, which was a different,
mostly-unresolved slice every time for high-frequency wallets (see Phase
1c's Djdjdjekekek/RN1 finding). `walletBacktest.ts` now uses this
exclusively, with one flat `BACKTEST_PAGES = 10` (5000 fills) for every
wallet instead of a per-wallet override.

**Verified the fix actually works**, not just in theory: ran
`npm run wallet-backtest` twice back to back over the original 13 wallets —
the two runs produced **byte-for-byte identical output**. That's the actual
bar Phase 1d needed to clear.

### Re-tested all 13 original wallets under the fixed methodology

| Wallet | Win rate | Net | Distinct markets | Notes |
|---|---|---|---|---|
| **0x_exit's wallet** | **62.1%** | **+33.8%** | **106** | Earliest 12 days only (hit page cap — much more history exists). First wallet in this whole project with both >50% win rate AND a large, diversified sample. See below. |
| 0xE30E7 | 68.1% | -4.5% | 69 | High win rate, negative net — asymmetric losses. |
| SDTrading | 47.3% | -1.0% | 867 | Full history (2740 fills total). Roughly breakeven, same as Phase 1b — consistent with "buy and hold undersells an active manager." |
| Djdjdjekekek | 37.7% | +22.2% | 52 | Sub-50% win, still net positive (asymmetric payoff) — but see Phase 1c: this wallet's numbers were unstable before this fix, treat this as the first trustworthy read, not confirmed-by-repetition yet. |
| swisstony | 48.6% | -0.4% | 426 | Roughly breakeven, large sample. |
| kch123 | 40.3% | -15.0% | 175 | Negative, consistent with Phase 1b — stays ruled out. |
| RN1 | 46.2% | +3.9% | 483 | Largest sample of the original 13, near-breakeven. |
| Theo4 / Fredi9999 / RepTrump | 67-100% | +85-141% | 6-8 | Confirms Phase 1c: still entirely the Oct 2024 election window even from genesis. |
| fishalive / mintblade / GRIMDRIP | 100% | +105-210% | 2-5 | Confirms Phase 1c: full lifetime history, tiny market count. |

**0x_exit's own wallet is the standout finding of Phase 1d.** The project
was founded on a hypothesized *rule* ("buy the cheap side of a BTC/WTI
ladder, hold to expiry") attributed to this wallet, which backtested at
-85.5% (Phase 1a). But this wallet's *actual* trades — whatever real,
unknown logic it uses — now show 62.1% win rate across 106 distinct markets
with only the earliest 12 days of its history sampled (it hit the 5000-fill
page cap, so this wallet has substantially more real history beyond what's
tested here). That's a meaningfully different animal from the one-shot-bet
wallets: high market diversity per unit time, not a couple of concentrated
lucky calls. **This deserves focused follow-up**: pull deeper pages
specifically for this wallet (raise its `historyPages` past 10, or narrow
the analysis to a specific market category it trades) to see if the edge
holds over a longer window, and inspect what it's actually buying — the
real rule clearly isn't the naive ladder-harvest one.

### Scanned the leaderboard for more candidates — same pattern, mostly

Pulled ranks 8-20 of `polymarket.com/leaderboard/overall/all/profit` (ranks
1-7 and 14-15 were already tracked) and ran all 11 new wallets through the
same fixed-cutoff backtest:

| Wallet | Win rate | Net | Distinct markets | Verdict |
|---|---|---|---|---|
| frostrizz | 99.9% | +62.4% | 6 | One-shot-bet (26-day total lifetime) |
| Len9311238 | 100% | +115.6% | 7 | One-shot-bet (93% politics, Oct 2024 election) |
| sparklingwater123 | 92.2% | +87.2% | 4 | One-shot-bet |
| zxgngl | 100% | +56.4% | 2 | One-shot-bet (99.9% of fills in ONE market) |
| endlessFate | 85.4% | +52.4% | 9 | One-shot-bet (27-day total lifetime) |
| PrincessCaro | 92.3% | +47.5% | 19 | One-shot-bet (79% politics, Oct 2024 election) |
| walletmobile | 100% | +61.7% | 1 | One-shot-bet (literally one market) |
| DEEDDIT | 84.6% | **-15.4%** | 11 | High win rate but net NEGATIVE — ruled out |
| BreakTheBank | 30.9% | -9.2% | 73 | Ruled out on win rate alone |
| unnamed #12 (`0x2c3350...`) | 60.0% | -1.6% | **670** | Largest sample of ANY wallet studied, >50% win rate, but ~breakeven net — not concentrated, but not clearly profitable under hold-to-resolution either |
| KeyTransporter | 67.3% | +45.7% | 15 | Full 24-day lifetime reached — borderline sample size, worth a second look |

**The one-shot-bet pattern generalizes far beyond the original 6**: 7 of
these 11 additional top-20 wallets show the exact same signature (a handful
of distinct markets, a short total lifetime, several literally in the same
Oct-2024 US election window as Theo4/Fredi9999/RepTrump). At this point
it's fair to say **most of the all-time profit leaderboard is populated by
one-shot bettors, not traders with a demonstrated repeatable edge** — this
should be the default assumption for any future wallet pulled from that
leaderboard, not something to re-discover per wallet.

**Net takeaway for "who should Phase 2 paper-trade":** nothing here fully
clears the bar of ">50% win rate + large diversified sample + solidly
positive net" except **0x_exit's own wallet**, and even that needs deeper
history pulled before treating it as confirmed. `unnamed #12` and
KeyTransporter are the next things worth a deeper look (bigger `historyPages`
pull) if 0x_exit's wallet doesn't pan out.

### Phase 1e: 0x_exit's wallet pulled to its full history — edge holds, but is much smaller than it looked

Two blockers fixed to make this possible: (1) `walletBacktest.ts` had a flat
`BACKTEST_PAGES = 10` that ignored `wallets.ts`'s per-wallet `historyPages`
entirely — raising the field alone did nothing; the script now uses
`wallet.historyPages ?? BACKTEST_PAGES`. (2) `getActivityFromStart`'s
`offset` param is hard-capped by the API — confirmed directly, offset=5000
succeeds and offset=5500 400s, for every wallet, regardless of `start`.
Fixed by re-opening the window: once a window 400s or is exhausted, `start`
advances to the last fill's own timestamp and `offset` resets to 0, so a
wallet's full history can be walked in ~11-page windows instead of stopping
at the first one (fills deduped across the window boundary since the
boundary fill is re-fetched).

With that fixed, pulling 40 pages against 0x_exit's wallet reached **its
entire lifetime — not page-capped, "this is the wallet's full history."**
The account is only 23 days old (2026-04-24 to present) but extremely
high-frequency: 19,995 total fills, 18,651 resolved BUY fills across 253
distinct markets.

**Result: win rate 53.3%, net +7.1%** — down sharply from Phase 1d's
62.1%/+33.8% read, which turned out to be an early-days snapshot (its first
12 days / 106 markets, before the 10-page cap was reached) that was not
representative of the full 23-day/253-market picture. The edge did not
vanish — it's still net positive with a win rate above 50%, still the best
fully-checked lead in the project — but Phase 1d overstated its magnitude by
roughly 5x. **Lesson for the project generally: an edge measured on a small
early slice of a wallet's history should be treated as provisional until
retested on the wallet's full history — this is now the second time a
shallow pull (Phase 1c's look-ahead issue was the first) made a wallet look
better than it is.**

## Roadmap

1. ~~Phase 0: data pipeline~~ — `walletTracker.ts`, `ladderScanner.ts`.
2. ~~Phase 1a: backtest ladder-harvesting~~ — `backtestLadder.ts`.
   **Result: negative edge, track killed pending new evidence.**
3. ~~Phase 1b: backtest copying each tracked wallet's real trades~~ —
   `walletBacktest.ts`, expanded `wallets.ts` with 8 all-time-leaderboard
   traders. **Result: Djdjdjekekek (+10.2%, n=37 markets) and RN1 (+20.0%,
   n=59 markets) looked like the strongest trustworthy leads at the time. 6
   newly-added wallets' near-100% win rates flagged as a likely look-ahead
   sample-concentration artifact. Phase 1c below both confirmed the latter
   and found Djdjdjekekek/RN1's numbers themselves aren't stable — don't
   trust either bullet at face value, read Phase 1c.**
4. ~~Phase 1c: pull deeper history for the 6 suspect wallets, backtest
   the politics category~~ — **Result: confirmed, not just suspected, that
   Theo4/Fredi9999/RepTrump/fishalive/mintblade/GRIMDRIP's near-100% win
   rates come from a one-shot concentrated event (mostly the Nov 2024 US
   election), not repeatable skill — even the deepest pull the public API
   allows still shows a dormant account. All six relabeled `one-shot-bet`,
   ruled out as copy-trade candidates.** Surfaced a bigger unplanned
   problem: Djdjdjekekek and RN1's Phase 1b numbers turned out to be
   unstable across re-runs (both flipped sign) because the backtest samples
   "most recent N fills," which is an arbitrary, mostly-unresolved slice for
   high-frequency wallets. `walletStats.ts`'s offset-pagination bug also
   fixed (was silently re-analyzing page 0 only).
5. ~~Phase 1d: make `walletBacktest.ts` reproducible~~ —
   `getActivityFromStart()` (pulls from each wallet's genesis instead of
   "now"). **Result: verified fix works (two consecutive runs produced
   byte-for-byte identical output). Re-tested all 13 original wallets;
   scanned leaderboard ranks 8-20 for 11 more. Confirmed the one-shot-bet
   pattern extends to most of the top-20 leaderboard. The one standout:
   0x_exit's own wallet — 62.1% win rate, 106 distinct markets, +33.8% net,
   from only its earliest 12 days of history (page-capped, more exists).
   First wallet in the project with both a >50% win rate and a large,
   non-concentrated sample. See Phase 1d findings above.**
6. ~~Phase 1e: pull 0x_exit's wallet deeper~~ — fixed `walletBacktest.ts`
   to actually honor per-wallet `historyPages` (was hardcoded), and fixed
   `getActivityFromStart` to page past the API's offset cap by advancing
   `start`. **Result: pulled the wallet's entire 23-day lifetime (19,995
   fills, 253 distinct markets). Win rate 53.3%, net +7.1% — the edge
   holds (still >50% win, still net positive, still the best lead in the
   project) but is much smaller than Phase 1d's early-snapshot read
   suggested. See Phase 1e findings above.**
7. Phase 1f (not started): inspect what 0x_exit's wallet is actually
   buying (category/price-band breakdown of the 253 resolved markets) to
   understand the real selection rule before committing to Phase 2 — a
   thin +7.1% edge is not yet obviously worth paper-trading as-is. Also
   worth a deeper (full-history) pull for `unnamed #12` and KeyTransporter
   as fallbacks if this doesn't look strong enough on inspection.
8. Phase 2: paper trade whichever leads survive Phase 1f with no capital,
   log hypothetical fills/P&L for a few weeks.
9. Phase 3: small live capital — needs CLOB signer key + API creds,
   deliberately not automated yet.
10. Phase 4: scale & risk controls — position sizing, per-category exposure
    caps, kill switches.

## Setup

```
npm install
cp .env.example .env
npm run track-wallets   # poll tracked wallets -> data/*.jsonl
npm run scan-ladders    # scan current BTC/WTI ladders for harvest-zone rungs
```
