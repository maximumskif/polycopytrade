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
// See resolveProxyWallet() in src/api/client.ts.

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
    // Phase 1e: Phase 1d's 10-page (5000-fill) pull only reached this
    // wallet's first ~12 days of history and still showed a 62.1%
    // win/+33.8% net edge, the best in the whole project. Raised past 10 to
    // see if that holds over more history before treating it as confirmed.
    historyPages: 40,
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

  // Added 2026-08-14: after all 24 above were ruled out or dormant (Phase
  // 2 wallet-scoring, see docs/AUDIT.md), pivoted from the ALL-TIME
  // leaderboard (dominated by one-shot 2024-election bettors sitting
  // dormant for a year+) to the MONTHLY leaderboard instead, on the theory
  // that "profitable in the last 30 days" is a much better filter for
  // CURRENTLY-active traders than "profitable ever." Ranks 1,2,3,8,10 were
  // already tracked (unnamed #12, 0xE30E7, swisstony, SDTrading, RN1) —
  // only new ranks 4-20 added below. All scored the same day against the
  // project's target hit rate (user-specified: 53-55% win rate, not just
  // ">50%") — see each label for the result. Numbers below are from the
  // default 10-page (5000-fill) shallow pull; per this project's
  // established "early-slice bias" lesson (0x_exit, README Phase 1e), none
  // of these are confirmed until re-checked on deeper history.
  {
    address: "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
    label: "ferrariChampions2026 (monthly #4 — scored: 45.9% win, dormant+high-freq, ROI 4.9% — below hit-rate bar, RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x224a89dbe0db0d6124b335edabd15b3f877da3d5",
    label: "wr0ngw4yb3tt0r (monthly #5 — scored: 55.1% win (in target range) but dormant+uncopyable-high-freq, ROI 6.6% — RULED OUT on copyability)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x7ad71d79a3bb90d0a87a06500fa0fe11663842aa",
    label: "theowalcott (monthly #6 — scored: 59.7% win, ACTIVE (7.9d), ROI 5.5% — RULED OUT DEFINITIVELY on copyability: medianGapSeconds=0.0, i.e. near-simultaneous/same-block fills, not a borderline high-freq-threshold call)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x5268527977f700f9bf9b6d5cd843859e4e70135d",
    label: "HomeRunHazard (monthly #7 — scored: 45.5% win, dormant+high-freq, ROI 0.7% — below hit-rate bar, RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x13fa4ce1b8a27dd0b7a72db6205a50ee6ff0954c",
    label: "betterfasterstronger (monthly #9 — scored: insufficient-sample, events=0 (all activity unresolved/non-trade in the default pull window) — INCONCLUSIVE, not a pass or fail)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x5dab5ed9691fab220535891d9c7f5c28eed322e1",
    label: "Weaseloftheweek (monthly #11 — scored: 61.4% win, ACTIVE (1.0d), ROI 9.6%, $535K net — RULED OUT on copyability: medianGapSeconds=1.0, bot-speed execution no realistic follower latency can match, not a borderline call)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e",
    label: "Lakersfan111 (monthly #12 — scored: 48.8% win, dormant, ROI 21% — below hit-rate bar despite large 339-event sample, RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0xcd30f4698c6f5f3829893e68e183a8e5ea18f316",
    label: "111111111115 (monthly #13 — scored: 38.9% win, dormant+high-freq, ROI -36.3% — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x79ae097215202b5d01f98e4479fb219102469a4a",
    label: "CORGI8 (monthly #14 — scored: 44.1% win, no flags, ACTIVE (0.7d), 312 events, ROI 8.4% — clean/active/large sample but win rate below hit-rate bar, RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x1b20a00709dfe648afd26b326394b5e031f83ab0",
    label: "unnamed monthly #15 (+$335,860 — CONFIRMED on deeper history, 2026-08-14: historyPages=20 returned IDENTICAL numbers to the shallow pull — 53.1% win, no flags, 51 events, +35.7% ROI, $881K net — this wallet's entire ~14-day lifetime already fit under the old 5000-fill cap, so unlike 0x_exit this is NOT an early-slice artifact. No decay across its two active weeks (wk0 52.1% win/31.6% ROI -> wk1 68.3% win/81.7% ROI, improving not fading). Edge is concentrated in SPORTS (55.4% win/$668K net/790 trials) vs a much weaker 'other' category (51.9% win/$213K net/1483 trials) — treat as a sports-specific signal. Caveat: bootstrap 95% ROI CI is wide, -11.1% to +76.9%, still can't rule out a negative true edge; wallet joined Polymarket July 2026 so this IS its full track record, not a slice of a longer one. BEST CANDIDATE IN THE PROJECT — first Phase 3 paper-trading candidate, pending a go/no-go decision.)",
    archetype: "sports-systematic",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
    historyPages: 20,
  },
  {
    address: "0x4bff30af91642dc7d2b19a8664378fe55c45fc26",
    label: "Sassy-Bucket (monthly #16 — scored: 26.5% win, dormant+high-freq, ROI -36.9% — RULED OUT, badly negative)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x43372356634781eea88d61bbdd7824cdce958882",
    label: "Anjun (monthly #17 — scored: 59.1% win but dormant 1044 DAYS (~2.9yr) — ancient/irrelevant, RULED OUT despite win rate)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0xe40aaa5ce1dac0b7dc24c9d0284f27e17c3fe4a2",
    label: "Mysaria (monthly #18 — scored: 85.4% win but ROI ~0.0% ($-10 net) — extreme win rate is a near-certain-odds tiny-edge grinding pattern, not real profit; also uncopyable-high-freq. RULED OUT on economics despite the win-rate number)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x03805a13a0b3e058f55f6c6af95389d4f431073d",
    label: "donthackme (monthly #19 — scored: 85.3% win but ROI 0.3% ($426 net) — same near-zero-profit-despite-high-win-rate pattern as Mysaria; also dormant+high-freq. RULED OUT on economics)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0xbca08c1bc204a34f2fddbe47b438b9bd42ac9705",
    label: "1winstreak1 (monthly #20 — scored: 59.2% win but dormant 93.7 days, ROI 19.3%, $181K net, 222 events — win rate clears bar but stopped trading 3+ months ago, RULED OUT on dormancy)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },

  // Added 2026-08-16: pulled the WEEKLY leaderboard (currently-hottest
  // traders, an even shorter/fresher window than monthly) for a third
  // sourcing pass after 0x1b20a0... — 10 of the top 20 were already
  // tracked (unnamed #12, 0xE30E7, Sassy-Bucket, wr0ngw4yb3tt0r,
  // 111111111115, Lakersfan111, ferrariChampions2026, RN1, Mysaria,
  // swisstony — all previously ruled out), only the 10 new ones below.
  // Unscored, archetype unknown.
  {
    address: "0x9319a045cdd0c2180e5eb7ad44374383db9a6410",
    label: "sainttroplay (weekly #2 — scored: 100% win but one-shot/highly-concentrated/high-freq, 1 event — RULED OUT, pure noise)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x983eedfbd75803602e4a6e6ea9aab6dc6b9c6748",
    label: "3edmond.dantes (weekly #7 — scored: 100% win but one-shot/highly-concentrated/insufficient-sample, 1 event — RULED OUT, pure noise)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x3eb095d871501a1d7a3cb086a22d174b52356a68",
    label: "predictionlegend (weekly #11 — scored: 22.4% win, highly-concentrated+high-freq — RULED OUT, well below hit-rate bar)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x4b341d4612437b6e5b5fbcf98e5b675dbacf48a8",
    label: "musholius722 (weekly #12 — scored: 50% win, one-shot/highly-concentrated/insufficient-sample, 2 events — RULED OUT, pure noise)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x2f44fa076c8d2976ac6bea0ddfd9502bad2b93c2",
    label: "TennisLove (weekly #13 — scored: 100% win, NO FLAGS, ACTIVE, ROI 49.5%, but only 4 real events — too thin to trust despite the clean flag set. WATCH, not a candidate yet: re-score once it has more history)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0xee00ba338c59557141789b127927a55f5cc5cea1",
    label: "S-Works (weekly #16 — scored: 43.3% win, dormant 682.7 days (~1.9yr) — RULED OUT, below bar and ancient)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x7bc14171ccb0d3e6bac219ec6a76211826e28db4",
    label: "coali10 (weekly #17 — scored: 36.2% win, dormant+high-freq, 32.7% election share — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0xf23c5bc7b547867eb6532920144562718aa49f81",
    label: "g42gh6524h5h5 (weekly #18 — scored: 60.7% win, ACTIVE (0.0d), but uncopyable-high-freq (medianGapSeconds=1.0, bot-speed) — win rate clears bar, RULED OUT on copyability, same pattern as theowalcott/Weaseloftheweek)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0xa4b7b1814b0da33f2b61be4939976898aa476008",
    label: "midwicket72 (weekly #19 — scored: 47.2% win, dormant+high-freq — RULED OUT, below bar)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8",
    label: "WTSA (weekly #20 — scored: 56.0% win, uncopyable-high-freq (medianGapSeconds=1.0), 17 events — win rate near/above bar but bot-speed execution + thin sample, RULED OUT on copyability)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
];
