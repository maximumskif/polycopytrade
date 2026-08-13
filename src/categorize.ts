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
    [" vs ", "spread:", "o/u", "moneyline", "exact score", "inning", "win on 20", "advance to", "clinch"].some((k) =>
      t.includes(k)
    )
  )
    return "sports"; // "win on 20" catches "Will <team> win on 2026-06-15?" (World Cup-style match markets)
  return "other";
}
