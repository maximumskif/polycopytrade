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
    | "sports-systematic" // moderate-frequency, consistent small edges in one sport
    | "unclassified"; // added but not yet run through walletStats/walletBacktest — don't trust a guessed label, see lesson in README
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
    label: "swisstony (monthly #2 / all-time #1)",
    archetype: "sports-scalper",
    source: "https://polymarket.com/@swisstony",
  },

  // Added from the ALL-TIME profit leaderboard (polymarket.com/leaderboard/overall/all/profit)
  // to find durable, high-win-rate strategies rather than a single good month.
  // Addresses came directly from the leaderboard's profile links
  // (polymarket.com/profile/0x...), NOT from fuzzy username search — for
  // Theo4 and Fredi9999 specifically, public-search's closest match was a
  // DIFFERENT, similarly-named account (e.g. "theo43", "RepTrum63" for
  // RepTrump) with no exact hit. Always prefer a direct leaderboard/profile
  // link over guessing from search results when names are this close.
  {
    address: "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
    label: "Theo4 (all-time #2, +$22.05M/$43.07M vol, 51% profit/volume)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x1f2dd6d473f3e824cd2f8a89d9c69fb96f6ad0cf",
    label: "Fredi9999 (all-time #3, +$16.62M/$76.62M vol, 22% profit/volume)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0xed64a7bf029040aa331abc87902434d815ef217d",
    label: "fishalive (all-time #7, +$9.06M/$13.28M vol, 68% profit/volume — highest efficiency in top 20)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x96cfcb0c30942cfcd1cdf76c7d408794d66b1acb",
    label: "mintblade (all-time #6, +$9.24M/$17.76M vol, 52% profit/volume)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x3f87d51f27ba6e19ec52aaeebb68559a839c742c",
    label: "GRIMDRIP (all-time #13, +$7.60M/$13.60M vol, 56% profit/volume)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x863134d00841b2e200492805a01e1e2f5defaa53",
    label: "RepTrump (all-time #14, +$7.53M/$13.98M vol, 54% profit/volume — name suggests politics focus)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee",
    label: "kch123 (all-time #5, +$11.39M/$298.6M vol, 3.8% profit/volume — swisstony-style high volume)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
    label: "RN1 (all-time #4 AND monthly #7 — durable across both windows)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
];
