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
    // disqualifying flags, edge concentrated in sports (55.4% win/$668K
    // net) vs a much weaker "other" bucket (51.9% win) — hence the sports
    // category filter here, not a blanket copy of every fill.
    address: "0x1b20a00709dfe648afd26b326394b5e031f83ab0",
    label: "unnamed monthly #15 (sports-systematic)",
    categoryFilter: "sports",
    stakeUsdc: 100,
    delaySeconds: 30,
  },
];
