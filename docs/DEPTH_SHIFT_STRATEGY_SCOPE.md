# Scoping: an original order-book depth-shift strategy

Source: X post by @sopersone (2026-08-17), profiling wallet
`0xce25e214d5cfe4f459cf67f08df581885aae7fdc` — claimed $313 -> $565,115
trading Bitcoin/ETH "Up or Down" 15-minute markets, 87,559 trades. The
post's claimed edge: not predicting direction, but watching real
order-book liquidity vanish a few seconds before price moves, and trading
into that shift.

We ruled this specific wallet out for copy-trading (`wallets.ts` —
confirmed bot-speed execution, `medianGapSeconds=0.0`, win rate below the
project's 53-55% bar on the sampled slice). This document scopes a
*different* question the user raised: could we build our own version of
this kind of strategy, from scratch, rather than copy this wallet?

**This is a scoping document only — no strategy code should be written
from it without a separate, explicit go-ahead**, per this project's
existing rule that supported-strategy decisions need sign-off (same gate
`docs/AUDIT.md` §10 and the not-yet-written `LIVE_READINESS.md` apply to
copy-trading execution).

## 1. What data actually exists (verified live, 2026-08-17)

- **Live order-book depth is real and available**: `clob.polymarket.com/book?token_id=<clobTokenId>`
  returns the current full bid/ask ladder (price + size at every level) for
  a given outcome token, as of the request. This is the raw signal the
  strategy needs — confirmed against a real live BTC Up-or-Down market.
- **No historical order-book endpoint exists.** `prices-history` (the only
  historical CLOB data this project has ever used) returns *trade price*
  ticks, not book depth, and even at `fidelity=1` the real ticks returned
  are roughly one per minute, not sub-second (confirmed: consecutive ticks
  60s apart on a live 15-minute market). There is no way to ask "what did
  the order book look like 3 minutes ago" — Polymarket does not expose
  that.
- **This is the structural blocker.** Every other strategy this project
  has built (ladder-harvester, wallet copy-trading, the MLB O/U
  strategy-fork) works by pulling real historical data and backtesting a
  rule against it before ever running it forward. **A depth-shift strategy
  cannot be backtested this way — there is nothing to pull.** The only way
  to get evidence for or against this idea is to start collecting live
  order-book snapshots now and evaluate them going forward, the same
  "paper trade before risking capital" instinct this project already
  follows, just one level earlier: collect the data before there's even a
  strategy to paper-trade.

## 2. What real-time cadence this would need

The claimed edge is reacting to a depth shift "a few seconds" before price
moves, inside a market that only lives 15 minutes. A once-a-minute or
once-a-60-second poll (this project's existing `track:daemon` cadence) is
far too slow to observe this at all, let alone react to it. A real
collector would need:

- Polling every BTC/ETH Up-or-Down market's order book on the order of
  **every 1-5 seconds**, not once a minute — a fundamentally different
  polling profile than anything this project runs today, and one that
  would need its own dedicated rate-limit budget (the existing
  `RateLimiter(1100ms)` used by every other endpoint in `src/api/client.ts`
  is sized for the current once-a-minute wallet-tracking cadence, not
  this).
- Handling several of these markets *concurrently and continuously* —
  BTC/ETH Up-or-Down markets run back-to-back all day (a new 15-minute
  window opens as soon as the last one closes), so this isn't a
  poll-then-stop job like the ladder/O/U scripts, it's a new kind of
  always-on collector.
- **Open question, not yet researched**: whether Polymarket's CLOB exposes
  a WebSocket feed for order-book updates (would solve the
  polling-cadence problem far better than REST polling ever could, and is
  the standard way real market-making bots watch a book). This project has
  never used or investigated the CLOB WebSocket API — that's the first
  concrete research task before writing any collector code.

## 3. What's still true even if the data problem is solved

- **Live order placement is not built anywhere in this codebase**
  (confirmed by grep, `docs/AUDIT.md` §10) — a depth-shift *strategy* is
  worthless without the ability to actually act on a signal within the
  few-second window the edge depends on. This project's copy-trading track
  has deliberately never needed this (it's designed around a follower
  delay of tens of seconds, not sub-second reaction), so this would be new
  ground entirely, with the same private-key/signer-custody risk already
  flagged in `docs/AUDIT.md` §10 and explicitly called out as needing a
  `LIVE_READINESS.md` review before any of it is real.
- Even with data and execution both solved, this is a fundamentally
  different kind of system from what exists today: a low-latency,
  always-on market-making/scalping bot, not a delayed-copy or
  backtested-rule research tool. It would likely warrant its own
  service/process rather than living inside `track:daemon`.

## 4. Recommended first step, if this gets picked up

**Build a passive order-book snapshot collector only — no strategy logic,
no execution.** Concretely: a new small service that polls (or, if
research finds a WebSocket, subscribes to) the book for whichever BTC/ETH
Up-or-Down market is currently open, at a few-second cadence, and stores
raw bid/ask snapshots to SQLite (a new table, following this project's
existing migration pattern). Purely data collection — the same
`insertActivity`-style idempotent-write pattern already used, adapted to a
new shape. Once a real dataset of snapshots-vs-outcomes exists (even a few
days' worth), *then* there's something to actually backtest a depth-shift
rule against, the same way every other strategy in this project earned
its way from data to a tested rule before anything traded.

**Not recommended yet**: writing any entry/exit rule, any execution code,
or committing to WebSocket-vs-polling before the research task in §2 is
done. This is a bigger, different kind of build than anything else in
this project so far — worth doing deliberately in its own session, not
folded into the existing copy-trading work.

## 5. Status: collector built and running (2026-08-17)

Built `src/depthShift/snapshotCollector.ts` (`npm run depth:collector`) —
exactly the §4 scope, nothing more. Polls the currently-open BTC and ETH
"Up or Down" 15-minute market's "Up" outcome token's order book every 5
seconds and stores raw bid/ask snapshots to a new `orderbook_snapshots`
table (migration `0003_orderbook_snapshots`). The current market for each
asset is found deterministically by slug (`{asset}-updown-15m-{slotStart}`,
`slotStart = floor(now/900)*900` — these markets run on a fixed
back-to-back 15-minute schedule, confirmed live, no search needed), cached
until the slug rolls over so only the order-book call repeats every cycle.
Verified end-to-end against the live API: a 20-second smoke test captured
6 real snapshots (3 cycles × 2 assets) with the best bid/ask genuinely
moving between captures, not a static read.

Running as its own persistent background process (`data/depth-collector.pid`/
`.log`, same pattern as `track:daemon`), separate from wallet tracking
since its poll cadence is ~1000x faster. **This is pure data capture —
no strategy logic exists yet.** The §2 WebSocket research question is
still open; the REST-polling collector is what's actually running today.
Do not build any entry/exit rule against this data until there's a
meaningful accumulated window (at minimum, enough 15-minute cycles across
enough real price moves to see what a depth shift actually looks like) —
there is currently ~0 minutes of history.

## 6. §2 open question answered: yes, a WebSocket order-book feed exists (verified live, 2026-09-10)

**Answer: yes.** Polymarket's CLOB exposes a public, unauthenticated market
WebSocket that streams order-book snapshots and incremental updates. This
was confirmed two ways: reading Polymarket's official docs, and actually
connecting to it from this sandbox and capturing real messages for a live
market (this project's "confirmed by testing" bar per `docs/AUDIT.md`, not
"the docs say so").

**Docs consulted** (all under `docs.polymarket.com`, current as of
2026-09-10): `/developers/CLOB/websocket/wss-overview`,
`/api-reference/wss/market`, `/quickstart/websocket/WSS-Quickstart`.

**Endpoint**: `wss://ws-subscriptions-clob.polymarket.com/ws/market` — a
public "market" channel, separate from the authenticated "user" channel
(order-fill updates for your own orders — not relevant here) and from the
"sports"/RTDS channels (unrelated data). No API key, no wallet signature,
no auth of any kind is required to subscribe to order-book data — same
unauthenticated-public-read posture as every REST endpoint this project
already calls in `src/api/client.ts`.

**Subscription model — per-token, not per-market.** Subscribe by sending
`{"assets_ids": ["<clobTokenId>", ...], "type": "market", "initial_dump":
true, "level": 2}` after connecting. `assets_ids` takes an array, so a
single connection can watch both the "Up" and "Down" tokens of a market
(or multiple markets' tokens) at once — the same `clobTokenIds` this
project already extracts from `GammaMarket.clobTokenIds` in
`snapshotCollector.ts`. Assets can be added/removed later on the same
connection via an `{"operation": "subscribe"/"unsubscribe", ...}` message,
no reconnect needed. Heartbeat is client-driven: send the literal text
frame `"PING"` every 10s, server replies `"PONG"`.

**Message shape — snapshot first, then deltas.** With `initial_dump: true`
(the default), the very first message per subscribed asset is a full `book`
snapshot: `{"event_type":"book","asset_id":...,"market":...,"bids":[...],
"asks":[...],"timestamp":...,"hash":...}` — same shape as today's REST
`GET /book` response, just pushed instead of polled. After that, updates
arrive as `price_change` events — incremental deltas for individual price
levels (`{"event_type":"price_change","price_changes":[{"asset_id",
"price","size","side","best_bid","best_ask","hash"},...],"timestamp"}`),
**not** repeated full-book snapshots. A correct consumer has to apply these
deltas on top of the initial snapshot to maintain a live book (or, more
simply, can just track `best_bid`/`best_ask`, which every `price_change`
message already carries directly — the collector's existing
`bestBid`/`bestAsk` fields need nothing more than that). Other event types
(`last_trade_price`, `tick_size_change`, and — only with
`custom_feature_enabled: true` — `best_bid_ask`, `new_market`,
`market_resolved`) exist but weren't needed for this test.

**Empirical verification.** Wrote a throwaway script (`ws` was unnecessary
— Node 22's native `WebSocket` global handled it) that connected to the
endpoint above and subscribed to the live "Up" token of the currently-open
`btc-updown-15m-1789066800` market (resolved the same deterministic-slug
way `snapshotCollector.ts` already does), then logged everything for 25
seconds. Result: **connection succeeded immediately, first message was a
real `book` snapshot with live bid/ask levels for that exact market, and
659 further messages arrived over the next 25 seconds — all
`price_change` events with genuine, changing prices/sizes/best_bid/
best_ask** (this was near the end of the 15-minute window, so the book was
moving fast toward resolution — a good stress case). `PING`/`PONG`
heartbeat worked as documented. The script and its full captured output
were discarded after verification (kept out of `src/` per this doc's own
scoping rule) — the message shapes above and the 659-messages-in-25s figure
are copied directly from that run, not from the docs.

**Would this replace REST polling outright? Yes.** 659 updates in 25
seconds for one token, delivered push-side with sub-second latency, is
categorically faster and cheaper than any REST poll cadence discussed in
§2 (even a 1-second poll would still average <1 sample per potentially
several price-changing events, and would still cost a request every
cycle against the `RateLimiter(1100ms)` budget). The WebSocket feed:

- **Solves the §2 cadence problem directly** — no polling interval to
  tune, no rate-limit budget to carve out; the server pushes on every
  change instead of the client guessing an interval.
- **Solves the §3 "several concurrent markets" problem more cleanly than
  REST** — one connection, one `assets_ids` array, covers BTC-Up,
  BTC-Down, ETH-Up, ETH-Down (or more) simultaneously; no per-market
  polling loop needed.
- **Changes the collector's job from "poll and snapshot" to "consume a
  stream and persist"** — `snapshotCollector.ts` would need real rework
  (an open socket + delta-application state machine instead of a
  `sleep(5000)` loop calling `getOrderBook`), not just a faster interval.
  That rework is exactly the kind of strategy-adjacent build this scoping
  document still gates: per Track E.15, the open question is now
  answered, but the collector rewrite itself is a separate, deliberate
  next step, not done as part of this research task.

**Confidence: high.** This is not a docs-only claim — a real WebSocket
connection to Polymarket's production endpoint was opened from this
sandbox, subscribed successfully with no credentials, and returned
hundreds of genuine live messages for a real, currently-open BTC
Up-or-Down market within the same 25-second window.
