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

## Roadmap

1. ~~Phase 0: data pipeline~~ — `walletTracker.ts`, `ladderScanner.ts`.
2. ~~Phase 1a: backtest ladder-harvesting~~ — `backtestLadder.ts`.
   **Result: negative edge, track killed pending new evidence.**
3. ~~Phase 1b: backtest copying each tracked wallet's real trades~~ —
   `walletBacktest.ts`, expanded `wallets.ts` with 8 all-time-leaderboard
   traders. **Result: Djdjdjekekek (+10.2%, n=37 markets) and RN1 (+20.0%,
   n=59 markets) are the strongest trustworthy leads. 6 newly-added wallets'
   near-100% win rates are a look-ahead sample-concentration artifact, not
   validated edge — see findings above before trusting them.**
4. Phase 1c (current, not started): pull deeper history (extend
   `getActivityDeep` past 4 pages) for Theo4/Fredi9999/fishalive/mintblade/
   GRIMDRIP/RepTrump before their numbers mean anything; separately,
   properly backtest the politics category (Theo4/Fredi9999/RepTrump) once
   that's done. Refine `walletStats.ts`'s category classifier further (still
   has an "other" bucket per wallet worth auditing).
5. Phase 2: paper trade the trustworthy leads (Djdjdjekekek-style
   whale-conviction copying, RN1's asymmetric-payoff pattern) with no
   capital, log hypothetical fills/P&L for a few weeks.
6. Phase 3: small live capital — needs CLOB signer key + API creds,
   deliberately not automated yet.
7. Phase 4: scale & risk controls — position sizing, per-category exposure
   caps, kill switches.

## Setup

```
npm install
cp .env.example .env
npm run track-wallets   # poll tracked wallets -> data/*.jsonl
npm run scan-ladders    # scan current BTC/WTI ladders for harvest-zone rungs
```
