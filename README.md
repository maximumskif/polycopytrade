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
| `0x72a0...1c059` (0x_exit's wallet) | ladder-harvester | BTC/WTI price-ladder mispricing |
| `0xe30e...96b87` | sniper | 92 trades, $599k profit on $4.85M volume — very high conviction, low frequency |
| `0x16bb...a8492` (SDTrading) | sports-systematic | MLB O/U + moneyline, many small consistent edges |
| `0x6d20...9a165` (Djdjdjekekek) | whale-conviction | #1 monthly profit, but also trades LoL esports — label may be too narrow |
| `0x204f...da95e14` (swisstony) | sports-scalper | 175k+ trades across European football/tennis |

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

## Roadmap

1. ~~Phase 0: data pipeline~~ — `walletTracker.ts` polls tracked wallets'
   positions + activity to `data/*.jsonl`; `ladderScanner.ts` finds current
   BTC/WTI ladder rungs sitting in the 5-45c "harvest zone".
2. Phase 1: classify & backtest — confirm archetypes from real
   `data/activity.jsonl` history (not leaderboard guesses); backtest the
   ladder-harvester mechanic standalone against historical rung
   prices/resolutions to find where the real edge is (0x_exit's actual open
   positions were bought at 27-50c, wider than the "6-30c" the post
   describes — the true zone needs data, not the tweet's word).
3. Phase 2: paper trade — run signal generation live with no capital, log
   hypothetical fills/P&L for a few weeks.
4. Phase 3: small live capital (~$500-1k, ladder-harvester first) — needs
   CLOB signer key + API creds, deliberately not automated yet.
5. Phase 4: scale & risk controls — position sizing, per-category exposure
   caps, kill switches, expand copy-trading to whale/sniper/sports tracks
   once each is backtest-validated.

## Setup

```
npm install
cp .env.example .env
npm run track-wallets   # poll tracked wallets -> data/*.jsonl
npm run scan-ladders    # scan current BTC/WTI ladders for harvest-zone rungs
```
