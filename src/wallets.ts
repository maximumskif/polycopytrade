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
    | "one-shot-bet" // entire visible trading history is one concentrated event/window — high win rate is not repeatable skill, see Phase 1c in README
    | "unclassified"; // added but not yet run through walletStats/walletBacktest — don't trust a guessed label, see lesson in README
  source: string;
  // Pages of /activity (500 fills each, offset-capped by the API at 5000 =
  // 10 pages) to pull before backtesting. Default 4 (~2000 fills) is enough
  // for most wallets; the 6 all-time-leaderboard wallets below need the full
  // 10 because their near-100% win rate at 4 pages was a look-ahead artifact
  // — see README Phase 1c.
  historyPages?: number;
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
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0x1f2dd6d473f3e824cd2f8a89d9c69fb96f6ad0cf",
    label: "Fredi9999 (all-time #3, +$16.62M/$76.62M vol, 22% profit/volume)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0xed64a7bf029040aa331abc87902434d815ef217d",
    label: "fishalive (all-time #7, +$9.06M/$13.28M vol, 68% profit/volume — highest efficiency in top 20)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0x96cfcb0c30942cfcd1cdf76c7d408794d66b1acb",
    label: "mintblade (all-time #6, +$9.24M/$17.76M vol, 52% profit/volume)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0x3f87d51f27ba6e19ec52aaeebb68559a839c742c",
    label: "GRIMDRIP (all-time #13, +$7.60M/$13.60M vol, 56% profit/volume)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0x863134d00841b2e200492805a01e1e2f5defaa53",
    label: "RepTrump (all-time #14, +$7.53M/$13.98M vol, 54% profit/volume — name suggests politics focus)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
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

  // Added 2026-08-12: ranks 8-20 of the all-time profit leaderboard not
  // already covered above (ranks 1-7 and 14-15 were already tracked).
  // Backtested under Phase 1d (getActivityFromStart, reproducible) the same
  // day they were added — archetypes below reflect that, see README Phase
  // 1d for the numbers. Most of these confirmed the same one-shot-bet
  // pattern as the original 6: tiny distinct-market counts (1-9), several
  // concentrated in the same Oct-2024 US election window.
  {
    address: "0xbc11a64ab34a03a043fbe80598fa065ee87eeec6",
    label: "frostrizz (all-time #8, +$8.93M)",
    archetype: "one-shot-bet", // 6 distinct markets, 26-day total lifetime
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x78b9ac44a6d7d7a076c14e0ad518b301b63c6b76",
    label: "Len9311238 (all-time #9, +$8.71M)",
    archetype: "one-shot-bet", // 7 markets, 93% politics fills, Oct 2024 election window
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x664ce9fb97ae1bbd538d7381b2f4e92dab16f49c",
    label: "sparklingwater123 (all-time #10, +$8.47M)",
    archetype: "one-shot-bet", // 4 distinct markets, full history in <1 day
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x09b428f7c2b469786286214aa5c90dd9015f7320",
    label: "DEEDDIT (all-time #11, +$8.05M — Phase 1d: 84.6% win but NET NEGATIVE -15.4%, 11 markets, ruled out)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x2c335066fe58fe9237c3d3dc7b275c2a034a0563",
    label: "unnamed #12 (all-time #12, +$7.94M — Phase 1d: 60% win, 670 markets (largest sample of any wallet), roughly breakeven -1.6% net, not concentrated but not clearly profitable either)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0xd235973291b2b75ff4070e9c0b01728c520b0f29",
    label: "zxgngl (all-time #13, +$7.81M)",
    archetype: "one-shot-bet", // 2 distinct markets, 99.9% of fills in ONE market
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x5e4c3b5b81171e2ca4ab776ac0d6bba787f9dba2",
    label: "endlessFate (all-time #16, +$7.41M)",
    archetype: "one-shot-bet", // 9 markets, 27-day total lifetime
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0xf0318c32136c2db7fec88b84869aee6a1106c80c",
    label: "BreakTheBank (all-time #17, +$6.72M — Phase 1d: 73 markets but only 30.9% win rate, net -9.2%, ruled out)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x8119010a6e589062aa03583bb3f39ca632d9f887",
    label: "PrincessCaro (all-time #18, +$6.08M)",
    archetype: "one-shot-bet", // 19 markets but 79% politics fills, Oct 2024 election window
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0xe9ad918c7678cd38b12603a762e638a5d1ee7091",
    label: "walletmobile (all-time #19, +$5.94M)",
    archetype: "one-shot-bet", // literally 1 distinct market, 100% of fills
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x94f199fb7789f1aef7fff6b758d6b375100f4c7a",
    label: "KeyTransporter (all-time #20, +$5.71M — Phase 1d: 67.3% win, 15 markets, +45.7% net, reached full 24-day lifetime — borderline, small but not extreme sample)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
];
