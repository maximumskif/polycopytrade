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
    // "sports" post-fix), so the filter is now close to a no-op rather
    // than a meaningful sub-strategy. Left in place since it's still
    // correct (not wrong, just no longer very selective) and removing it
    // wouldn't change what gets copied.
    address: "0x1b20a00709dfe648afd26b326394b5e031f83ab0",
    label: "unnamed monthly #15 (sports-systematic)",
    categoryFilter: "sports",
    stakeUsdc: 100,
    delaySeconds: 30,
  },
];
