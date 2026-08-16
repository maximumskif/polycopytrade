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
  stakeUsdc: number;
  delaySeconds: number;
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
    address: "0x1b20a00709dfe648afd26b326394b5e031f83ab0",
    label: "unnamed monthly #15 (sports-systematic)",
    categoryFilter: "sports",
    excludeTitleKeywords: ["UFC"],
    stakeUsdc: 100,
    delaySeconds: 30,
  },
];
