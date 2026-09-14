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
- **Researched 2026-09-13 — resolved, doc-sourced only (not yet confirmed
  by a live connection from this project).** Polymarket's CLOB does expose
  a public WebSocket market-data channel:
  `wss://ws-subscriptions-clob.polymarket.com/ws/market`. Confirmed against
  `docs.polymarket.com`'s own API reference
  (`/api-reference/wss/market` and `/market-data/websocket/market-channel`)
  and cross-checked against third-party write-ups describing the same
  `py-clob-client` behavior — consistent across sources, but this project
  has not yet opened a real connection to it, so treat the shape below the
  way `src/markets/solana/client.ts` treats its doc-sourced-only endpoints:
  believed correct, not verified live.
  - **No auth required** for this channel — same "public read" shape as
    the REST `/book` endpoint this project already polls unauthenticated.
  - **Subscribe** by sending `{"assets_ids": ["<clobTokenId>", ...], "type": "market"}`
    (one connection can watch multiple tokens at once — relevant since §2
    above notes several BTC/ETH Up-or-Down markets run concurrently).
  - **Initial snapshot included**: with the default `initial_dump: true`,
    the server pushes a full `book` event (bids/asks/hash/timestamp) on
    subscribe, then incremental `price_change` (per-price-level deltas),
    `last_trade_price`, and `tick_size_change` events as they happen — no
    need to separately REST-poll `/book` once to seed state.
  - **Heartbeat**: client must send a `PING` text frame every 10 seconds or
    the server drops the connection; server replies `PONG`.
  - **Still no historical/replay capability** on this channel — same as
    the REST side (§1 above): it is real-time-only, so the "collect now,
    backtest later" approach in §4 is unchanged regardless of transport.
  - **Rate/connection limits**: not documented anywhere found; unknown
    until tested live.
  - **Recommendation**: this materially answers the §2 cadence problem —
    a single persistent WS connection subscribed to both assets' token IDs
    replaces the 5-second REST poll loop entirely, with lower latency and
    no rate-limit budget to size (no more per-request `RateLimiter` calls
    for this collector at all). **Worth migrating
    `src/depthShift/snapshotCollector.ts` from REST polling to this WS
    channel** as a follow-up — but that's a real code change (new
    dependency or hand-rolled WS client, reconnect/backoff handling, PING
    keepalive, schema validation for the new event shapes) and should get
    its own explicit go-ahead rather than riding in on this research pass,
    per this doc's own scope discipline. The currently-running REST
    collector is not broken and keeps accumulating data in the meantime;
    this is an improvement to make later, not a blocker to fix now.

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
