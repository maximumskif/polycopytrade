# Live-readiness review

**Status: not started. No CLOB order-placement code exists anywhere in this
repo (confirmed by grep), and none should be written on the strength of this
document alone.** This is the gate `docs/AUDIT.md` §10 and the README
roadmap (Phase 3: "small live capital — needs CLOB signer key + API creds,
deliberately not automated yet") both point at. Per the project's existing
rule: **live execution code gets written only after a separate, explicit
go-ahead**, not as a natural next step once this document exists. Writing
this document is not that go-ahead.

Every finding below traces back to `docs/AUDIT.md` §10, which flagged these
as real risks to resolve *before* live-mode work starts, not after.

## Why this matters more than usual for this project

Every strategy this project has ever tested and cleared (`0x1b20a0...`,
currently the sole paper-trading target) was found through a research
process that has repeatedly been wrong on first read — early-slice bias
(Phase 1d→1e: a wallet's edge dropped from +33.8% to +7.1% once fully
sampled), look-ahead artifacts (Phase 1c: six wallets' 99-100% win rates
turned out to be one lucky bet each), and edges that decayed to negative
within their own discovery window (Phase 1f/1g). **The base rate for "this
looked good" turning out to not hold up is high in this specific project.**
Live-readiness work should assume any strategy that reaches this gate could
still be wrong, and design controls (position limits, kill switch) that stay
useful even if it is — not just plumbing to get capital moving.

## 1. Signer custody

`.env.example` already stubs `CLOB_SIGNER_PRIVATE_KEY` as a commented-out
env var — i.e., **the path of least resistance is a raw private key sitting
in a `.env` file**, read directly by whichever process places orders. That's
a real risk, not a hypothetical one: a `.env`-resident raw key is a common
real-world source of fund loss (accidental `git add`, shell history, a
process list/core dump on a shared or compromised host, an unencrypted
backup, a copy-pasted `.env` sent to the wrong place). This project's own
`.gitignore` already excludes `.env`, which helps with exactly one of those
vectors and none of the others.

Options to evaluate before choosing (not a recommendation — the right choice
depends on how much capital this ever holds and how it's operated):

| Option | What it buys | Cost |
|---|---|---|
| Raw key in `.env` (today's stub) | Zero setup | Every vector above; the whole balance is one file-read away from gone |
| Dedicated low-balance hot wallet, hard on-chain caps | Bounds the blast radius to whatever's funded there, nothing else | Still a raw key somewhere; needs discipline to never over-fund it |
| Hardware/HSM-backed signer | Private key never touches this process's memory/disk at all | Real setup cost, and needs to support whatever signing scheme Polymarket's CLOB requires — not yet researched here |
| Broker/relayer API that signs server-side | This process never holds a key at all | Depends on a third party's custody and uptime; introduces a new trust relationship |

**Whichever is chosen, the low-balance hot wallet pattern is worth doing
regardless of the other three** — even an HSM-backed setup benefits from
capping how much can ever be at risk from a signing bug, not just a leaked
key.

Before deciding: research whether Polymarket's CLOB API's signing
requirements are compatible with a hardware signer or relayer at all — not
yet investigated in this project, first concrete task if that path is
chosen.

## 2. Kill switch

Nothing in the codebase today can stop an in-flight strategy from placing
more orders — appropriate for a read-only research tool, not for anything
that spends money. Before live mode:

- **A single, fast, unambiguous way to halt new order placement** — a file
  the daemon checks every cycle (`data/HALT` or similar — cheap, no extra
  infra, works even if the process is otherwise wedged) or a DB flag row.
  Checked at the start of every cycle, not just at startup, so it takes
  effect within one poll interval.
- **Halting must not require killing the process.** Killing `track:daemon`
  outright stops paper-trading tracking too, which is a real cost — a live
  kill switch should stop *new order placement* while everything else
  (tracking, health checks, existing-position resolution) keeps running.
- **A clear distinction between "stop opening new positions" and "also exit
  everything open right now."** The first is cheap and safe to trigger
  liberally (e.g. the moment `paper:report`-equivalent metrics look wrong);
  the second is itself a risky action (forced exits at whatever price is
  available) that deserves its own deliberate switch, not a side effect of
  the first.
- **Who/what can trigger it**: at minimum, a manual command
  (`npm run kill-switch` or equivalent). Automatic triggers (see §3) are a
  further layer, not a replacement for a manual one.

## 3. Position and exposure limits

None exist anywhere in the code today (confirmed by grep, per
`docs/AUDIT.md` §10). Before live mode, at minimum:

- **Per-trade stake cap** — the paper-trading config already has a pattern
  for this (`stakeUsdc` in `src/paperTrading/config.ts`); live mode needs
  the same, enforced in code, not just as a config convention someone could
  forget to set.
- **Total exposure cap** — a ceiling on capital committed to still-open
  positions at any one time, independent of per-trade size (protects against
  a strategy that starts firing unusually often, not just unusually large).
- **Per-category / per-wallet cap** — this project's own research (the
  MLB-vs-UFC split, the sports-vs-other categorization bug) shows a single
  wallet's edge is often concentrated in a narrow slice; a live config
  should be able to bound exposure to one category or one followed wallet
  specifically, not just in aggregate.
- **An automatic trigger for the kill switch** — e.g., N consecutive losses,
  or drawdown past a threshold, halts new positions without waiting for a
  human to notice. What threshold, and whether it should also trigger a
  forced exit of open positions, is a real design decision to make
  deliberately here, not default to a guessed number.
- **Reuse, don't reinvent, the sample-size discipline already built.**
  `src/backtesting/statistics.ts`'s `MIN_SAMPLE_SIZE` /
  `effectiveIndependentSampleCount` exist because this project already
  learned fill/market counts overstate real sample size (§7). A live risk
  engine should refuse to size up a position based on a paper-trading record
  that hasn't cleared the same bar this project already requires for a
  backtest to be trusted.

## 4. Environment separation

Today there is exactly one `.env`, fine while nothing places orders. Before
live mode:

- **Separate config for read-only research, paper trading, and live
  execution** — at minimum, live credentials should not be loadable by
  accident when running a research script (`wallet-backtest`,
  `wallet-score`, etc.) against the same `.env` a live daemon reads.
- **A live daemon should fail loudly, not silently default, if it can't find
  its live-specific config** — the opposite of how `config/env.ts` currently
  treats most settings (sensible defaults everywhere), which is the right
  choice for a research tool and the wrong one for anything that can spend
  money.

## 5. Gate: what must be true before any execution code is written

All of the following, not a subset:

1. A specific strategy has cleared this project's own bar (currently:
   `0x1b20a0...` is the only wallet that ever has, and Track E of
   `docs/IMPROVEMENT_PLAN.md` still needs real forward paper-trading
   evidence to accumulate before that's confirmed rather than provisional).
2. §1-4 above have actual decisions made (not just this document existing) —
   a chosen custody approach, a working kill switch, concrete position/
   exposure limits, and real environment separation.
3. Explicit, separate sign-off from the user to start writing execution
   code — this document existing is scoping, not that sign-off.
