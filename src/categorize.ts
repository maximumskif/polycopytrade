// Coarse keyword categorizer for market titles. Shared by walletStats.ts
// (behavior breakdown) and walletBacktest.ts (politics-only backtest slice).
// "other" is a real bucket, not a bug — audit it against real titles before
// adding keywords rather than guessing.
export function categorize(title: string): string {
  const t = title.toLowerCase();
  if (["bitcoin", "wti", "ethereum", "crude oil", " btc", " eth"].some((k) => t.includes(k))) return "crypto/commodity";
  if (["temperature"].some((k) => t.includes(k))) return "weather";
  if (["president", "election", "senate", "governor", "congress", "parliament", "prime minister"].some((k) => t.includes(k)))
    return "politics";
  if (
    [" vs ", "vs.", "spread:", "o/u", "moneyline", "exact score", "inning", "win on 20", "advance to", "clinch"].some((k) =>
      t.includes(k)
    )
  )
    // "win on 20" catches "Will <team> win on 2026-06-15?" (World Cup-style
    // match markets). "vs." (not just " vs ") added 2026-08-15 — found by
    // auditing 0x1b20a0...'s "other" bucket: real MLB/UFC moneyline titles
    // are phrased "Team A vs. Team B" (period, no trailing space before
    // it), which " vs " alone never matched, silently misfiling most of
    // this wallet's non-O/U baseball bets as "other" instead of "sports" —
    // including in the LIVE paper-trading category filter
    // (src/paperTrading/engine.ts), not just backtest reporting.
    return "sports";
  return "other";
}
