// Wallets we're studying, grouped by strategy archetype (see README "Trader
// archetypes"). Archetypes below are PROVISIONAL — assigned from public X
// posts / the Polymarket monthly profit leaderboard, before we'd looked at
// any real trade history. Phase 1 backtesting against actual /activity data
// is what confirms or corrects them (e.g. "whale-conviction" already looks
// too narrow for Djdjdjekekek, who also trades LoL esports markets).
//
// IMPORTANT: a Polymarket profile URL slug like
// "@0x898ca742...da39-1782562025853" is NOT the wallet to query — that's a
// display identifier. The real address (`proxyWallet`, the one that actually
// holds funds/positions) has to be resolved via
// gamma-api.polymarket.com/public-search?q=<slug-or-username>&search_profiles=true.
// See resolveProxyWallet() in polymarketClient.ts.

export interface TrackedWallet {
  address: string;
  label: string;
  archetype:
    | "ladder-harvester" // mechanical, sells the "boring" side of price-ladder markets
    | "whale-conviction" // few, very large, high-conviction bets
    | "sniper" // very few trades, very high profit/volume ratio
    | "sports-scalper" // high-frequency micro-edge across many games
    | "sports-systematic"; // moderate-frequency, consistent small edges in one sport
  source: string;
}

export const TRACKED_WALLETS: TrackedWallet[] = [
  {
    address: "0x72a0d79b4325638bc2bcfc9a2b8a380c2d81c059",
    label: "0x_exit's featured wallet",
    archetype: "ladder-harvester",
    source: "https://x.com/0x_exit/status/2086940839834444084",
  },
  {
    address: "0xe30e74595517de48f1fb19f4553dd3d9f1e96b87",
    label: "0xE30E7... (leaderboard #3)",
    archetype: "sniper",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x16bb9951a36fce71e2ef57890b786145e0ba8492",
    label: "SDTrading (leaderboard #8)",
    archetype: "sports-systematic",
    source: "https://polymarket.com/@sdtrading",
  },
  {
    address: "0x6d20c35f65d9899b6d6b74f8466e824580f9a165",
    label: "Djdjdjekekek (leaderboard #1)",
    archetype: "whale-conviction",
    source: "https://polymarket.com/@djdjdjekekek",
  },
  {
    address: "0x204f72f35326db932158cba6adff0b9a1da95e14",
    label: "swisstony (leaderboard #2)",
    archetype: "sports-scalper",
    source: "https://polymarket.com/@swisstony",
  },
];
