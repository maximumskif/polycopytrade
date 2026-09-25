// Wallets currently being paper-traded, and the exact strategy rule applied
// to each. Mirrors wallets.ts's TRACKED_WALLETS pattern deliberately — a
// paper-traded wallet must already be in TRACKED_WALLETS (so the tracking
// daemon actually pulls its fills), this just adds the follow-strategy on
// top of that.

export interface PaperTradeTarget {
  address: string;
  label: string;
  // categorize()'s output this wallet's fills must match to be copied —
  // undefined copies every BUY fill regardless of category. See
  // src/categorize.ts.
  categoryFilter?: string;
  // Case-insensitive substrings that disqualify a fill's title from being
  // copied, even if categoryFilter matches — for a real, sampled pattern
  // within one category that's worth excluding specifically (not a
  // guessed rule; see the wallet-breakdown analysis this config's comment
  // cites before adding one).
  excludeTitleKeywords?: string[];
  // Only copy a fill if the LEADER staked at least this much on it — a
  // real, sampled signal (see the 2026-08-17 stake-bucket analysis this
  // config's comment cites below), not a guessed threshold: bigger leader
  // stakes correlate with this wallet's own higher win rate, monotonically
  // across every bucket checked.
  minLeaderStakeUsdc?: number;
  stakeUsdc: number;
  delaySeconds: number;
  // Only copy leader fills at or after this unix time. Added 2026-09-25
  // (item 64): the daemon's first poll of a newly tracked wallet stores its
  // last ~200 HISTORICAL fills, which the engine would otherwise "copy"
  // with already-known outcomes -- look-ahead that would contaminate a
  // forward test. Unset = copy everything (the original target, whose
  // history predates this field).
  activeFrom?: number;
}

export const PAPER_TRADE_TARGETS: PaperTradeTarget[] = [
  {
    // "unnamed monthly #15" in wallets.ts — confirmed on full history
    // 2026-08-14 (docs/AUDIT.md): 53.1% win rate, +35.7% ROI, no
    // disqualifying flags. The sports filter was originally set because
    // "sports" looked like it outperformed a weaker "other" bucket; a
    // 2026-08-15 categorize.ts bug fix (see docs/AUDIT.md) found that
    // split was mostly a mis-categorization artifact -- this wallet is
    // essentially a pure baseball/UFC bettor (2273/2274 trials are
    // "sports" post-fix), so the category filter alone is now close to a
    // no-op. Left in place (harmless, still correct) but no longer doing
    // the real selective work.
    //
    // 2026-08-16: a finer wallet-breakdown by sport found UFC is a clear,
    // reasonably-sampled LOSER for this wallet (196 fills / 4 real
    // markets, 46.4% win, -59.9% net) dragging down an otherwise strong
    // MLB-driven edge (2009 fills / 57 markets, 54.1% win, +49.6% net) --
    // excluded here. (A second finding, not yet acted on: within MLB
    // over/under markets specifically, "Over" bets hit 96.7% win across 12
    // markets vs "Under"'s 34.2% -- promising, but 12 markets is still a
    // thin sample for a hard exclusion rule; watch, don't filter on it
    // yet.)
    // 2026-08-17: leader-stake-informed threshold added. On the
    // UFC-excluded sports sample (2077 fills / 67 real events), win rate
    // and ROI rise monotonically with the leader's own stake size at
    // every bucket checked ($0-1K: 53.7%/50.1% ROI -> $20K+: 71.4%/66.6%
    // ROI). $5,000 was picked as the threshold: meaningfully better point
    // estimate (63.0% win / 55.6% ROI) while keeping 37 real independent
    // events (comfortably above the project's MIN_SAMPLE_SIZE=20) --
    // higher thresholds ($10K/$20K) look even better but the event count
    // drops to 25/16, the latter below the reliable-sample floor. Existing
    // paper orders copied before this change (under the old no-threshold
    // rule) are left as-is, not retroactively removed -- this only changes
    // which NEW fills get copied going forward.
    address: "0x1b20a00709dfe648afd26b326394b5e031f83ab0",
    label: "unnamed monthly #15 (sports-systematic)",
    categoryFilter: "sports",
    excludeTitleKeywords: ["UFC"],
    minLeaderStakeUsdc: 5000,
    stakeUsdc: 100,
    delaySeconds: 30,
  },
  {
    // lamyk -- early-movers channel (IMPROVEMENT_PLAN.md item 64). Confirmed
    // 70/100 clean on an anchored pull from 2026-06-24: 70 events, ROI
    // +40.2%, event-clustered 95% CI [15.1%, 66.2%], max drawdown 2.1%,
    // median gap between trades ~21 min; follower slippage ~0 at +30s. That
    // window overlaps the one it was SELECTED on (early winning buys), so the
    // number is in-sample; this target is the forward, out-of-sample test,
    // pre-registered in item 64 before any paper result existed. No filters:
    // copy every BUY from activeFrom on.
    address: "0xc004b035b67be284e0d1db56c39e865df6cac095",
    label: "lamyk (early-mover, forward test)",
    stakeUsdc: 100,
    delaySeconds: 30,
    activeFrom: 1790325448,
  },
  {
    // gkeqd -- early movers (item 63). 65 events, ROI +7.9%, CI [-0.9%,
    // 20.9%], max drawdown 1.2%, median gap 51s. Forward test under item
    // 64's rule, registered in item 66.
    address: "0xdf17f4a8dd01a4cfa6fc3da323a2baee5f8697d1",
    label: "gkeqd (early-mover, forward test)",
    stakeUsdc: 100,
    delaySeconds: 30,
    activeFrom: 1790326510,
  },
  {
    // BiDiFakePolls -- early movers (item 64). 115 events, ROI +12.3%, CI
    // [-1.5%, 23.5%], max drawdown 2.9%, median gap 132s. Forward test
    // under item 64's rule, registered in item 66.
    address: "0xd24b95551eb288ff82bb625dcd7f32f62abdef76",
    label: "BiDiFakePolls (early-mover, forward test)",
    stakeUsdc: 100,
    delaySeconds: 30,
    activeFrom: 1790326510,
  },
];
